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

  // Register Slack tools
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

  server.registerTool(
    "slack_get_channels",
    {
      title: "Get Slack Channels",
      description: "Get list of channels the user has access to",
      inputSchema: {}
    },
    async () => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const channels = await slack.conversations.list({
          types: "public_channel,private_channel",
          limit: 100
        });
        
        const channelList = channels.channels
          .filter(ch => ch.is_member)
          .map(ch => `• #${ch.name} (${ch.is_private ? 'private' : 'public'}) - ${ch.id}`)
          .join('\n');
        
        return {
          content: [{
            type: "text",
            text: `📋 Your Slack channels:\n\n${channelList}`
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

  server.registerTool(
    "slack_get_messages",
    {
      title: "Get Slack Messages",
      description: "Get messages from a channel",
      inputSchema: {
        channel: z.string().describe("Channel ID"),
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
        
        const messageList = messages.messages
          .slice(0, 10)
          .map(msg => {
            const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
            return `[${timestamp}] ${msg.user}: ${msg.text || '(no text)'}`;
          })
          .join('\n');
        
        return {
          content: [{
            type: "text",
            text: `💬 Recent messages from ${channel}:\n\n${messageList}`
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

  return server;
}

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
    const mcpServer = createMCPServer(tokenData);
    
    // Simulate tools/list request
    const tools = [
      {
        name: "slack_send_message",
        description: "Send a message to a Slack channel or user",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel ID or name" },
            text: { type: "string", description: "Message text" }
          },
          required: ["channel", "text"]
        }
      },
      {
        name: "slack_get_channels",
        description: "Get list of channels the user has access to",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "slack_get_messages",
        description: "Get messages from a channel",
        inputSchema: {
          type: "object",
          properties: {
            channel: { type: "string", description: "Channel ID" },
            limit: { type: "number", description: "Number of messages" }
          },
          required: ["channel"]
        }
      }
    ];
    
    res.json({
      success: true,
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
      health_check: `${baseUrl}/health`
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