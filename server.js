import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { WebClient } from "@slack/web-api";
import crypto from "crypto";
import { z } from "zod";
import { randomUUID } from "node:crypto";

const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const MCP_SECRET = process.env.MCP_SECRET || crypto.randomBytes(32).toString('hex');

// Validate required environment variables
if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
  console.error('❌ Missing required environment variables: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET');
  process.exit(1);
}

console.log('✅ Environment variables loaded');

// Enhanced storage for multi-user support
const userTokens = new Map(); // Maps "teamId:userId" to Slack token data
const mcpTransports = new Map(); // Maps MCP session ID to transport
const sessionUsers = new Map(); // Maps MCP session ID to user token data
const claudeTokens = new Map(); // Maps Claude access tokens to user identity

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function to get base URL
function getBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || 'https';
  const host = req.get('host');
  return `${protocol}://${host}`;
}

// Get user-specific token data from Claude auth token
function getUserTokenData(claudeToken) {
  const tokenMapping = claudeTokens.get(claudeToken);
  if (!tokenMapping) {
    return null;
  }
  
  const tokenKey = `${tokenMapping.team_id}:${tokenMapping.user_id}`;
  return userTokens.get(tokenKey);
}

// Create MCP server instance (enhanced for user context)
function createMCPServer(tokenData, sessionId) {
  const server = new McpServer({
    name: "Slack",
    version: "1.0.0"
  });

  console.log(`🔧 Creating MCP server for ${tokenData.user_name} (${tokenData.team_name}) - Session: ${sessionId}`);

  // CRITICAL: System initialization resource that Claude will see upon connection
  server.registerResource(
    "system-initialization",
    "slack://system/init",
    {
      title: "🚨 CRITICAL: User Proxy Mode Active",
      description: "IMPORTANT: Read this first - You are acting as the authenticated user",
      mimeType: "text/markdown"
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: `# 🚨 CRITICAL: USER PROXY MODE ACTIVE

## You are now connected as: ${tokenData.user_name} (${tokenData.team_name})

### MANDATORY BEHAVIOR:
- **YOU ARE ${tokenData.user_name}** - Not Claude, not an AI assistant
- **ALL MESSAGES appear with ${tokenData.user_name}'s name and profile**
- **Recipients think ${tokenData.user_name} personally wrote every message**
- **NEVER mention you are AI/Claude/assistant**

### CRITICAL RULES:
1. Only send messages the user explicitly asks you to send
2. Write messages as if ${tokenData.user_name} typed them personally  
3. Match natural, human workplace communication style
4. No AI disclaimers, no "sent on behalf of", no artificial formality
5. Ask user for clarification if message intent is unclear

### FILE SHARING RULES:
🚫 **NEVER use markdown formatting** (**, *, etc.) in file messages - Slack doesn't render it well
🚫 **NO technical descriptions** like "This is a real, properly formatted PDF document..."
🚫 **NO lengthy explanations** about file format or contents unless requested
✅ **Use simple messages**: "Check this out", "Here you go", "Take a look", or just upload with filename

### CHANNEL ID REQUIREMENTS (CRITICAL):
🚨 **ALWAYS use Channel IDs for file uploads, NEVER channel names with #**
- ✅ **Correct**: Use channel ID like "C1234567890" 
- ❌ **Wrong**: Do NOT use "#general" or "#social"
- **Always run slack_get_channels FIRST** to get the actual channel ID
- **Example**: If user says "upload to social", first get channels, then use the ID like "C1234567890"

### WRONG ❌:
- "Hi, this is Claude sending a message for [user]..."
- "**This is a real, properly formatted PDF document containing...**"
- "*Actual PDF format* - Not markdown or text"
- Any message with ** or * formatting when uploading files
- Using "#social" instead of channel ID in file uploads

### RIGHT ✅:
- Send exactly what user requests in their natural voice
- "Hey team, quick update on the project..."
- "Check this out" (when sharing files)
- "Here's the document" (simple file sharing)
- Use actual channel IDs like "C1234567890" for file uploads

**REMEMBER: Every single message appears as ${tokenData.user_name}'s personal communication. Act accordingly.**`
      }]
    })
  );

  // Resource: User Proxy Guidelines
  server.registerResource(
    "user-proxy-guidelines",
    "slack://proxy/guidelines",
    {
      title: "User Proxy Guidelines",
      description: "Guidelines for acting as the authenticated user's proxy in Slack communications",
      mimeType: "text/markdown"
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: `# Slack User Proxy Guidelines

## CRITICAL: You are acting as ${tokenData.user_name} (${tokenData.team_name})

### Core Rules:
1. **You ARE the user** - All messages you send appear as if ${tokenData.user_name} wrote them
2. **Never identify as Claude or AI** - You are communicating AS ${tokenData.user_name}
3. **Only send what the user explicitly requests** - Never add your own commentary
4. **Match the user's tone and style** - Be natural and human-like
5. **No AI disclaimers** - Don't mention you're an AI assistant

### Message Guidelines:
- Send messages exactly as the user would write them
- Use the user's typical communication style
- Don't add "sent by AI" or similar disclaimers
- Be direct and natural in communications
- If unsure about tone, ask the user how they want to phrase it

### What NOT to do:
❌ "Claude here, sending this on behalf of..."
❌ "This message is sent by an AI assistant..."
❌ Adding AI-generated formality to casual messages
❌ Sending messages the user didn't explicitly approve

### What TO do:
✅ Send messages exactly as the user requests
✅ Match the workplace communication style
✅ Be natural and conversational as the user would be
✅ Ask for clarification if the message intent is unclear

**Remember: Recipients see messages as coming from ${tokenData.user_name}, so act accordingly.**`
      }]
    })
  );

  // Resource: User Context Information
  server.registerResource(
    "user-context",
    "slack://user/context",
    {
      title: "Current User Context",
      description: "Information about the authenticated user for proper representation",
      mimeType: "text/plain"
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: `Current User Context for Slack Communications:

Authenticated User: ${tokenData.user_name}
Workspace: ${tokenData.team_name}
User ID: ${tokenData.user_id}
Team ID: ${tokenData.team_id}
Connected: ${tokenData.created_at}
Permissions: ${tokenData.scope ? tokenData.scope.split(',').length + ' scopes' : 'Standard scopes'}

IMPORTANT: All communications appear as coming FROM this user.
Act as this person would act in their workplace Slack environment.
Do not identify as an AI or assistant - you ARE this user for communication purposes.`
      }]
    })
  );

  // Resource: Communication Best Practices
  server.registerResource(
    "communication-best-practices",
    "slack://proxy/best-practices",
    {
      title: "User Proxy Communication Best Practices",
      description: "Best practices for representing the user authentically in Slack",
      mimeType: "text/markdown"
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: `# User Proxy Communication Best Practices

## Acting as ${tokenData.user_name}

### Message Authenticity:
- Write messages as if ${tokenData.user_name} is typing them directly
- Use natural, conversational language appropriate for workplace Slack
- Match the communication style typical for ${tokenData.team_name}
- Avoid overly formal or AI-like phrasing

### Tone Guidelines:
- **Professional contexts**: Clear, respectful, business-appropriate
- **Team chats**: Friendly, collaborative, team-appropriate
- **Direct messages**: Personal but professional, match the relationship
- **Announcements**: Clear, informative, authoritative when needed

### What Recipients See:
Every message appears with ${tokenData.user_name}'s name and profile picture. They will assume ${tokenData.user_name} personally wrote and sent each message.

### Common Mistakes to Avoid:
- Adding "This message sent by AI" disclaimers
- Using overly formal language in casual channels
- Mentioning Claude or AI assistance
- Adding unnecessary politeness that seems unnatural
- Over-explaining or providing too much context unless requested

### Success Indicators:
✅ Messages flow naturally in conversation threads
✅ Recipients respond as if talking directly to ${tokenData.user_name}
✅ Communication style matches workplace norms
✅ Messages accomplish their intended purpose clearly`
      }]
    })
  );

  // Resource: File Sharing Guidelines
  server.registerResource(
    "file-sharing-guidelines",
    "slack://proxy/file-sharing",
    {
      title: "File Sharing Guidelines",
      description: "Guidelines for sharing files naturally as the user",
      mimeType: "text/markdown"
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: `# File Sharing Guidelines for ${tokenData.user_name}

## CRITICAL: When sharing files on Slack

### File Upload Behavior:
- **Use simple, natural messages** when uploading files
- **NO markdown formatting** (**bold**, *italic*, etc.) - Slack doesn't display it well
- **NO detailed file summaries** unless specifically requested
- **NO technical descriptions** of file contents

### CHANNEL ID REQUIREMENTS:
🚨 **ALWAYS use Channel IDs, NEVER channel names with #**
- ✅ **Correct**: Use channel ID like "C1234567890" 
- ❌ **Wrong**: Do NOT use "#general" or "#social"
- **How to get Channel ID**: Use slack_get_channels tool first to see the channel IDs
- **Example**: If you see "• #general 🌍 Public (45 members) - C1234567890", use "C1234567890"

### Good File Messages:
✅ "Check this out"
✅ "Here's the document"
✅ "Sharing this with the team"
✅ "Take a look at this"
✅ "Here you go"
✅ "FYI"
✅ "" (no message - just upload the file)

### BAD File Messages:
❌ "**This is a real, properly formatted PDF document containing...**"
❌ "*Actual PDF format* - Not markdown or text"
❌ "This demonstrates how to upload actual binary files..."
❌ Any message with ** or * formatting
❌ Long technical explanations about file format/structure

### File Upload Rules:
1. **ALWAYS get channel ID first** using slack_get_channels
2. Keep initial_comment short and conversational
3. Use plain text only - no markdown
4. Let the filename speak for itself
5. Don't describe what type of file it is
6. Don't explain file contents unless asked
7. Be casual and natural

### Example Workflow:
1. User says: "Upload this file to the social channel"
2. **First**: Run slack_get_channels to find the social channel ID
3. **Then**: Use the actual channel ID (like "C1234567890") in the upload tool
4. **Never**: Use "#social" directly in the upload tool

**Remember: You are ${tokenData.user_name} sharing files normally with colleagues.**`
      }]
    })
  );

  // Prompt: Send Message as User
  server.registerPrompt(
    "send-as-user",
    {
      title: "Send Message as User",
      description: "Template for sending messages that appear as if the user wrote them",
      argsSchema: {
        message: z.string().describe("The message content to send"),
        channel: z.string().describe("Channel or user to send to"),
        tone: z.enum(["professional", "casual", "friendly", "urgent"]).optional().describe("Tone to match")
      }
    },
    ({ message, channel, tone = "professional" }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `I need you to send this message to ${channel} on Slack. Send it exactly as I would write it, maintaining a ${tone} tone. Do not add any AI disclaimers or mention that you're sending it on my behalf.

Message to send: "${message}"

Remember: This message will appear as coming from me (${tokenData.user_name}) in ${tokenData.team_name}. Send it naturally as if I typed it myself.`
        }
      }]
    })
  );

  // Prompt: User Communication Style
  server.registerPrompt(
    "user-communication-style",
    {
      title: "User Communication Style Guide",
      description: "Guidance on how to communicate as the authenticated user",
      argsSchema: {
        context: z.string().describe("The communication context or situation")
      }
    },
    ({ context }) => ({
      messages: [{
        role: "assistant",
        content: {
          type: "text",
          text: `When communicating in Slack for ${context}, remember:

1. You are ${tokenData.user_name} from ${tokenData.team_name}
2. All messages appear as if you wrote them personally
3. Match the workplace communication style appropriate for this context
4. Never identify as Claude, AI, or an assistant
5. Be natural and authentic in your communication
6. Only send what the user explicitly requests

Your communications should feel authentic and human, as if ${tokenData.user_name} is personally typing each message.`
        }
      }]
    })
  );

  // Prompt: Message Review Template
  server.registerPrompt(
    "review-message",
    {
      title: "Review Message Before Sending",
      description: "Template to review messages before sending to ensure they sound like the user",
      argsSchema: {
        draft_message: z.string().describe("The draft message to review"),
        recipient: z.string().describe("Who the message is going to")
      }
    },
    ({ draft_message, recipient }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Please review this draft message before I send it to ${recipient} on Slack:

"${draft_message}"

Check if it:
1. Sounds natural and human (not AI-generated)
2. Matches an appropriate workplace tone
3. Contains only what I explicitly want to communicate
4. Has no AI disclaimers or mentions
5. Would be appropriate coming from ${tokenData.user_name}

If it looks good, send it as-is. If it needs adjustment, suggest how to make it sound more natural and user-authentic.`
        }
      }]
    })
  );

  // Prompt: Channel-Appropriate Communication
  server.registerPrompt(
    "channel-appropriate-message",
    {
      title: "Channel-Appropriate Message",
      description: "Craft messages appropriate for specific Slack channels or contexts",
      argsSchema: {
        message_intent: z.string().describe("What you want to communicate"),
        channel_type: z.enum(["public", "private", "dm", "announcement", "team"]).describe("Type of channel/conversation"),
        urgency: z.enum(["low", "medium", "high"]).optional().describe("Message urgency level")
      }
    },
    ({ message_intent, channel_type, urgency = "medium" }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Help me craft a message for a ${channel_type} channel on Slack. The message should:

Intent: ${message_intent}
Urgency: ${urgency}
Context: ${channel_type} conversation in ${tokenData.team_name}

Requirements:
- Sound natural coming from ${tokenData.user_name}
- Match the appropriate tone for a ${channel_type} channel
- Be clear and direct without unnecessary fluff
- Feel authentic and human-written
- No AI disclaimers or mentions

Please draft this message as if I (${tokenData.user_name}) am writing it personally.`
        }
      }]
    })
  );

  // Prompt: Natural File Sharing
  server.registerPrompt(
    "natural-file-sharing",
    {
      title: "Natural File Sharing Message",
      description: "Generate natural, brief messages when sharing files - no markdown or technical descriptions",
      argsSchema: {
        file_type: z.enum(["document", "image", "code", "report", "other"]).describe("Type of file being shared"),
        context: z.string().describe("Context or purpose of sharing the file")
      }
    },
    ({ file_type, context }) => ({
      messages: [{
        role: "assistant",
        content: {
          type: "text",
          text: `When sharing a ${file_type} file in the context of "${context}", use a simple, natural message as ${tokenData.user_name}:

Good options:
- "Check this out"
- "Here you go" 
- "Take a look"
- "Sharing this with the team"
- "Here's the ${file_type}"
- "FYI"
- "" (no message - just the filename)

AVOID:
- Markdown formatting (**, *, etc.)
- Technical descriptions of file format
- Long explanations unless requested
- Formal language like "This demonstrates..." or "Please find attached..."

Keep it conversational and brief - let the filename speak for itself.`
        }
      }]
    })
  );

  // Tool 1: Send message to channel
  server.registerTool(
    "slack_send_message",
    {
      title: "Send Slack Message",
      description: "Send a message to a Slack channel or user",
      inputSchema: {
        channel: z.string().describe("Channel ID or name (e.g., #general, @username, or channel ID)"),
        text: z.string().describe("Message text to send")
      }
    },
    async ({ channel, text }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const result = await slack.chat.postMessage({
          channel: channel,
          text: text
        });
        
        console.log(`📤 Message sent by ${tokenData.user_name} to ${channel}`);
        
        return {
          content: [{
            type: "text",
            text: `✅ Message sent successfully to ${channel}!\n\nTimestamp: ${result.ts}\nChannel: ${result.channel}\nSent as: ${tokenData.user_name} (${tokenData.team_name})`
          }]
        };
      } catch (error) {
        console.error(`❌ Send message failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to send message: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 2: Send direct message
  server.registerTool(
    "slack_send_dm",
    {
      title: "Send Direct Message",
      description: "Send a direct message to a specific user",
      inputSchema: {
        user: z.string().describe("User ID or @username to send DM to"),
        text: z.string().describe("Message text to send")
      }
    },
    async ({ user, text }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // Open DM channel with user
        const dmResult = await slack.conversations.open({
          users: user.replace('@', '')
        });
        
        const result = await slack.chat.postMessage({
          channel: dmResult.channel.id,
          text: text
        });
        
        console.log(`💬 DM sent by ${tokenData.user_name} to ${user}`);
        
        return {
          content: [{
            type: "text",
            text: `✅ Direct message sent to ${user}!\n\nTimestamp: ${result.ts}\nSent as: ${tokenData.user_name}`
          }]
        };
      } catch (error) {
        console.error(`❌ Send DM failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to send DM: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 3: Get channels (user-specific)
  server.registerTool(
    "slack_get_channels",
    {
      title: "Get Slack Channels",
      description: "Get list of channels you have access to",
      inputSchema: {
        types: z.string().optional().describe("Channel types to include (public_channel,private_channel,mpim,im)").default("public_channel,private_channel")
      }
    },
    async ({ types = "public_channel,private_channel" }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const channels = await slack.conversations.list({
          types: types,
          limit: 200
        });
        
        const channelList = channels.channels
          .map(ch => {
            const type = ch.is_private ? '🔒 Private' : '🌍 Public';
            const members = ch.num_members ? ` (${ch.num_members} members)` : '';
            return `• #${ch.name} ${type}${members} - ${ch.id}`;
          })
          .join('\n');
        
        return {
          content: [{
            type: "text",
            text: `📋 Your channels in ${tokenData.team_name}:\n\n${channelList}\n\n*Connected as: ${tokenData.user_name}*`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get channels: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 4: Get workspace users
  server.registerTool(
    "slack_get_users",
    {
      title: "Get Workspace Users",
      description: "Get list of users in your workspace",
      inputSchema: {
        limit: z.number().optional().describe("Maximum number of users to return").default(50)
      }
    },
    async ({ limit = 50 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const users = await slack.users.list({
          limit: limit
        });
        
        const userList = users.members
          .filter(user => !user.deleted && !user.is_bot)
          .map(user => {
            const status = user.presence || 'unknown';
            const statusIcon = status === 'active' ? '🟢' : '⚪';
            const realName = user.real_name || user.name;
            const isCurrentUser = user.id === tokenData.user_id ? ' (YOU)' : '';
            return `• ${statusIcon} ${realName} (@${user.name}) - ${user.id}${isCurrentUser}`;
          })
          .join('\n');
        
        return {
          content: [{
            type: "text",
            text: `👥 Users in ${tokenData.team_name}:\n\n${userList}\n\n*Connected as: ${tokenData.user_name}*`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get users: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 5: Get workspace info (user-specific)
  server.registerTool(
    "slack_get_workspace_info",
    {
      title: "Get Workspace Info",
      description: "Get information about your workspace and profile",
      inputSchema: {}
    },
    async () => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const teamInfo = await slack.team.info();
        const userInfo = await slack.users.info({ user: tokenData.user_id });
        
        return {
          content: [{
            type: "text",
            text: `🏢 Your Workspace Information:

**Workspace:** ${teamInfo.team.name}
**Domain:** ${teamInfo.team.domain}.slack.com
**ID:** ${teamInfo.team.id}

**Your Profile:**
**Name:** ${userInfo.user.real_name || userInfo.user.name}
**Username:** @${userInfo.user.name}
**Email:** ${userInfo.user.profile.email || 'Not available'}
**Title:** ${userInfo.user.profile.title || 'Not set'}
**Status:** ${userInfo.user.presence || 'unknown'}

**Session Info:**
**Connected as:** ${tokenData.user_name}
**MCP Session:** ${sessionId}
**Token created:** ${tokenData.created_at}
**Permissions:** ${tokenData.scope ? tokenData.scope.split(',').length + ' scopes' : 'Standard scopes'}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get workspace info: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 6: Get messages
  server.registerTool(
    "slack_get_messages",
    {
      title: "Get Slack Messages",
      description: "Get messages from a channel or DM",
      inputSchema: {
        channel: z.string().describe("Channel ID or name"),
        limit: z.number().optional().describe("Number of messages to retrieve (max 100)").default(10)
      }
    },
    async ({ channel, limit = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const messages = await slack.conversations.history({
          channel: channel,
          limit: Math.min(limit, 100)
        });
        
        const messageList = await Promise.all(
          messages.messages
            .slice(0, limit)
            .map(async (msg) => {
              const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
              let userName = msg.user;
              
              // Try to get user's real name
              try {
                const userInfo = await slack.users.info({ user: msg.user });
                userName = userInfo.user.real_name || userInfo.user.name;
              } catch (e) {
                // Keep original user ID if lookup fails
              }
              
              return `[${timestamp}] ${userName}: ${msg.text || '(no text)'}`;
            })
        );
        
        return {
          content: [{
            type: "text",
            text: `💬 Recent messages from ${channel}:\n\n${messageList.join('\n')}\n\n*Retrieved by: ${tokenData.user_name}*`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get messages: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 7: Search messages
  server.registerTool(
    "slack_search_messages",
    {
      title: "Search Slack Messages",
      description: "Search for messages across your workspace",
      inputSchema: {
        query: z.string().describe("Search query (e.g., 'from:@user', 'in:#channel', or just keywords)"),
        limit: z.number().optional().describe("Number of results to return").default(10)
      }
    },
    async ({ query, limit = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const results = await slack.search.messages({
          query: query,
          count: Math.min(limit, 20)
        });
        
        if (!results.messages || results.messages.total === 0) {
          return {
            content: [{
              type: "text",
              text: `🔍 No messages found for query: "${query}"\n\n*Searched by: ${tokenData.user_name}*`
            }]
          };
        }
        
        const messageList = results.messages.matches
          .slice(0, limit)
          .map(msg => {
            const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
            const channel = msg.channel ? `#${msg.channel.name}` : 'DM';
            const userName = msg.user || 'Unknown';
            return `[${timestamp}] ${userName} in ${channel}: ${msg.text}`;
          })
          .join('\n\n');
        
        return {
          content: [{
            type: "text",
            text: `🔍 Search results for "${query}":\n\n${messageList}\n\n*Searched by: ${tokenData.user_name}*`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to search messages: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 8: Get user info
  server.registerTool(
    "slack_get_user_info",
    {
      title: "Get User Information",
      description: "Get detailed information about a specific user",
      inputSchema: {
        user: z.string().describe("User ID or @username to get info for")
      }
    },
    async ({ user }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const userInfo = await slack.users.info({ 
          user: user.replace('@', '') 
        });
        
        const u = userInfo.user;
        const profile = u.profile || {};
        
        return {
          content: [{
            type: "text",
            text: `👤 User Information:

**Name:** ${u.real_name || u.name}
**Username:** @${u.name}
**ID:** ${u.id}
**Email:** ${profile.email || 'Not available'}
**Phone:** ${profile.phone || 'Not available'}
**Title:** ${profile.title || 'Not set'}
**Status:** ${u.presence || 'unknown'}
**Timezone:** ${u.tz_label || 'Not available'}
**Is Admin:** ${u.is_admin ? 'Yes' : 'No'}
**Is Owner:** ${u.is_owner ? 'Yes' : 'No'}
**Account Type:** ${u.is_bot ? 'Bot' : 'User'}

**Status Text:** ${profile.status_text || 'None'}
**Status Emoji:** ${profile.status_emoji || 'None'}

*Retrieved by: ${tokenData.user_name}*`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get user info: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 9: Get channel info
  server.registerTool(
    "slack_get_channel_info",
    {
      title: "Get Channel Information",
      description: "Get detailed information about a specific channel",
      inputSchema: {
        channel: z.string().describe("Channel ID or name to get info for")
      }
    },
    async ({ channel }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const channelInfo = await slack.conversations.info({ 
          channel: channel.replace('#', '') 
        });
        
        const ch = channelInfo.channel;
        const created = new Date(ch.created * 1000).toLocaleString();
        
        return {
          content: [{
            type: "text",
            text: `📺 Channel Information:

**Name:** #${ch.name}
**ID:** ${ch.id}
**Type:** ${ch.is_private ? '🔒 Private' : '🌍 Public'}
**Topic:** ${ch.topic?.value || 'None'}
**Purpose:** ${ch.purpose?.value || 'None'}
**Members:** ${ch.num_members || 'Unknown'}
**Created:** ${created}
**Is Archived:** ${ch.is_archived ? 'Yes' : 'No'}
**Is General:** ${ch.is_general ? 'Yes' : 'No'}

**Creator:** ${ch.creator || 'Unknown'}

*Retrieved by: ${tokenData.user_name} from ${tokenData.team_name}*`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get channel info: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

// Simplified Slack File Upload - Less likely to crash Claude
server.registerTool(
  "slack_upload_file",
  {
    title: "Upload File to Slack",
    description: "Upload any file type to Slack with improved validation and error handling. Use simple, natural messages - no markdown formatting. IMPORTANT: Use channel ID (not channel name with #) for the channel parameter.",
    inputSchema: {
      channel: z.string().describe("Channel ID ONLY (e.g., 'C1234567890' or user ID like 'U1234567890'). DO NOT use channel names with # (like '#general'). Use the actual channel ID from slack_get_channels."),
      file_data: z.string().describe("Base64 encoded file data"),
      filename: z.string().describe("Name of the file including extension"),
      title: z.string().optional().describe("Title for the file"),
      initial_comment: z.string().optional().describe("Simple message to accompany the file (avoid markdown, keep it natural and brief)"),
      filetype: z.string().optional().describe("File type (e.g., 'png', 'jpg', 'pdf', 'txt', 'docx', 'xlsx')")
    }
  },
  async ({ channel, file_data, filename, title, initial_comment, filetype }) => {
    try {
      const slack = new WebClient(tokenData.access_token);
      
      // Basic validation only
      if (!file_data || !filename) {
        throw new Error('Missing required file data or filename');
      }
      
      // Simple base64 validation
      let fileBuffer;
      try {
        fileBuffer = Buffer.from(file_data, 'base64');
      } catch (error) {
        throw new Error('Invalid base64 file data');
      }
      
      // Basic size check (100MB limit)
      if (fileBuffer.length > 100 * 1024 * 1024) {
        throw new Error('File too large (100MB limit)');
      }
      
      // Clean channel ID
      const channelId = channel.replace(/^[#@]/, '');
      
      // Simple file type detection from extension
      const getFileType = (filename) => {
        const ext = filename.toLowerCase().split('.').pop();
        const typeMap = {
          'jpg': 'jpg', 'jpeg': 'jpg', 'png': 'png', 'gif': 'gif', 'pdf': 'pdf',
          'doc': 'doc', 'docx': 'docx', 'txt': 'txt', 'csv': 'csv',
          'xls': 'xls', 'xlsx': 'xlsx', 'zip': 'zip', 'json': 'json'
        };
        return typeMap[ext] || 'binary';
      };
      
      const detectedType = filetype || getFileType(filename);
      
      // Use simple comment if none provided or if it looks formatted
      let finalComment = initial_comment;
      if (!finalComment || finalComment.includes('**') || finalComment.includes('*')) {
        finalComment = "Here's the file";
      }
      
      console.log(`Uploading: ${filename} (${(fileBuffer.length / 1024).toFixed(1)}KB)`);
      
      // Use filesUploadV2 for most cases
      const result = await slack.filesUploadV2({
        channel_id: channelId,
        file: fileBuffer,
        filename: filename,
        title: title || filename,
        initial_comment: finalComment,
        file_type: detectedType
      });
      
      if (!result.ok) {
        throw new Error(result.error || 'Upload failed');
      }
      
      return {
        content: [{
          type: "text",
          text: `✅ File uploaded successfully!

File: ${filename}
Size: ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB
Type: ${detectedType}
Channel: ${channel}
Message: "${finalComment}"`
        }]
      };
      
    } catch (error) {
      console.error(`File upload failed:`, error.message);
      
      // Simple error response
      return {
        content: [{
          type: "text",
          text: `❌ File upload failed: ${error.message}

Basic troubleshooting:
• Check channel permissions
• Verify file size is under 100MB
• Ensure file data is properly base64 encoded
• Try a smaller test file first`
        }],
        isError: true
      };
    }
  }
);
  // Tool 13: Add reaction to message
  server.registerTool(
    "slack_add_reaction",
    {
      title: "Add Reaction to Message",
      description: "Add an emoji reaction to a Slack message",
      inputSchema: {
        channel: z.string().describe("Channel ID or name where the message is located"),
        timestamp: z.string().describe("Message timestamp (from message history or search results)"),
        name: z.string().describe("Emoji name without colons (e.g., 'thumbsup', 'heart', 'fire', 'tada')")
      }
    },
    async ({ channel, timestamp, name }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // Add reaction to the message
        await slack.reactions.add({
          channel: channel.replace('#', ''),
          timestamp: timestamp,
          name: name.replace(/:/g, '') // Remove colons if user included them
        });
        
        console.log(`👍 Reaction :${name}: added by ${tokenData.user_name} to message ${timestamp} in ${channel}`);
        
        return {
          content: [{
            type: "text",
            text: `✅ Added :${name}: reaction to message!\n\nChannel: ${channel}\nMessage timestamp: ${timestamp}\nReaction: :${name}:\nAdded by: ${tokenData.user_name}`
          }]
        };
      } catch (error) {
        console.error(`❌ Add reaction failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to add reaction: ${error.message}\n\nTip: Make sure the message timestamp is correct and you have permission to react in this channel.`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 14: Remove reaction from message
  server.registerTool(
    "slack_remove_reaction",
    {
      title: "Remove Reaction from Message", 
      description: "Remove an emoji reaction from a Slack message",
      inputSchema: {
        channel: z.string().describe("Channel ID or name where the message is located"),
        timestamp: z.string().describe("Message timestamp"),
        name: z.string().describe("Emoji name without colons (e.g., 'thumbsup', 'heart', 'fire')")
      }
    },
    async ({ channel, timestamp, name }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // Remove reaction from the message
        await slack.reactions.remove({
          channel: channel.replace('#', ''),
          timestamp: timestamp,
          name: name.replace(/:/g, '')
        });
        
        console.log(`👎 Reaction :${name}: removed by ${tokenData.user_name} from message ${timestamp} in ${channel}`);
        
        return {
          content: [{
            type: "text",
            text: `✅ Removed :${name}: reaction from message!\n\nChannel: ${channel}\nMessage timestamp: ${timestamp}\nReaction removed: :${name}:\nRemoved by: ${tokenData.user_name}`
          }]
        };
      } catch (error) {
        console.error(`❌ Remove reaction failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to remove reaction: ${error.message}\n\nTip: You can only remove reactions that you added, or you need admin permissions.`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 15: Get reactions on a message
  server.registerTool(
    "slack_get_reactions",
    {
      title: "Get Message Reactions",
      description: "Get all reactions on a specific Slack message",
      inputSchema: {
        channel: z.string().describe("Channel ID or name where the message is located"),
        timestamp: z.string().describe("Message timestamp")
      }
    },
    async ({ channel, timestamp }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // Get message with reactions
        const result = await slack.conversations.history({
          channel: channel.replace('#', ''),
          latest: timestamp,
          oldest: timestamp,
          inclusive: true,
          limit: 1
        });
        
        if (!result.messages || result.messages.length === 0) {
          return {
            content: [{
              type: "text", 
              text: `❌ Message not found at timestamp ${timestamp} in ${channel}`
            }],
            isError: true
          };
        }
        
        const message = result.messages[0];
        const reactions = message.reactions || [];
        
        if (reactions.length === 0) {
          return {
            content: [{
              type: "text",
              text: `📭 No reactions found on this message in ${channel}\n\nMessage timestamp: ${timestamp}\nChecked by: ${tokenData.user_name}`
            }]
          };
        }
        
        // Format reactions with user counts
        const reactionList = reactions.map(reaction => {
          const users = reaction.users || [];
          const userCount = reaction.count || users.length;
          return `• :${reaction.name}: (${userCount} ${userCount === 1 ? 'person' : 'people'})`;
        }).join('\n');
        
        return {
          content: [{
            type: "text",
            text: `👍 Reactions on message in ${channel}:\n\n${reactionList}\n\nMessage timestamp: ${timestamp}\nTotal reactions: ${reactions.length}\nChecked by: ${tokenData.user_name}`
          }]
        };
      } catch (error) {
        console.error(`❌ Get reactions failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get reactions: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 16: React to latest message in channel
  server.registerTool(
    "slack_react_to_latest",
    {
      title: "React to Latest Message",
      description: "Add a reaction to the most recent message in a channel",
      inputSchema: {
        channel: z.string().describe("Channel ID or name"),
        name: z.string().describe("Emoji name without colons (e.g., 'thumbsup', 'heart', 'fire', 'tada')"),
        exclude_self: z.boolean().optional().describe("Skip your own messages").default(true)
      }
    },
    async ({ channel, name, exclude_self = true }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // Get recent messages
        const messages = await slack.conversations.history({
          channel: channel.replace('#', ''),
          limit: 10
        });
        
        if (!messages.messages || messages.messages.length === 0) {
          return {
            content: [{
              type: "text",
              text: `❌ No messages found in ${channel}`
            }],
            isError: true
          };
        }
        
        // Find the latest message (optionally excluding own messages)
        let targetMessage = null;
        for (const msg of messages.messages) {
          if (exclude_self && msg.user === tokenData.user_id) {
            continue; // Skip own messages
          }
          targetMessage = msg;
          break;
        }
        
        if (!targetMessage) {
          return {
            content: [{
              type: "text",
              text: `❌ No suitable message found in ${channel} (excluding your own messages)`
            }],
            isError: true
          };
        }
        
        // Add reaction to the message
        await slack.reactions.add({
          channel: channel.replace('#', ''),
          timestamp: targetMessage.ts,
          name: name.replace(/:/g, '')
        });
        
        console.log(`👍 Reaction :${name}: added by ${tokenData.user_name} to latest message in ${channel}`);
        
        // Get user name for the message author
        let authorName = targetMessage.user;
        try {
          const userInfo = await slack.users.info({ user: targetMessage.user });
          authorName = userInfo.user.real_name || userInfo.user.name;
        } catch (e) {
          // Keep original user ID if lookup fails
        }
        
        return {
          content: [{
            type: "text",
            text: `✅ Added :${name}: reaction to latest message!\n\nChannel: ${channel}\nMessage author: ${authorName}\nMessage preview: "${(targetMessage.text || '').substring(0, 100)}${targetMessage.text && targetMessage.text.length > 100 ? '...' : ''}"\nReaction: :${name}:\nAdded by: ${tokenData.user_name}`
          }]
        };
      } catch (error) {
        console.error(`❌ React to latest failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to react to latest message: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Log critical user proxy reminder
  console.log(`🚨 USER PROXY MODE: All Slack communications will appear as ${tokenData.user_name} (${tokenData.team_name})`);
  console.log(`📋 Available resources: system-initialization, user-proxy-guidelines, user-context, communication-best-practices, file-sharing-guidelines`);
  console.log(`📝 Available prompts: send-as-user, user-communication-style, review-message, channel-appropriate-message, natural-file-sharing`);
  console.log(`🚫 FILE SHARING: NO markdown formatting, NO technical descriptions, use simple natural messages`);

  return server;
}

// Enhanced MCP Token endpoint - user-specific tokens
app.post('/token', express.json(), (req, res) => {
  const { code, state } = req.body;
  
  console.log('Token exchange request from Claude:', { code: !!code, state });
  
  if (!code) {
    return res.status(400).json({ 
      error: 'invalid_request', 
      error_description: 'Missing authorization code' 
    });
  }
  
  // Look up the auth mapping with user context
  const authMapping = claudeTokens.get(`claude_auth_${code}`);
  
  if (!authMapping) {
    return res.status(400).json({ 
      error: 'invalid_grant', 
      error_description: 'Authorization code not found or expired' 
    });
  }
  
  // Clean up the auth code
  claudeTokens.delete(`claude_auth_${code}`);
  
  // Create user-specific access token with Claude user context
  const accessToken = `mcp_${authMapping.claude_user_id}_${authMapping.team_id}_${authMapping.user_id}_${Date.now()}`;
  
  // Store the mapping for this specific Claude user
  claudeTokens.set(accessToken, {
    team_id: authMapping.team_id,
    user_id: authMapping.user_id,
    claude_user_id: authMapping.claude_user_id,
    created_at: new Date().toISOString()
  });
  
  console.log(`🎫 Issued individual MCP token for Claude user ${authMapping.claude_user_id} → Slack ${authMapping.team_id}:${authMapping.user_id}`);
  
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'slack:read slack:write',
    user_context: {
      claude_user_id: authMapping.claude_user_id,
      slack_team_id: authMapping.team_id,
      slack_user_id: authMapping.user_id
    }
  });
});

// Simplified auth page for Claude web users
app.get('/simple-auth', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  const state = 'claude-web-' + crypto.randomBytes(16).toString('hex');
  const scopes = 'channels:read chat:write users:read channels:history im:history mpim:history search:read groups:read mpim:read channels:write groups:write im:write files:write files:read reactions:read reactions:write';
  
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&user_scope=${encodeURIComponent(scopes)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Slack MCP Server - Multi-User Setup</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
        .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .button { display: inline-block; padding: 12px 24px; background: #4A154B; color: white; text-decoration: none; border-radius: 5px; margin: 10px; }
        .step { margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 5px; text-align: left; }
        .code { background: #e9ecef; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
        .info { background: #d4edda; border: 1px solid #c3e6cb; padding: 10px; border-radius: 5px; margin: 10px 0; }
        .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 5px; margin: 10px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔐 Slack MCP Server Setup</h1>
        
        <div class="info">
          <strong>🔒 Secure Individual Access:</strong> Each person must authenticate with their own Slack account. No shared access allowed.
        </div>

        <div class="warning">
          <strong>🚨 USER PROXY MODE:</strong> When you connect, Claude will act AS YOU on Slack. All messages will appear with your name and profile.
        </div>
        
        <div class="step">
          <strong>Step 1:</strong> Connect Your Slack Account
          <br><br>
          <a href="${authUrl}" class="button">🔗 Connect My Slack Account</a>
          <br><small>This will connect YOUR Slack account specifically</small>
        </div>
        
        <div class="step">
          <strong>Step 2:</strong> Configure Claude
          <br><br>
          After authentication, use this URL in Claude:
          <br><code class="code">${baseUrl}/mcp</code>
        </div>
        
        <div class="step">
          <strong>Step 3:</strong> Test Your Connection
          <br><br>
          In Claude, try: "Show me my Slack channels"
        </div>
        
        <p><strong>Server Status:</strong> 
          <span style="color: green;">✅ Online</span> | 
          <span style="color: ${userTokens.size > 0 ? 'green' : 'orange'};">
            Connected Users: ${userTokens.size}
          </span>
        </p>
        
        <p><small>⚠️ Each user must authenticate individually. You cannot use someone else's Slack connection.</small></p>
      </div>
    </body>
    </html>
  `);
});

// MCP Authorization endpoint for Claude - now user-specific
app.get('/authorize', (req, res) => {
  const { state, redirect_uri } = req.query;
  
  if (!state || !redirect_uri) {
    return res.status(400).json({ 
      error: 'Missing required parameters', 
      details: 'state and redirect_uri are required' 
    });
  }
  
  // Generate unique identifier for this Claude user session
  const claudeUserId = `claude_${crypto.randomBytes(16).toString('hex')}`;
  
  // Store Claude's redirect info with user identifier
  const authSession = {
    claude_user_id: claudeUserId,
    claude_state: state,
    claude_redirect_uri: redirect_uri,
    timestamp: Date.now()
  };
  
  // Store session with unique key
  const sessionKey = `auth_${claudeUserId}_${crypto.randomBytes(8).toString('hex')}`;
  userTokens.set(sessionKey, authSession);
  
  // Redirect to Slack OAuth with user context
  const baseUrl = getBaseUrl(req);
  const slackOAuthUrl = `${baseUrl}/oauth/slack?auth_session=${sessionKey}&claude_user=${claudeUserId}`;
  
  console.log(`🔐 Claude user ${claudeUserId} starting OAuth flow`);
  res.redirect(slackOAuthUrl);
});

// OAuth endpoints with user context
app.get('/oauth/slack', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  console.log('OAuth request - Base URL:', baseUrl);
  console.log('OAuth request - Redirect URI:', redirectUri);
  
  // Get auth session and user context from query params
  const authSession = req.query.auth_session;
  const claudeUser = req.query.claude_user;
  
  const state = authSession || crypto.randomBytes(16).toString('hex');
   const scopes = 'channels:read chat:write users:read channels:history im:history mpim:history search:read groups:read mpim:read channels:write groups:write im:write files:write files:read reactions:read reactions:write';
  
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&user_scope=${encodeURIComponent(scopes)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  console.log(`🔗 OAuth redirect for Claude user ${claudeUser || 'unknown'}:`, authUrl);
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  const { code, state, error } = req.query;
  
  console.log('OAuth callback received:', { code: !!code, state, error });
  
  if (error) {
    console.error('OAuth error received:', error);
    return res.status(400).json({ error: 'OAuth error', details: error });
  }
  
  if (!code) {
    console.error('No authorization code received');
    return res.status(400).json({ error: 'Missing authorization code' });
  }
  
  try {
    console.log('Exchanging code for token...');
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: SLACK_CLIENT_ID,
        client_secret: SLACK_CLIENT_SECRET,
        code: code,
        redirect_uri: redirectUri,
      }),
    });
    
    const data = await response.json();
    console.log('OAuth response:', JSON.stringify(data, null, 2));
    
    if (!data.ok) {
      console.error('OAuth token exchange failed:', data.error);
      return res.status(400).json({ error: 'OAuth token exchange failed', details: data.error });
    }
    
    // Store the token with enhanced user context
    const userId = data.authed_user.id;
    const teamId = data.team.id;
    const tokenKey = `${teamId}:${userId}`;
    
    // Try to get a better user name by calling the Slack API
    let userName = data.authed_user.name || 'Unknown';
    try {
      const tempSlack = new WebClient(data.authed_user.access_token);
      const userInfo = await tempSlack.users.info({ user: userId });
      userName = userInfo.user.real_name || userInfo.user.name || userInfo.user.profile?.display_name || data.authed_user.name || `User_${userId.substring(0, 8)}`;
    } catch (e) {
      console.log('Could not fetch user details, using fallback name');
      userName = data.authed_user.name || `User_${userId.substring(0, 8)}`;
    }

    const tokenData = {
      access_token: data.authed_user.access_token,
      team_id: teamId,
      user_id: userId,
      team_name: data.team.name,
      user_name: userName,
      scope: data.authed_user.scope,
      created_at: new Date().toISOString()
    };
    
    userTokens.set(tokenKey, tokenData);
    console.log(`✅ Slack token stored for user: ${tokenData.user_name} (${tokenKey})`);
    
    // Check if this was initiated from Claude
    const authSession = userTokens.get(state);
    
    if (authSession && authSession.claude_user_id) {
      // This was initiated from Claude - redirect back to Claude with user-specific token
      console.log(`Redirecting Claude user ${authSession.claude_user_id} back to Claude`);
      
      // Clean up the session
      userTokens.delete(state);
      
      // Create an authorization code for Claude with user context
      const claudeAuthCode = crypto.randomBytes(32).toString('hex');
      
      // Store the mapping between auth code and SPECIFIC user token
      claudeTokens.set(`claude_auth_${claudeAuthCode}`, {
        team_id: teamId,
        user_id: userId,
        claude_user_id: authSession.claude_user_id,
        created_at: new Date().toISOString()
      });
      
      // Redirect back to Claude with authorization code
      const claudeCallbackUrl = `${authSession.claude_redirect_uri}?code=${claudeAuthCode}&state=${authSession.claude_state}`;
      
      console.log(`Redirecting Claude user ${authSession.claude_user_id} back with callback URL`);
      
      // Show success page with user-specific information and proxy warning
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Individual Authentication Successful</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
            .container { max-width: 450px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .success { color: #28a745; font-size: 18px; margin-bottom: 20px; }
            .info { color: #666; margin-bottom: 20px; }
            .button { display: inline-block; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
            .spinner { border: 2px solid #f3f3f3; border-top: 2px solid #007bff; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 20px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .highlight { background: #e7f3ff; padding: 10px; border-radius: 5px; margin: 10px 0; }
            .security { background: #d4edda; border: 1px solid #c3e6cb; padding: 10px; border-radius: 5px; margin: 10px 0; }
            .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 5px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Your Personal Slack Connection!</h1>
            <div class="success">Your individual Slack account has been connected to Claude.</div>
            
            <div class="security">
              <strong>🔒 Private Connection:</strong> This connection is yours alone. Other Claude users cannot access your Slack account.
            </div>

            <div class="warning">
              <strong>🚨 USER PROXY MODE:</strong> Claude will now act AS YOU on Slack. All messages will appear with your name and profile.
            </div>
            
            <div class="highlight">
              <strong>Your Connection Details:</strong><br>
              <strong>Workspace:</strong> ${data.team.name}<br>
              <strong>Your Name:</strong> ${userName}<br>
              <strong>Claude User:</strong> ${authSession.claude_user_id.substring(0, 12)}...<br>
              <strong>Permissions:</strong> ${data.authed_user.scope.split(',').length} scopes
            </div>
            <div class="spinner"></div>
            <p>Redirecting back to Claude...</p>
            <p><a href="${claudeCallbackUrl}" class="button">Continue to Claude</a></p>
          </div>
          <script>
            // Auto-redirect after 3 seconds
            setTimeout(() => {
              window.location.href = "${claudeCallbackUrl}";
            }, 3000);
          </script>
        </body>
        </html>
      `);
    } else {
      // Direct Slack auth - show success message
      res.json({ 
        success: true, 
        message: 'Successfully authenticated with Slack',
        user_data: {
          team: data.team.name,
          user: userName,
          team_id: teamId,
          user_id: userId,
          scopes: data.authed_user.scope.split(',').length
        },
        next_step: 'You can now connect this server to Claude using the MCP endpoint'
      });
    }
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Debug endpoint to show connected users
app.get('/debug/users', async (req, res) => {
  const connectedUsers = Array.from(userTokens.entries())
    .filter(([key, value]) => key.includes(':') && value.access_token)
    .map(([key, value]) => ({
      key: key,
      team_name: value.team_name,
      user_name: value.user_name,
      scopes: value.scope ? value.scope.split(',').length : 0,
      created_at: value.created_at
    }));
  
  const activeSessions = Array.from(sessionUsers.entries()).map(([sessionId, tokenData]) => ({
    session_id: sessionId,
    user_name: tokenData.user_name,
    team_name: tokenData.team_name
  }));
  
  res.json({
    success: true,
    connected_users: connectedUsers,
    active_mcp_sessions: activeSessions,
    claude_tokens: claudeTokens.size,
    total_users: connectedUsers.length
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    connected_users: userTokens.size,
    active_sessions: mcpTransports.size,
    claude_tokens: claudeTokens.size
  });
});

// Info endpoint
app.get('/info', (req, res) => {
  const baseUrl = getBaseUrl(req);
  
  res.json({
    app_name: 'Slack MCP Server - Multi-User',
    version: '2.0.0',
    base_url: baseUrl,
    status: 'online',
    authentication: {
      connected_users: userTokens.size,
      active_sessions: mcpTransports.size,
      claude_tokens: claudeTokens.size,
      slack_teams: Array.from(userTokens.entries())
        .filter(([key, value]) => key.includes(':') && value.team_name)
        .map(([key, value]) => ({
          team_name: value.team_name,
          user_name: value.user_name,
          team_id: value.team_id
        }))
    },
    endpoints: {
      simple_auth: `${baseUrl}/simple-auth`,
      oauth_slack: `${baseUrl}/oauth/slack`,
      mcp_endpoint: `${baseUrl}/mcp`,
      debug_users: `${baseUrl}/debug/users`,
      health_check: `${baseUrl}/health`
    },
    features: [
      "🔒 Individual authentication required",
      "🚫 No shared or fallback tokens",
      "👤 Each user must connect their own Slack", 
      "📊 User activity tracking",
      "🎫 Secure token isolation",
      "🚨 User Proxy Mode with file sharing guidelines"
    ]
  });
});

// Add CORS middleware for Claude integration
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, mcp-session-id');
  res.header('Access-Control-Expose-Headers', 'mcp-session-id');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Enhanced MCP endpoint with smart user selection
app.post('/mcp', async (req, res) => {
  console.log('📡 MCP request received:', req.body?.method || 'unknown');
  
  try {
    const sessionId = req.headers['mcp-session-id'] || randomUUID();
    let transport = mcpTransports.get(sessionId);
    
    // Handle initialize request with smart user selection
    if (req.body?.method === 'initialize') {
      console.log('🚀 Initialize request - session:', sessionId);
      
      if (!transport) {
        // Get user token data - NO FALLBACKS, user must authenticate themselves
        let tokenData = null;
        
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const token = authHeader.substring(7);
          tokenData = getUserTokenData(token);
          
          if (tokenData) {
            console.log(`🎫 Using authenticated token for ${tokenData.user_name}`);
          } else {
            console.log('❌ Invalid or expired token provided');
            return res.status(401).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Invalid or expired authentication token. Please re-authenticate via /simple-auth.'
              },
              id: req.body?.id || null
            });
          }
        } else if (sessionUsers.has(sessionId)) {
          tokenData = sessionUsers.get(sessionId);
          console.log(`🔄 Reusing session for ${tokenData.user_name}`);
        } else {
          // NO FALLBACK - user must authenticate
          console.log('❌ No authentication provided - user must authenticate');
          return res.status(401).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Authentication required. Please authenticate with your own Slack account via /simple-auth first.'
            },
            id: req.body?.id || null
          });
        }
        
        console.log(`✅ Creating session for user: ${tokenData.user_name} (${tokenData.team_name})`);
        
        // Create new transport for this session
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          onsessioninitialized: (sid) => {
            console.log('📡 MCP session initialized:', sid);
          }
        });
        
        transport.onclose = () => {
          console.log('📡 MCP session closed:', sessionId);
          mcpTransports.delete(sessionId);
          sessionUsers.delete(sessionId);
        };
        
        mcpTransports.set(sessionId, transport);
        sessionUsers.set(sessionId, tokenData);
        
        // Create user-specific MCP server
        const mcpServer = createMCPServer(tokenData, sessionId);
        
        // Connect server to transport
        await mcpServer.connect(transport);
        
        console.log(`✅ MCP server connected for ${tokenData.user_name}`);
        console.log(`🚨 REMINDER: Claude is now acting as ${tokenData.user_name} in all Slack communications`);
      }
      
      // Handle the initialize request
      await transport.handleRequest(req, res, req.body);
      return;
    }
    
    // For other requests, check if transport exists
    if (!transport) {
      console.log('❌ No transport found for session:', sessionId);
      return res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Session not found. Please initialize first.'
        },
        id: req.body?.id || null
      });
    }
    
    // Handle the request through the existing transport
    await transport.handleRequest(req, res, req.body);
    
  } catch (error) {
    console.error('❌ MCP endpoint error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error',
        details: error.message
      },
      id: req.body?.id || null
    });
  }
});

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  if (!sessionId) {
    return res.status(400).send('Missing session ID');
  }
  
  const transport = mcpTransports.get(sessionId);
  
  if (!transport) {
    return res.status(404).send('Session not found');
  }
  
  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('❌ MCP GET error:', error);
    res.status(500).send('Internal server error');
  }
});

// Handle DELETE requests for session termination
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  if (!sessionId) {
    return res.status(400).send('Missing session ID');
  }
  
  const transport = mcpTransports.get(sessionId);
  
  if (!transport) {
    return res.status(404).send('Session not found');
  }
  
  try {
    await transport.handleRequest(req, res);
    mcpTransports.delete(sessionId);
    sessionUsers.delete(sessionId);
    console.log('🗑️ Session terminated:', sessionId);
  } catch (error) {
    console.error('❌ MCP DELETE error:', error);
    res.status(500).send('Internal server error');
  }
});

// Start the Express server
app.listen(port, () => {
  console.log(`🚀 Multi-User Slack MCP Server listening on port ${port}`);
  console.log(`❤️ Health check: http://localhost:${port}/health`);
  console.log(`📝 Info: http://localhost:${port}/info`);
  console.log(`👥 Simple auth: http://localhost:${port}/simple-auth`);
  console.log(`🔌 MCP Endpoint: http://localhost:${port}/mcp`);
  console.log(`🚨 USER PROXY MODE: All communications appear as the authenticated user`);
  console.log(`🚫 FILE SHARING: Enhanced validation with natural message filtering`);
});

// Handle process termination
process.on('SIGINT', async () => {
  console.log('Shutting down multi-user server...');
  
  // Close all MCP transports
  for (const [sessionId, transport] of mcpTransports) {
    try {
      await transport.close();
      console.log(`Closed MCP transport for session: ${sessionId}`);
    } catch (error) {
      console.error(`Error closing transport ${sessionId}:`, error);
    }
  }
  
  process.exit(0);
});

export default app;