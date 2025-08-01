import { WebClient } from "@slack/web-api";
import { z } from "zod";

// Centralized user resolution - handles all user input formats consistently
async function resolveUser(slack, userInput) {
  // If it's already a user ID (starts with U), return user info
  if (userInput.match(/^U[A-Z0-9]+$/)) {
    try {
      const userInfo = await slack.users.info({ user: userInput });
      return {
        id: userInfo.user.id,
        name: userInfo.user.real_name || userInfo.user.name,
        username: userInfo.user.name
      };
    } catch (e) {
      throw new Error(`Invalid user ID: ${userInput}`);
    }
  }
  
  // Remove @ if present and normalize
  const cleanInput = userInput.replace('@', '').toLowerCase().trim();
  
  // Get all users (with pagination)
  let allUsers = [];
  let cursor = null;
  
  do {
    const params = { limit: 200 };
    if (cursor) params.cursor = cursor;
    
    const users = await slack.users.list(params);
    allUsers = allUsers.concat(users.members || []);
    cursor = users.response_metadata?.next_cursor;
  } while (cursor);
  
  // Filter active, non-bot users and find matches
  const candidates = allUsers
    .filter(user => !user.deleted && !user.is_bot)
    .map(user => {
      const realName = (user.real_name || '').toLowerCase();
      const username = (user.name || '').toLowerCase();
      const displayName = (user.profile?.display_name || '').toLowerCase();
      
      // Score matches (exact > starts with > contains)
      let score = 0;
      if (username === cleanInput) score = 100;
      else if (realName === cleanInput) score = 90;
      else if (displayName === cleanInput) score = 85;
      else if (username.startsWith(cleanInput)) score = 70;
      else if (realName.startsWith(cleanInput)) score = 60;
      else if (displayName.startsWith(cleanInput)) score = 55;
      else if (username.includes(cleanInput)) score = 30;
      else if (realName.includes(cleanInput)) score = 20;
      else if (displayName.includes(cleanInput)) score = 15;
      
      return { user, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  
  if (candidates.length === 0) {
    throw new Error(`User not found: ${userInput}. Try exact username, display name, or user ID.`);
  }
  
  // If multiple high-scoring matches, require disambiguation
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    const suggestions = candidates.slice(0, 3).map(c => 
      `${c.user.real_name || c.user.name} (@${c.user.name})`
    );
    throw new Error(`Multiple users found for "${userInput}". Be more specific. Did you mean: ${suggestions.join(', ')}?`);
  }
  
  const bestMatch = candidates[0].user;
  return {
    id: bestMatch.id,
    name: bestMatch.real_name || bestMatch.name,
    username: bestMatch.name
  };
}

// Main function to register all Slack tools
export function registerSlackTools(server, tokenData, sessionId) {
  
  // Tool 1: Send message (handles both channels and DMs)
  server.registerTool(
    "slack_send_message",
    {
      title: "Send Slack Message",
      description: "Send a message to a Slack channel or user",
      inputSchema: {
        channel: z.string().describe("Channel name (#general), username (@john.doe), or channel/user ID"),
        text: z.string().describe("Message text to send")
      }
    },
    async ({ channel, text }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        let targetChannel = channel;
        let targetName = channel;
        
        // Handle user mentions - resolve to DM channel
        if (channel.startsWith('@') || (!channel.startsWith('#') && !channel.startsWith('C') && !channel.startsWith('D'))) {
          const user = await resolveUser(slack, channel);
          const dmResult = await slack.conversations.open({ users: user.id });
          targetChannel = dmResult.channel.id;
          targetName = `DM with ${user.name}`;
        } else if (channel.startsWith('#')) {
          targetChannel = channel.substring(1);
          targetName = channel;
        }
        
        const result = await slack.chat.postMessage({
          channel: targetChannel,
          text: text
        });
        
        console.log(`📤 Message sent by ${tokenData.user_name} to ${targetName}`);
        
        return {
          content: [{
            type: "text",
            text: `✅ Message sent to ${targetName}!\nTimestamp: ${result.ts}\nSent as: ${tokenData.user_name}`
          }]
        };
      } catch (error) {
        console.error(`❌ Send message failed:`, error.message);
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

  // Tool 2: Get messages (works for both channels and DMs)
  server.registerTool(
    "slack_get_messages",
    {
      title: "Get Messages",
      description: "Get recent messages from a channel or DM conversation. For DMs with users, use exact user ID from search_users tool first.",
      inputSchema: {
        channel: z.string().describe("Channel name (#general), exact user ID (U1234567 from search_users), or channel ID"),
        limit: z.number().optional().describe("Number of messages to retrieve (max 50)").default(10)
      }
    },
    async ({ channel, limit = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        let targetChannel = channel;
        let targetName = channel;
        
        // Check if this looks like a user reference that needs search_users first
        const needsUserSearch = (
          // Starts with @ but isn't a user ID
          (channel.startsWith('@') && !channel.match(/^@?U[A-Z0-9]+$/)) ||
          // Doesn't start with #, C, D, or U (not a proper ID)
          (!channel.startsWith('#') && !channel.startsWith('C') && !channel.startsWith('D') && !channel.startsWith('U') && !channel.includes('.slack.com'))
        );
        
        if (needsUserSearch) {
          return {
            content: [{
              type: "text",
              text: `❌ To get DM messages with specific users, please:\n\n1. First use **search_users** tool to find the exact user\n2. Then use this tool with the user ID: \`U1234567\`\n\nExample:\n• Instead of: "${channel}"\n• Use: "U1234567" (exact user ID from search results)\n\nThis ensures we open the DM with the correct person, especially when multiple users have similar names.`
            }],
            isError: true
          };
        }
        
        // Handle user IDs - convert to DM channel
        if (channel.match(/^@?U[A-Z0-9]+$/)) {
          const userId = channel.replace('@', '');
          try {
            // Get user info for display name
            const userInfo = await slack.users.info({ user: userId });
            const userName = userInfo.user.real_name || userInfo.user.name;
            
            const dmResult = await slack.conversations.open({ users: userId });
            targetChannel = dmResult.channel.id;
            targetName = `DM with ${userName}`;
          } catch (e) {
            return {
              content: [{
                type: "text",
                text: `❌ Invalid user ID: ${channel}. Please use search_users to find the correct user ID.`
              }],
              isError: true
            };
          }
        } else if (channel.startsWith('#')) {
          targetChannel = channel.substring(1);
          targetName = channel;
        }
        // For channel IDs (C..., D...), use as-is
        
        const messages = await slack.conversations.history({
          channel: targetChannel,
          limit: Math.min(limit, 50)
        });
        
        if (!messages.messages || messages.messages.length === 0) {
          return {
            content: [{
              type: "text",
              text: `💬 No messages found in ${targetName}`
            }]
          };
        }
        
        // Build user cache for efficient name lookups
        const userCache = new Map();
        const uniqueUserIds = [...new Set(messages.messages.map(m => m.user).filter(Boolean))];
        
        await Promise.all(uniqueUserIds.map(async (userId) => {
          try {
            const userInfo = await slack.users.info({ user: userId });
            userCache.set(userId, userInfo.user.real_name || userInfo.user.name);
          } catch (e) {
            userCache.set(userId, userId);
          }
        }));
        
        const messageList = messages.messages
          .slice(0, limit)
          .map((msg) => {
            const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
            const userName = userCache.get(msg.user) || msg.user || 'Unknown';
            const isMe = msg.user === tokenData.user_id ? ' (You)' : '';
            return `[${timestamp}] ${userName}${isMe}: ${msg.text || '(no text)'}`;
          });
        
        return {
          content: [{
            type: "text",
            text: `💬 Recent messages from ${targetName}:\n\n${messageList.join('\n')}\n\n*Retrieved ${messageList.length} messages*`
          }]
        };
      } catch (error) {
        console.error(`❌ Get messages failed:`, error.message);
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

  // Tool 3: Search messages
  server.registerTool(
    "slack_search_messages",
    {
      title: "Search Messages",
      description: "Search for messages across workspace or in specific channel/DM",
      inputSchema: {
        query: z.string().describe("Search keywords or username"),
        channel: z.string().optional().describe("Optional: limit search to specific channel (#general) or user (@john.doe)"),
        limit: z.number().optional().describe("Number of results (max 20)").default(10)
      }
    },
    async ({ query, channel, limit = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        let searchQuery = query;
        let searchLocation = "workspace";
        
        // Add channel filter if specified
        if (channel) {
          let targetChannel = channel;
          
          if (channel.startsWith('@') || (!channel.startsWith('#') && !channel.startsWith('C') && !channel.startsWith('D'))) {
            const user = await resolveUser(slack, channel);
            const dmResult = await slack.conversations.open({ users: user.id });
            targetChannel = dmResult.channel.id;
            searchLocation = `DM with ${user.name}`;
          } else if (channel.startsWith('#')) {
            targetChannel = channel.substring(1);
            searchLocation = channel;
          }
          
          searchQuery = `in:${targetChannel} ${query}`;
        }
        
        console.log(`🔍 Search query: "${searchQuery}"`);
        
        const results = await slack.search.messages({
          query: searchQuery,
          count: Math.min(limit, 20)
        });
        
        if (!results.messages || results.messages.total === 0) {
          return {
            content: [{
              type: "text",
              text: `🔍 No messages found for "${query}" in ${searchLocation}`
            }]
          };
        }
        
        // Build user cache for efficient name lookups
        const userCache = new Map();
        const uniqueUserIds = [...new Set(results.messages.matches.map(m => m.user).filter(Boolean))];
        
        await Promise.all(uniqueUserIds.map(async (userId) => {
          try {
            const userInfo = await slack.users.info({ user: userId });
            userCache.set(userId, userInfo.user.real_name || userInfo.user.name);
          } catch (e) {
            userCache.set(userId, userId);
          }
        }));
        
        const messageList = results.messages.matches
          .slice(0, limit)
          .map(msg => {
            const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
            const userName = userCache.get(msg.user) || 'Unknown';
            const channelName = msg.channel ? `#${msg.channel.name}` : 'DM';
            return `[${timestamp}] ${userName} in ${channelName}: ${msg.text}`;
          });
        
        return {
          content: [{
            type: "text",
            text: `🔍 Search results for "${query}" in ${searchLocation}:\n\n${messageList.join('\n\n')}\n\n*Found ${results.messages.total} total • Showing ${messageList.length} results*`
          }]
        };
      } catch (error) {
        console.error(`❌ Search messages failed:`, error.message);
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

  // Tool 4: Search user messages (messages FROM a specific user)
  server.registerTool(
    "slack_search_user_messages",
    {
      title: "Search User Messages",
      description: "Search for messages sent BY a specific user. Use search_users first to get the username.",
      inputSchema: {
        user_id: z.string().describe("User ID from search_users tool (e.g., U1234567)"),
        query: z.string().optional().describe("Optional: search within that user's messages").default(""),
        channel: z.string().optional().describe("Optional: limit to specific channel (#general) or leave empty for all channels"),
        limit: z.number().optional().describe("Number of results (max 20)").default(10)
      }
    },
    async ({ user_id, query = "", channel, limit = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // Validate user ID format
        if (!user_id.match(/^U[A-Z0-9]+$/)) {
          return {
            content: [{
              type: "text",
              text: `❌ Invalid user ID format: ${user_id}\n\nPlease use search_users first to get the correct user ID (format: U1234567)`
            }],
            isError: true
          };
        }
        
        // Get user info for display name and username
        let userName = user_id;
        let username = user_id;
        try {
          const userInfo = await slack.users.info({ user: user_id });
          userName = userInfo.user.real_name || userInfo.user.name;
          username = userInfo.user.name; // This is the @username we need
        } catch (e) {
          return {
            content: [{
              type: "text",
              text: `❌ User not found: ${user_id}\n\nPlease use search_users to find the correct user ID.`
            }],
            isError: true
          };
        }
        
        // Build search query using @username (more reliable than user ID)
        let searchQuery = `from:@${username}`;
        if (query.trim()) {
          searchQuery += ` ${query}`;
        }
        
        let searchLocation = "all channels";
        
        // Add channel filter if specified
        if (channel) {
          let targetChannel = channel;
          
          if (channel.startsWith('#')) {
            targetChannel = channel.substring(1);
            searchLocation = channel;
          } else if (channel.startsWith('C')) {
            targetChannel = channel;
            searchLocation = `channel ${channel}`;
          } else {
            return {
              content: [{
                type: "text",
                text: `❌ Invalid channel format: ${channel}\n\nUse #channelname or channel ID (C...)`
              }],
              isError: true
            };
          }
          
          searchQuery += ` in:${targetChannel}`;
        }
        
        console.log(`🔍 User message search query: "${searchQuery}"`);
        
        const results = await slack.search.messages({
          query: searchQuery,
          count: Math.min(limit, 20)
        });
        
        if (!results.messages || results.messages.total === 0) {
          const queryInfo = query ? ` containing "${query}"` : '';
          return {
            content: [{
              type: "text",
              text: `🔍 No messages found from ${userName} (@${username})${queryInfo} in ${searchLocation}`
            }]
          };
        }
        
        const messageList = results.messages.matches
          .slice(0, limit)
          .map(msg => {
            const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
            const channelName = msg.channel ? `#${msg.channel.name}` : 'DM';
            return `[${timestamp}] ${userName} in ${channelName}: ${msg.text}`;
          });
        
        const queryInfo = query ? ` containing "${query}"` : '';
        
        return {
          content: [{
            type: "text",
            text: `💬 Messages from ${userName} (@${username})${queryInfo} in ${searchLocation}:\n\n${messageList.join('\n\n')}\n\n*Found ${results.messages.total} total • Showing ${messageList.length} results*`
          }]
        };
      } catch (error) {
        console.error(`❌ Search user messages failed:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to search user messages: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 5: Get channels
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

  // Tool 6: Search users (simplified, focused)
  server.registerTool(
    "slack_search_users",
    {
      title: "Search Users",
      description: "Find users by name, username, or email. Returns user IDs needed for other tools.",
      inputSchema: {
        search: z.string().describe("Search term (name, username, or email)"),
        limit: z.number().optional().describe("Maximum results").default(10)
      }
    },
    async ({ search, limit = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // Get all users
        let allUsers = [];
        let cursor = null;
        
        do {
          const params = { limit: 200 };
          if (cursor) params.cursor = cursor;
          
          const users = await slack.users.list(params);
          allUsers = allUsers.concat(users.members || []);
          cursor = users.response_metadata?.next_cursor;
        } while (cursor);
        
        const searchLower = search.toLowerCase();
        
        // Score and filter matches
        const matches = allUsers
          .filter(user => !user.deleted && !user.is_bot)
          .map(user => {
            const realName = (user.real_name || '').toLowerCase();
            const username = (user.name || '').toLowerCase();
            const displayName = (user.profile?.display_name || '').toLowerCase();
            const email = (user.profile?.email || '').toLowerCase();
            
            let score = 0;
            if (username === searchLower || realName === searchLower) score = 100;
            else if (username.startsWith(searchLower) || realName.startsWith(searchLower)) score = 80;
            else if (username.includes(searchLower) || realName.includes(searchLower) || 
                     displayName.includes(searchLower) || email.includes(searchLower)) score = 40;
            
            return { user, score };
          })
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        
        if (matches.length === 0) {
          return {
            content: [{
              type: "text",
              text: `🔍 No users found matching "${search}"`
            }]
          };
        }
        
        const userList = matches.map(({ user }) => {
          const status = user.presence === 'active' ? '🟢' : '⚪';
          const realName = user.real_name || user.name;
          const email = user.profile?.email ? ` • ${user.profile.email}` : '';
          // Prominently display the user ID that other tools need
          return `${status} **${realName}** (@${user.name})${email}\n   **User ID:** \`${user.id}\``;
        }).join('\n\n');
        
        return {
          content: [{
            type: "text",
            text: `🔍 Users matching "${search}":\n\n${userList}\n\n*${matches.length} results • 🟢=Active ⚪=Away*\n\n**Use the User ID (e.g., \`${matches[0].user.id}\`) with other tools for DMs and message searches.**`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to search users: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 7: React to latest message in channel or DM
  server.registerTool(
    "slack_react_to_latest",
    {
      title: "React to Latest Message",
      description: "Add a reaction to the most recent message in a channel or DM",
      inputSchema: {
        channel: z.string().describe("Channel ID, channel name (#channel), user ID (U123...), or username (@user) for DMs"),
        name: z.string().describe("Emoji name without colons (e.g., 'thumbsup', 'heart', 'fire', 'tada')"),
        exclude_self: z.boolean().optional().describe("Skip your own messages").default(true)
      }
    },
    async ({ channel, name, exclude_self = true }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        let channelId = channel;
        let resolvedTarget = channel;
        let isDM = false;
        
        // Handle different channel formats
        if (channel.startsWith('@')) {
          // Remove @ and resolve user
          const user = await resolveUser(slack, channel);
          isDM = true;
          const dmResult = await slack.conversations.open({ users: user.id });
          channelId = dmResult.channel.id;
          resolvedTarget = `DM with ${user.name}`;
        }
        else if (channel.match(/^U[A-Z0-9]+$/)) {
          // Direct user ID
          try {
            const userInfo = await slack.users.info({ user: channel });
            const userName = userInfo.user.real_name || userInfo.user.name;
            isDM = true;
            const dmResult = await slack.conversations.open({ users: channel });
            channelId = dmResult.channel.id;
            resolvedTarget = `DM with ${userName}`;
          } catch (e) {
            throw new Error(`Invalid user ID: ${channel}`);
          }
        }
        else if (channel.startsWith('#')) {
          channelId = channel.substring(1);
          resolvedTarget = channel;
        }
        // Otherwise assume it's already a channel ID
        
        // Get recent messages
        const messages = await slack.conversations.history({
          channel: channelId,
          limit: 10
        });
        
        if (!messages.messages || messages.messages.length === 0) {
          return {
            content: [{
              type: "text",
              text: `❌ No messages found in ${resolvedTarget}`
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
              text: `❌ No suitable message found in ${resolvedTarget} (excluding your own messages)`
            }],
            isError: true
          };
        }
        
        // Add reaction to the message
        await slack.reactions.add({
          channel: channelId,
          timestamp: targetMessage.ts,
          name: name.replace(/:/g, '')
        });
        
        console.log(`👍 Reaction :${name}: added by ${tokenData.user_name} to latest message in ${resolvedTarget}`);
        
        // Get user name for the message author
        let authorName = targetMessage.user;
        try {
          const userInfo = await slack.users.info({ user: targetMessage.user });
          authorName = userInfo.user.real_name || userInfo.user.name;
        } catch (e) {
          // Keep original user ID if lookup fails
        }
        
        const conversationType = isDM ? "DM" : "Channel";
        
        return {
          content: [{
            type: "text",
            text: `✅ Added :${name}: reaction to latest message!\n\n${conversationType}: ${resolvedTarget}\nMessage author: ${authorName}\nMessage preview: "${(targetMessage.text || '').substring(0, 100)}${targetMessage.text && targetMessage.text.length > 100 ? '...' : ''}"\nReaction: :${name}:\nAdded by: ${tokenData.user_name}`
          }]
        };
      } catch (error) {
        console.error(`❌ React to latest failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to react to latest message: ${error.message}\n\nTip: For DMs, make sure the user exists and you have permission to message them.`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 8: List files
  server.registerTool(
    "slack_list_files",
    {
      title: "List Files",
      description: "List files uploaded to workspace with filtering",
      inputSchema: {
        channel: z.string().optional().describe("Optional: filter by channel (#general) or user (@john.doe)"),
        types: z.string().optional().describe("Optional: file types (images,pdfs,docs,videos)"),
        count: z.number().optional().describe("Number of files (max 50)").default(20)
      }
    },
    async ({ channel, types, count = 20 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        const params = {
          count: Math.min(count, 50),
          page: 1
        };
        
        // Add channel filter if provided
        if (channel) {
          if (channel.startsWith('@') || (!channel.startsWith('#') && !channel.startsWith('C'))) {
            const user = await resolveUser(slack, channel);
            params.user = user.id;
          } else if (channel.startsWith('#')) {
            params.channel = channel.substring(1);
          }
        }
        
        if (types) {
          params.types = types;
        }
        
        const result = await slack.files.list(params);
        
        if (!result.files || result.files.length === 0) {
          const location = channel ? ` in ${channel}` : '';
          return {
            content: [{
              type: "text",
              text: `📁 No files found${location}`
            }]
          };
        }
        
        // Build user cache for efficient lookups
        const userCache = new Map();
        const uniqueUserIds = [...new Set(result.files.map(f => f.user).filter(Boolean))];
        
        await Promise.all(uniqueUserIds.map(async (userId) => {
          try {
            const userInfo = await slack.users.info({ user: userId });
            userCache.set(userId, userInfo.user.real_name || userInfo.user.name);
          } catch (e) {
            userCache.set(userId, userId);
          }
        }));
        
        const fileList = result.files.map(file => {
          const size = file.size ? `${Math.round(file.size / 1024)}KB` : '?KB';
          const date = new Date(file.timestamp * 1000).toLocaleDateString();
          const uploader = userCache.get(file.user) || 'Unknown';
          const comments = file.comments_count > 0 ? ` • ${file.comments_count} comments` : '';
          
          return `📄 **${file.name}** (${file.filetype.toUpperCase()}, ${size})
   • ID: ${file.id} • ${date} by ${uploader}${comments}`;
        });
        
        return {
          content: [{
            type: "text",
            text: `📁 Files (${result.files.length}):\n\n${fileList.join('\n\n')}\n\n*Use file ID with other file tools*`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to list files: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 9: Get file content
  server.registerTool(
    "slack_get_file",
    {
      title: "Get File",
      description: "Get file details and content (for text files)",
      inputSchema: {
        file_id: z.string().describe("File ID from file list")
      }
    },
    async ({ file_id }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        const fileInfo = await slack.files.info({ file: file_id });
        
        if (!fileInfo.file) {
          return {
            content: [{
              type: "text",
              text: `❌ File not found: ${file_id}`
            }],
            isError: true
          };
        }
        
        const file = fileInfo.file;
        const size = file.size ? `${Math.round(file.size / 1024)}KB` : 'Unknown';
        const date = new Date(file.timestamp * 1000).toLocaleString();
        
        // Get uploader name
        let uploader = file.user;
        try {
          const userInfo = await slack.users.info({ user: file.user });
          uploader = userInfo.user.real_name || userInfo.user.name;
        } catch (e) {
          // Keep user ID if lookup fails
        }
        
        let response = `📄 **${file.name}**

**Details:**
• Type: ${file.filetype.toUpperCase()} (${file.mimetype || 'unknown'})
• Size: ${size}
• Uploaded: ${date} by ${uploader}
• Comments: ${file.comments_count || 0}`;

        if (file.title) response += `\n• Title: ${file.title}`;
        
        // For text files, try to get content
        if (file.mimetype?.startsWith('text/') && file.url_private) {
          try {
            const contentResponse = await fetch(file.url_private, {
              headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });
            
            if (contentResponse.ok) {
              const content = await contentResponse.text();
              const truncated = content.length > 2000;
              response += `\n\n**📝 Content:**\n\`\`\`\n${content.substring(0, 2000)}${truncated ? '\n... (truncated)' : ''}\n\`\`\``;
            }
          } catch (e) {
            response += `\n\n**Note:** Could not retrieve content: ${e.message}`;
          }
        } else if (file.url_private) {
          response += `\n\n**Download:** ${file.url_private}`;
        }
        
        return {
          content: [{
            type: "text",
            text: response
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get file: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 10: Search files
  server.registerTool(
    "slack_search_files",
    {
      title: "Search Files", 
      description: "Search files by name or content",
      inputSchema: {
        query: z.string().describe("Search terms (filename or content)"),
        count: z.number().optional().describe("Number of results (max 20)").default(10)
      }
    },
    async ({ query, count = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        const result = await slack.search.files({
          query: query,
          count: Math.min(count, 20)
        });
        
        if (!result.files || result.files.total === 0) {
          return {
            content: [{
              type: "text",
              text: `🔍 No files found for: "${query}"`
            }]
          };
        }
        
        // Build user cache
        const userCache = new Map();
        const uniqueUserIds = [...new Set(result.files.matches.map(f => f.user).filter(Boolean))];
        
        await Promise.all(uniqueUserIds.map(async (userId) => {
          try {
            const userInfo = await slack.users.info({ user: userId });
            userCache.set(userId, userInfo.user.real_name || userInfo.user.name);
          } catch (e) {
            userCache.set(userId, userId);
          }
        }));
        
        const fileList = result.files.matches.slice(0, count).map(file => {
          const size = file.size ? `${Math.round(file.size / 1024)}KB` : '?KB';
          const date = new Date(file.timestamp * 1000).toLocaleDateString();
          const uploader = userCache.get(file.user) || 'Unknown';
          
          return `📄 **${file.name}** (${file.filetype.toUpperCase()}, ${size})
   • ID: ${file.id} • ${date} by ${uploader}`;
        });
        
        return {
          content: [{
            type: "text",
            text: `🔍 Files matching "${query}" (${result.files.total} total):\n\n${fileList.join('\n\n')}\n\n*Showing ${fileList.length} results*`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to search files: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 11: Get workspace info
  server.registerTool(
    "slack_get_workspace_info",
    {
      title: "Workspace Info",
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
            text: `🏢 **${teamInfo.team.name}** (${teamInfo.team.domain}.slack.com)

**Your Profile:**
• Name: ${userInfo.user.real_name || userInfo.user.name}
• Username: @${userInfo.user.name}
• Email: ${userInfo.user.profile.email || 'Not available'}
• Status: ${userInfo.user.presence || 'unknown'}

**MCP Connection:**
• Session: ${sessionId}
• Connected as: ${tokenData.user_name}
• Token created: ${tokenData.created_at}`
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
}
