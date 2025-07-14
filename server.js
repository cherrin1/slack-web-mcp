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

// In-memory storage (replace with database in production)
const userTokens = new Map();
const mcpTransports = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function to get base URL
function getBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || 'https';
  const host = req.get('host');
  return `${protocol}://${host}`;
}

// Helper function to get Slack client
function getSlackClient(teamId, userId) {
  const tokenKey = `${teamId}:${userId}`;
  const tokenData = userTokens.get(tokenKey);
  
  if (!tokenData) {
    throw new Error(`No token found for team ${teamId} and user ${userId}. Please authenticate first.`);
  }
  
  return new WebClient(tokenData.access_token);
}

// Create MCP server instance
function createMCPServer(tokenData) {
  const server = new McpServer({
    name: "slack-user-token-server",
    version: "1.0.0"
  });

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
        
        return {
          content: [{
            type: "text",
            text: `✅ Message sent successfully to ${channel}!\n\nTimestamp: ${result.ts}\nChannel: ${result.channel}`
          }]
        };
      } catch (error) {
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
        
        return {
          content: [{
            type: "text",
            text: `✅ Direct message sent to ${user}!\n\nTimestamp: ${result.ts}\nChannel: ${result.channel}`
          }]
        };
      } catch (error) {
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

  // Tool 3: Get channels (enhanced)
  server.registerTool(
    "slack_get_channels",
    {
      title: "Get Slack Channels",
      description: "Get list of channels the user has access to",
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
            text: `📋 Available channels:\n\n${channelList}`
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
      description: "Get list of users in the workspace",
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
            return `• ${statusIcon} ${realName} (@${user.name}) - ${user.id}`;
          })
          .join('\n');
        
        return {
          content: [{
            type: "text",
            text: `👥 Workspace users:\n\n${userList}`
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

  // Tool 5: Get workspace info
  server.registerTool(
    "slack_get_workspace_info",
    {
      title: "Get Workspace Info",
      description: "Get information about the current workspace",
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
            text: `🏢 Workspace Information:

**Workspace:** ${teamInfo.team.name}
**Domain:** ${teamInfo.team.domain}.slack.com
**ID:** ${teamInfo.team.id}

**Your Profile:**
**Name:** ${userInfo.user.real_name || userInfo.user.name}
**Username:** @${userInfo.user.name}
**Email:** ${userInfo.user.profile.email || 'Not available'}
**Title:** ${userInfo.user.profile.title || 'Not set'}
**Status:** ${userInfo.user.presence || 'unknown'}

**Token Permissions:**
${tokenData.scope || 'channels:read, chat:write, users:read, etc.'}`
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

  // Tool 6: Get messages (enhanced)
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
            text: `💬 Recent messages from ${channel}:\n\n${messageList.join('\n')}`
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
      description: "Search for messages across the workspace",
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
              text: `🔍 No messages found for query: "${query}"`
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
            text: `🔍 Search results for "${query}":\n\n${messageList}`
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
**Status Emoji:** ${profile.status_emoji || 'None'}`
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

**Creator:** ${ch.creator || 'Unknown'}`
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

  return server;
}

// Get the appropriate user token data for MCP requests
function getUserTokenData(authToken) {
  const tokenMapping = userTokens.get(authToken);
  if (!tokenMapping) {
    return null;
  }
  
  const tokenKey = `${tokenMapping.team_id}:${tokenMapping.user_id}`;
  return userTokens.get(tokenKey);
}

// MCP Token endpoint for Claude
app.post('/token', express.json(), (req, res) => {
  const { code, state } = req.body;
  
  console.log('Token request from Claude:', { code: !!code, state });
  
  if (!code) {
    return res.status(400).json({ 
      error: 'invalid_request', 
      error_description: 'Missing authorization code' 
    });
  }
  
  // Look up the stored auth mapping
  const authMapping = userTokens.get(`claude_auth_${code}`);
  
  if (!authMapping) {
    return res.status(400).json({ 
      error: 'invalid_grant', 
      error_description: 'Authorization code not found or expired' 
    });
  }
  
  // Clean up the auth code
  userTokens.delete(`claude_auth_${code}`);
  
  // Create a longer-lived access token for Claude
  const accessToken = `mcp_${authMapping.team_id}_${authMapping.user_id}_${Date.now()}`;
  
  // Store the mapping between MCP token and Slack credentials
  userTokens.set(accessToken, {
    team_id: authMapping.team_id,
    user_id: authMapping.user_id,
    created_at: new Date().toISOString()
  });
  
  console.log('Issued MCP token for Claude:', accessToken);
  
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'slack:read slack:write'
  });
});

// Alternative: Skip OAuth for Claude web - use pre-authenticated tokens
app.get('/simple-auth', async (req, res) => {
  // For Claude web, provide a simplified authentication flow
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  const state = 'claude-web-' + crypto.randomBytes(16).toString('hex');
  const scopes = 'channels:read chat:write users:read';
  
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&user_scope=${encodeURIComponent(scopes)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Slack MCP Server Authentication</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
        .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .button { display: inline-block; padding: 12px 24px; background: #4A154B; color: white; text-decoration: none; border-radius: 5px; margin: 10px; }
        .step { margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 5px; text-align: left; }
        .code { background: #e9ecef; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔐 Slack MCP Server Setup</h1>
        <p>Follow these steps to connect your Slack account to Claude:</p>
        
        <div class="step">
          <strong>Step 1:</strong> Authenticate with Slack
          <br><br>
          <a href="${authUrl}" class="button">🔗 Connect to Slack</a>
        </div>
        
        <div class="step">
          <strong>Step 2:</strong> Configure Claude
          <br><br>
          After authenticating, use this URL in Claude:
          <br><code class="code">${baseUrl}/mcp</code>
        </div>
        
        <div class="step">
          <strong>Step 3:</strong> Test the connection
          <br><br>
          In Claude, try: "List my Slack channels"
        </div>
        
        <p><strong>Server Status:</strong> 
          <span style="color: green;">✅ Online</span> | 
          <span style="color: ${userTokens.size > 0 ? 'green' : 'orange'};">
            ${userTokens.size > 0 ? '✅ Authenticated' : '⏳ Waiting for auth'}
          </span>
        </p>
      </div>
    </body>
    </html>
  `);
});

// MCP Authorization endpoint for Claude
app.get('/authorize', (req, res) => {
  const { state, redirect_uri } = req.query;
  
  if (!state || !redirect_uri) {
    return res.status(400).json({ 
      error: 'Missing required parameters', 
      details: 'state and redirect_uri are required' 
    });
  }
  
  // Store Claude's redirect info to use after Slack auth
  const authSession = {
    claude_state: state,
    claude_redirect_uri: redirect_uri,
    timestamp: Date.now()
  };
  
  // Store session (in production, use proper session storage)
  const sessionKey = crypto.randomBytes(16).toString('hex');
  userTokens.set(`auth_${sessionKey}`, authSession);
  
  // Redirect to Slack OAuth with session key
  const baseUrl = getBaseUrl(req);
  const slackOAuthUrl = `${baseUrl}/oauth/slack?auth_session=${sessionKey}`;
  
  console.log('Redirecting to Slack OAuth:', slackOAuthUrl);
  res.redirect(slackOAuthUrl);
});

// OAuth endpoints
app.get('/oauth/slack', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  console.log('OAuth request - Base URL:', baseUrl);
  console.log('OAuth request - Redirect URI:', redirectUri);
  
  // Get auth session from query params
  const authSession = req.query.auth_session;
  
  const state = authSession || crypto.randomBytes(16).toString('hex');
  const scopes = 'channels:read chat:write users:read';
  
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&user_scope=${encodeURIComponent(scopes)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  console.log('Auth URL:', authUrl);
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
    
    // Store the token
    const userId = data.authed_user.id;
    const teamId = data.team.id;
    const tokenKey = `${teamId}:${userId}`;
    
    userTokens.set(tokenKey, {
      access_token: data.authed_user.access_token,
      team_id: teamId,
      user_id: userId,
      team_name: data.team.name,
      user_name: data.authed_user.name || 'Unknown',
      created_at: new Date().toISOString()
    });
    
    console.log('Slack token stored for:', tokenKey);
    
    // Check if this was initiated from Claude
    const authSession = userTokens.get(`auth_${state}`);
    
    if (authSession) {
      // This was initiated from Claude - redirect back to Claude
      console.log('Redirecting back to Claude:', authSession.claude_redirect_uri);
      
      // Clean up the session
      userTokens.delete(`auth_${state}`);
      
      // Create an authorization code for Claude
      const claudeAuthCode = crypto.randomBytes(32).toString('hex');
      
      // Store the mapping between auth code and user token
      userTokens.set(`claude_auth_${claudeAuthCode}`, {
        team_id: teamId,
        user_id: userId,
        created_at: new Date().toISOString()
      });
      
      // Redirect back to Claude with authorization code
      const claudeCallbackUrl = `${authSession.claude_redirect_uri}?code=${claudeAuthCode}&state=${authSession.claude_state}`;
      
      console.log('Redirecting back to Claude with callback URL:', claudeCallbackUrl);
      
      // Instead of a direct redirect, show a success page with auto-redirect
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Authentication Successful</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
            .container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .success { color: #28a745; font-size: 18px; margin-bottom: 20px; }
            .info { color: #666; margin-bottom: 20px; }
            .button { display: inline-block; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
            .spinner { border: 2px solid #f3f3f3; border-top: 2px solid #007bff; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 20px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Authentication Successful!</h1>
            <div class="success">Your Slack account has been connected successfully.</div>
            <div class="info">
              <strong>Team:</strong> ${data.team.name}<br>
              <strong>User:</strong> ${data.authed_user.name || 'Unknown'}<br>
              <strong>Team ID:</strong> ${teamId}<br>
              <strong>User ID:</strong> ${userId}
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
        team: data.team.name,
        user: data.authed_user.name || 'Unknown',
        team_id: teamId,
        user_id: userId,
        next_step: 'You can now connect this server to Claude using the MCP endpoint'
      });
    }
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Debug endpoint to test tools without MCP protocol
app.get('/debug/tools', async (req, res) => {
  try {
    // Get first available Slack token
    const availableTokens = Array.from(userTokens.entries())
      .filter(([key, value]) => key.includes(':') && value.access_token);
    
    if (availableTokens.length === 0) {
      return res.json({
        error: 'No Slack tokens available',
        message: 'Please authenticate via /oauth/slack first'
      });
    }
    
    const tokenData = availableTokens[0][1];
    
    // Show all 9 tools
    const tools = [
      { name: "slack_send_message", description: "Send a message to a Slack channel or user" },
      { name: "slack_send_dm", description: "Send a direct message to a specific user" },
      { name: "slack_get_channels", description: "Get list of channels the user has access to" },
      { name: "slack_get_users", description: "Get list of users in the workspace" },
      { name: "slack_get_workspace_info", description: "Get information about the current workspace" },
      { name: "slack_get_messages", description: "Get messages from a channel or DM" },
      { name: "slack_search_messages", description: "Search for messages across the workspace" },
      { name: "slack_get_user_info", description: "Get detailed information about a specific user" },
      { name: "slack_get_channel_info", description: "Get detailed information about a specific channel" }
    ];
    
    res.json({
      success: true,
      tools_count: tools.length,
      tools: tools,
      token_info: {
        team_id: tokenData.team_id,
        user_id: tokenData.user_id,
        team_name: tokenData.team_name
      }
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    tokens_stored: userTokens.size,
    active_sessions: mcpTransports.size
  });
});

// Info endpoint
app.get('/info', (req, res) => {
  const baseUrl = getBaseUrl(req);
  
  res.json({
    app_name: 'Slack MCP Server',
    version: '1.0.0',
    base_url: baseUrl,
    status: 'online',
    authentication: {
      tokens_stored: userTokens.size,
      active_sessions: mcpTransports.size,
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
      health_check: `${baseUrl}/health`,
      debug_tools: `${baseUrl}/debug/tools`
    },
    instructions: {
      for_claude_web: [
        "1. Visit /simple-auth to authenticate with Slack",
        "2. Add this server to Claude using the /mcp endpoint",
        "3. Test with: 'List my Slack channels'"
      ],
      for_claude_desktop: [
        "1. Use the /oauth/slack endpoint for full OAuth flow",
        "2. Configure Claude Desktop to use /mcp endpoint",
        "3. Enjoy full MCP integration"
      ]
    }
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

// MCP endpoint for Claude remote connections
app.post('/mcp', async (req, res) => {
  console.log('📡 MCP request received:', req.body?.method || 'unknown');
  
  try {
    const sessionId = req.headers['mcp-session-id'] || randomUUID();
    let transport = mcpTransports.get(sessionId);
    
    // Handle initialize request without authentication
    if (req.body?.method === 'initialize') {
      console.log('🚀 Initialize request - creating new transport');
      
      if (!transport) {
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
        };
        
        mcpTransports.set(sessionId, transport);
        
        // For initialize, we need to check if we have any Slack tokens available
        // Use the first available token for now (in production, you'd want better user mapping)
        const availableTokens = Array.from(userTokens.entries())
          .filter(([key, value]) => key.includes(':') && value.access_token);
        
        if (availableTokens.length === 0) {
          console.log('❌ No Slack tokens available - user needs to authenticate first');
          return res.status(401).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'No Slack authentication found. Please authenticate via /oauth/slack first.'
            },
            id: req.body?.id || null
          });
        }
        
        // Use the first available token
        const tokenData = availableTokens[0][1];
        console.log('✅ Using Slack token for team:', tokenData.team_id, 'user:', tokenData.user_id);
        
        // Create MCP server with the user's token
        const mcpServer = createMCPServer(tokenData);
        
        // Connect server to transport
        await mcpServer.connect(transport);
        
        console.log('✅ MCP server connected for session:', sessionId);
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
  } catch (error) {
    console.error('❌ MCP DELETE error:', error);
    res.status(500).send('Internal server error');
  }
});

// Start the Express server
app.listen(port, () => {
  console.log(`🚀 Slack MCP Server listening on port ${port}`);
  console.log(`❤️ Health check: http://localhost:${port}/health`);
  console.log(`📝 Info: http://localhost:${port}/info`);
  console.log(`🔐 OAuth: http://localhost:${port}/oauth/slack`);
  console.log(`🔌 MCP Endpoint: http://localhost:${port}/mcp`);
});

// Handle process termination
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  
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