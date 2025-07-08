import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { WebClient } from "@slack/web-api";
import crypto from "crypto";
import { z } from "zod";

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

console.log('✅ Environment variables loaded:');
console.log('- SLACK_CLIENT_ID:', SLACK_CLIENT_ID ? '✓' : '✗');
console.log('- SLACK_CLIENT_SECRET:', SLACK_CLIENT_SECRET ? '✓' : '✗');
console.log('- MCP_SECRET:', MCP_SECRET ? '✓' : '✗');

// In-memory storage (replace with database in production)
const userTokens = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function to get base URL
function getBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || 'https';
  const host = req.get('host');
  return `${protocol}://${host}`;
}

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
  
  // User token scopes only - no bot scopes
  const scopes = 'channels:read chat:write users:read';
  
  console.log('Using scopes:', scopes);
  console.log('Client ID:', SLACK_CLIENT_ID);
  
  // Build OAuth URL with user_scope parameter (not scope)
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
      
      return res.redirect(claudeCallbackUrl);
    } else {
      // Direct Slack auth - show success message
      res.json({ 
        success: true, 
        message: 'Successfully authenticated with Slack',
        team: data.team.name,
        user: data.authed_user.name || 'Unknown',
        redirect_uri_used: redirectUri,
        team_id: teamId,
        user_id: userId
      });
    }
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
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

// Helper function to get Slack client
function getSlackClient(teamId, userId) {
  const tokenKey = `${teamId}:${userId}`;
  const tokenData = userTokens.get(tokenKey);
  
  if (!tokenData) {
    throw new Error(`No token found for team ${teamId} and user ${userId}. Please authenticate first.`);
  }
  
  return new WebClient(tokenData.access_token);
}

// Create MCP Server using the new SDK
const mcpServer = new McpServer({
  name: "slack-user-token-server",
  version: "1.0.0",
});

// Register tools using the new API
mcpServer.registerTool(
  "slack_send_message",
  {
    description: "Send a message to a Slack channel or user",
    inputSchema: {
      team_id: z.string().describe("Slack team/workspace ID"),
      user_id: z.string().describe("Slack user ID (token owner)"),
      channel: z.string().describe("Channel ID or name (e.g., #general, @username, or channel ID)"),
      text: z.string().describe("Message text to send")
    }
  },
  async ({ team_id, user_id, channel, text }) => {
    console.log('🛠️ Tool call: slack_send_message');
    
    const slack = getSlackClient(team_id, user_id);
    
    const result = await slack.chat.postMessage({
      channel: channel,
      text: text
    });
    
    return {
      content: [
        {
          type: "text",
          text: `✅ Message sent successfully to ${channel}!\n\nTimestamp: ${result.ts}\nChannel: ${result.channel}`
        }
      ]
    };
  }
);

mcpServer.registerTool(
  "slack_get_channels",
  {
    description: "Get list of channels the user has access to",
    inputSchema: {
      team_id: z.string().describe("Slack team/workspace ID"),
      user_id: z.string().describe("Slack user ID (token owner)")
    }
  },
  async ({ team_id, user_id }) => {
    console.log('🛠️ Tool call: slack_get_channels');
    
    const slack = getSlackClient(team_id, user_id);
    
    const channels = await slack.conversations.list({
      types: "public_channel,private_channel",
      limit: 100
    });
    
    const channelList = channels.channels
      .filter(ch => ch.is_member)
      .map(ch => `• #${ch.name} (${ch.is_private ? 'private' : 'public'})`)
      .join('\n');
    
    return {
      content: [
        {
          type: "text",
          text: `📋 Your Slack channels:\n\n${channelList}`
        }
      ]
    };
  }
);

mcpServer.registerTool(
  "slack_get_messages",
  {
    description: "Get messages from a channel",
    inputSchema: {
      team_id: z.string().describe("Slack team/workspace ID"),
      user_id: z.string().describe("Slack user ID (token owner)"),
      channel: z.string().describe("Channel ID"),
      limit: z.number().optional().describe("Number of messages to retrieve (max 100)")
    }
  },
  async ({ team_id, user_id, channel, limit = 10 }) => {
    console.log('🛠️ Tool call: slack_get_messages');
    
    const slack = getSlackClient(team_id, user_id);
    
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
      content: [
        {
          type: "text",
          text: `💬 Recent messages from ${channel}:\n\n${messageList}`
        }
      ]
    };
  }
);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    tokens_stored: userTokens.size
  });
});

// Info endpoint
app.get('/info', (req, res) => {
  const baseUrl = getBaseUrl(req);
  
  res.json({
    app_name: 'Slack MCP Server',
    version: '1.0.0',
    base_url: baseUrl,
    oauth_url: `${baseUrl}/oauth/slack`,
    redirect_uri: `${baseUrl}/oauth/callback`,
    authorize_url: `${baseUrl}/authorize`,
    health_url: `${baseUrl}/health`,
    tokens_stored: userTokens.size,
    instructions: {
      step1: 'Visit /oauth/slack to authenticate',
      step2: 'Use POST /slack/send to send messages',
      step3: 'Connect to Claude as MCP server'
    }
  });
});

// Start the Express server
app.listen(port, () => {
  console.log(`🚀 Slack MCP Server listening on port ${port}`);
  console.log(`❤️ Health check: http://localhost:${port}/health`);
  console.log(`📝 Info: http://localhost:${port}/info`);
  console.log(`🔐 OAuth: http://localhost:${port}/oauth/slack`);
});

// HTTP MCP endpoint for Claude remote connections
app.post('/', async (req, res) => {
  console.log('📡 MCP HTTP request received:', req.body?.method || 'unknown');
  
  const { jsonrpc, id, method, params } = req.body;

  // Handle initialize without auth
  if (method === 'initialize') {
    console.log('🚀 Initialize request received');
    const initResult = {
      jsonrpc: "2.0",
      id: id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: true
          }
        },
        serverInfo: {
          name: "slack-user-token-server",
          version: "1.0.0"
        }
      }
    };
    console.log('🚀 Initialize response:', JSON.stringify(initResult, null, 2));
    return res.json(initResult);
  }

  // Check authentication for other MCP requests
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      jsonrpc: "2.0",
      id: id,
      error: {
        code: -32600,
        message: "Authentication required"
      }
    });
  }

  const token = authHeader.substring(7);
  const tokenMapping = userTokens.get(token);
  
  if (!tokenMapping) {
    return res.status(401).json({
      jsonrpc: "2.0", 
      id: id,
      error: {
        code: -32600,
        message: "Invalid token"
      }
    });
  }

  console.log('✅ Authenticated MCP request:', method);

  try {
    // Handle MCP methods directly
    switch (method) {
      case 'notifications/initialized':
        console.log('📬 Notifications initialized');
        return res.status(200).send('');

      case 'tools/list':
        console.log('🔧 Tools list requested via HTTP');
        // Return the tools registered with mcpServer
        const tools = Array.from(mcpServer.getTools().values()).map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }));
        
        return res.json({
          jsonrpc: "2.0",
          id: id,
          result: { tools }
        });

      case 'tools/call':
        console.log('🛠️ Tool call via HTTP:', params?.name);
        
        if (!params?.name) {
          return res.json({
            jsonrpc: "2.0",
            id: id,
            error: {
              code: -32602,
              message: "Missing tool name"
            }
          });
        }
        
        // Call the tool using the mcpServer
        const tool = mcpServer.getTools().get(params.name);
        if (!tool) {
          return res.json({
            jsonrpc: "2.0",
            id: id,
            error: {
              code: -32601,
              message: `Tool not found: ${params.name}`
            }
          });
        }
        
        const result = await tool.handler(params.arguments || {});
        
        return res.json({
          jsonrpc: "2.0",
          id: id,
          result: result
        });

      default:
        return res.json({
          jsonrpc: "2.0",
          id: id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        });
    }
    
  } catch (error) {
    console.error('❌ MCP HTTP error:', error);
    return res.json({
      jsonrpc: "2.0",
      id: id,
      error: {
        code: -32603,
        message: error.message || "Internal error"
      }
    });
  }
});

// Handle process termination
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await mcpServer.close();
  process.exit(0);
});

// Only start MCP stdio server if explicitly requested
if (process.argv.includes('--mcp')) {
  async function runMCPServer() {
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.log("🔧 MCP Server running on stdio transport");
  }
  
  runMCPServer().catch(console.error);
}