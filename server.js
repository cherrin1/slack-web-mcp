import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { WebClient } from "@slack/web-api";
import crypto from "crypto";

const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const MCP_SECRET = process.env.MCP_SECRET || crypto.randomBytes(32).toString('hex');

// Base URL will be determined at runtime
let BASE_URL = process.env.BASE_URL || null;

// Validate required environment variables
if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
  console.error('❌ Missing required environment variables: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET');
  process.exit(1);
}

console.log('✅ Environment variables loaded:');
console.log('- SLACK_CLIENT_ID:', SLACK_CLIENT_ID ? '✓' : '✗');
console.log('- SLACK_CLIENT_SECRET:', SLACK_CLIENT_SECRET ? '✓' : '✗');
console.log('- BASE_URL:', BASE_URL || 'Will be determined at runtime');
console.log('- MCP_SECRET:', MCP_SECRET ? '✓' : '✗');

// In-memory storage (replace with database in production)
const userTokens = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function to get base URL
function getBaseUrl(req) {
  if (BASE_URL) {
    return BASE_URL;
  }
  
  // For Azure Container Apps, use the host header
  const protocol = req.get('x-forwarded-proto') || 'https';
  const host = req.get('host');
  return `${protocol}://${host}`;
}

// MCP Authorization endpoint for Claude
app.get('/authorize', (req, res) => {
  const { state, redirect_uri } = req.query;
  
  console.log('Claude authorization request:', { state, redirect_uri });
  
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
    return res.status(400).json({ error: 'OAuth error', details: error });
  }
  
  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }
  
  try {
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
    
    if (!data.ok) {
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// MCP Server discovery endpoint
app.get('/.well-known/mcp', (req, res) => {
  const baseUrl = getBaseUrl(req);
  
  res.json({
    version: "2024-11-05",
    capabilities: {
      tools: {}
    },
    serverInfo: {
      name: "slack-user-token-server",
      version: "1.0.0"
    }
  });
});

// Add a root MCP endpoint that handles all MCP traffic
app.post('/', express.json(), async (req, res) => {
  console.log('=== MCP Request on ROOT ===');
  console.log('Headers:', req.headers);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  const authHeader = req.headers.authorization;
  
  // For initialize requests without auth, we need to reject them to force OAuth
  if (req.body.method === 'initialize' && (!authHeader || !authHeader.startsWith('Bearer '))) {
    console.log('Initialize request without auth - rejecting to force OAuth');
    return res.status(401).json({
      jsonrpc: "2.0",
      id: req.body.id,
      error: {
        code: -32600,
        message: 'Authentication required. Please complete OAuth flow first.'
      }
    });
  }
  
  // For initialize requests with auth, proceed normally
  if (req.body.method === 'initialize') {
    console.log('Initialize request with auth - proceeding');
    return res.json({
      jsonrpc: "2.0",
      id: req.body.id,
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
    });
  }
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('Missing or invalid authorization header');
    return res.status(401).json({ 
      jsonrpc: "2.0",
      id: req.body.id,
      error: { code: -32600, message: 'Missing or invalid authorization header' }
    });
  }
  
  const token = authHeader.substring(7);
  console.log('Token:', token);
  
  // Look up the token mapping
  const tokenMapping = userTokens.get(token);
  
  if (!tokenMapping) {
    console.log('Token mapping not found');
    console.log('Available tokens:', Array.from(userTokens.keys()));
    return res.status(401).json({ 
      jsonrpc: "2.0",
      id: req.body.id,
      error: { code: -32600, message: 'Invalid token' }
    });
  }
  
  // Get the actual Slack token
  const slackTokenKey = `${tokenMapping.team_id}:${tokenMapping.user_id}`;
  const slackTokenData = userTokens.get(slackTokenKey);
  
  if (!slackTokenData) {
    console.log('Slack token not found for key:', slackTokenKey);
    return res.status(401).json({ 
      jsonrpc: "2.0",
      id: req.body.id,
      error: { code: -32600, message: 'Slack token not found' }
    });
  }
  
  console.log('Found Slack token for:', slackTokenData.team_name, slackTokenData.user_name);
  
  // Handle MCP protocol messages
  try {
    const { jsonrpc, id, method, params } = req.body;
    
    console.log('MCP Method:', method);
    
    switch (method) {
      case 'notifications/initialized':
        console.log('Notifications initialized - Claude should now call tools/list');
        // For notification methods, return empty response
        return res.status(200).send('');
        
      case 'tools/list':
        console.log('Returning tools list');
        return res.json({
          jsonrpc: "2.0",
          id: id,
          result: {
            tools: [
              {
                name: "slack_send_message",
                description: "Send a message to a Slack channel or user",
                inputSchema: {
                  type: "object",
                  properties: {
                    channel: { 
                      type: "string", 
                      description: "Channel name (e.g., #general) or user ID" 
                    },
                    text: { 
                      type: "string", 
                      description: "Message text to send" 
                    }
                  },
                  required: ["channel", "text"]
                }
              },
              {
                name: "slack_get_channels", 
                description: "Get list of channels you have access to",
                inputSchema: {
                  type: "object",
                  properties: {},
                  required: []
                }
              },
              {
                name: "slack_get_messages",
                description: "Get recent messages from a channel",
                inputSchema: {
                  type: "object",
                  properties: {
                    channel: { 
                      type: "string", 
                      description: "Channel name (e.g., #general) or channel ID" 
                    },
                    limit: { 
                      type: "number", 
                      description: "Number of messages to retrieve (default: 10, max: 100)",
                      default: 10
                    }
                  },
                  required: ["channel"]
                }
              }
            ]
          }
        });
        
      case 'tools/call':
        const { name, arguments: args } = params;
        
        console.log('Tool call:', name, args);
        
        const slack = new WebClient(slackTokenData.access_token);
        
        switch (name) {
          case 'slack_send_message':
            try {
              const result = await slack.chat.postMessage({
                channel: args.channel,
                text: args.text
              });
              
              return res.json({
                jsonrpc: "2.0",
                id: id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `✅ Message sent successfully to ${args.channel}!\n\nTimestamp: ${result.ts}\nChannel: ${result.channel}`
                    }
                  ]
                }
              });
            } catch (error) {
              console.error('Send message error:', error);
              return res.json({
                jsonrpc: "2.0",
                id: id,
                error: {
                  code: -32603,
                  message: `Failed to send message: ${error.message}`
                }
              });
            }
            
          case 'slack_get_channels':
            try {
              const channels = await slack.conversations.list({
                types: "public_channel,private_channel",
                limit: 100
              });
              
              const channelList = channels.channels
                .filter(ch => ch.is_member)
                .map(ch => `• #${ch.name} (${ch.is_private ? 'private' : 'public'})`)
                .join('\n');
              
              return res.json({
                jsonrpc: "2.0",
                id: id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `📋 Your Slack channels:\n\n${channelList}`
                    }
                  ]
                }
              });
            } catch (error) {
              console.error('Get channels error:', error);
              return res.json({
                jsonrpc: "2.0",
                id: id,
                error: {
                  code: -32603,
                  message: `Failed to get channels: ${error.message}`
                }
              });
            }
            
          case 'slack_get_messages':
            try {
              const messages = await slack.conversations.history({
                channel: args.channel,
                limit: Math.min(args.limit || 10, 100)
              });
              
              const messageList = messages.messages
                .slice(0, 10)
                .map(msg => {
                  const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
                  return `[${timestamp}] ${msg.user}: ${msg.text || '(no text)'}`;
                })
                .join('\n');
              
              return res.json({
                jsonrpc: "2.0",
                id: id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `💬 Recent messages from ${args.channel}:\n\n${messageList}`
                    }
                  ]
                }
              });
            } catch (error) {
              console.error('Get messages error:', error);
              return res.json({
                jsonrpc: "2.0",
                id: id,
                error: {
                  code: -32603,
                  message: `Failed to get messages: ${error.message}`
                }
              });
            }
            
          default:
            return res.json({
              jsonrpc: "2.0",
              id: id,
              error: {
                code: -32601,
                message: `Unknown tool: ${name}`
              }
            });
        }
        
      default:
        console.log('Unknown method called:', method);
        console.log('Available methods: initialize, notifications/initialized, tools/list, tools/call');
        return res.json({
          jsonrpc: "2.0",
          id: id,
          error: {
            code: -32601,
            message: `Unknown method: ${method}`
          }
        });
    }
  } catch (error) {
    console.error('MCP error:', error);
    return res.json({
      jsonrpc: "2.0",
      id: req.body.id,
      error: {
        code: -32603,
        message: `Internal error: ${error.message}`
      }
    });
  }
});

// MCP endpoint for Claude to connect to
app.post('/mcp', express.json(), async (req, res) => {
  console.log('=== MCP Request ===');
  console.log('Headers:', req.headers);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  
  const authHeader = req.headers.authorization;
  
  // For initialize requests, we might not have auth yet
  if (req.body.method === 'initialize') {
    console.log('Initialize request - no auth required');
    return res.json({
      jsonrpc: "2.0",
      id: req.body.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "slack-user-token-server",
          version: "1.0.0"
        }
      }
    });
  }
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('Missing or invalid authorization header');
    return res.status(401).json({ 
      jsonrpc: "2.0",
      id: req.body.id,
      error: { code: -32600, message: 'Missing or invalid authorization header' }
    });
  }
  
  const token = authHeader.substring(7);
  console.log('Token:', token);
  
  // Look up the token mapping
  const tokenMapping = userTokens.get(token);
  
  if (!tokenMapping) {
    console.log('Token mapping not found');
    return res.status(401).json({ 
      jsonrpc: "2.0",
      id: req.body.id,
      error: { code: -32600, message: 'Invalid token' }
    });
  }
  
  // Get the actual Slack token
  const slackTokenKey = `${tokenMapping.team_id}:${tokenMapping.user_id}`;
  const slackTokenData = userTokens.get(slackTokenKey);
  
  if (!slackTokenData) {
    console.log('Slack token not found for key:', slackTokenKey);
    return res.status(401).json({ 
      jsonrpc: "2.0",
      id: req.body.id,
      error: { code: -32600, message: 'Slack token not found' }
    });
  }
  
  console.log('Found Slack token for:', slackTokenData.team_name, slackTokenData.user_name);
  
  // Handle MCP protocol messages
  try {
    const { jsonrpc, id, method, params } = req.body;
    
    console.log('MCP Method:', method);
    
    switch (method) {
      case 'tools/list':
        console.log('Returning tools list');
        return res.json({
          jsonrpc: "2.0",
          id: id,
          result: {
            tools: [
              {
                name: "slack_send_message",
                description: "Send a message to a Slack channel or user",
                inputSchema: {
                  type: "object",
                  properties: {
                    channel: { 
                      type: "string", 
                      description: "Channel name (e.g., #general) or user ID" 
                    },
                    text: { 
                      type: "string", 
                      description: "Message text to send" 
                    }
                  },
                  required: ["channel", "text"]
                }
              },
              {
                name: "slack_get_channels", 
                description: "Get list of channels you have access to",
                inputSchema: {
                  type: "object",
                  properties: {},
                  required: []
                }
              },
              {
                name: "slack_get_messages",
                description: "Get recent messages from a channel",
                inputSchema: {
                  type: "object",
                  properties: {
                    channel: { 
                      type: "string", 
                      description: "Channel name (e.g., #general) or channel ID" 
                    },
                    limit: { 
                      type: "number", 
                      description: "Number of messages to retrieve (default: 10, max: 100)",
                      default: 10
                    }
                  },
                  required: ["channel"]
                }
              }
            ]
          }
        });
        
      case 'tools/call':
        const { name, arguments: args } = params;
        
        console.log('Tool call:', name, args);
        
        const slack = new WebClient(slackTokenData.access_token);
        
        switch (name) {
          case 'slack_send_message':
            try {
              const result = await slack.chat.postMessage({
                channel: args.channel,
                text: args.text
              });
              
              return res.json({
                jsonrpc: "2.0",
                id: id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `✅ Message sent successfully to ${args.channel}!\n\nTimestamp: ${result.ts}\nChannel: ${result.channel}`
                    }
                  ]
                }
              });
            } catch (error) {
              console.error('Send message error:', error);
              return res.json({
                jsonrpc: "2.0",
                id: id,
                error: {
                  code: -32603,
                  message: `Failed to send message: ${error.message}`
                }
              });
            }
            
          case 'slack_get_channels':
            try {
              const channels = await slack.conversations.list({
                types: "public_channel,private_channel",
                limit: 100
              });
              
              const channelList = channels.channels
                .filter(ch => ch.is_member)
                .map(ch => `• #${ch.name} (${ch.is_private ? 'private' : 'public'})`)
                .join('\n');
              
              return res.json({
                jsonrpc: "2.0",
                id: id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `📋 Your Slack channels:\n\n${channelList}`
                    }
                  ]
                }
              });
            } catch (error) {
              console.error('Get channels error:', error);
              return res.json({
                jsonrpc: "2.0",
                id: id,
                error: {
                  code: -32603,
                  message: `Failed to get channels: ${error.message}`
                }
              });
            }
            
          case 'slack_get_messages':
            try {
              const messages = await slack.conversations.history({
                channel: args.channel,
                limit: Math.min(args.limit || 10, 100)
              });
              
              const messageList = messages.messages
                .slice(0, 10)
                .map(msg => {
                  const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
                  return `[${timestamp}] ${msg.user}: ${msg.text || '(no text)'}`;
                })
                .join('\n');
              
              return res.json({
                jsonrpc: "2.0",
                id: id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: `💬 Recent messages from ${args.channel}:\n\n${messageList}`
                    }
                  ]
                }
              });
            } catch (error) {
              console.error('Get messages error:', error);
              return res.json({
                jsonrpc: "2.0",
                id: id,
                error: {
                  code: -32603,
                  message: `Failed to get messages: ${error.message}`
                }
              });
            }
            
          default:
            return res.json({
              jsonrpc: "2.0",
              id: id,
              error: {
                code: -32601,
                message: `Unknown tool: ${name}`
              }
            });
        }
        
      default:
        return res.json({
          jsonrpc: "2.0",
          id: id,
          error: {
            code: -32601,
            message: `Unknown method: ${method}`
          }
        });
    }
  } catch (error) {
    console.error('MCP error:', error);
    return res.json({
      jsonrpc: "2.0",
      id: req.body.id,
      error: {
        code: -32603,
        message: `Internal error: ${error.message}`
      }
    });
  }
});

// Info endpoint - shows current redirect URI
app.get('/info', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  res.json({
    app_name: 'Slack MCP Server',
    version: '1.0.0',
    base_url: baseUrl,
    oauth_url: `${baseUrl}/oauth/slack`,
    redirect_uri: redirectUri,
    health_url: `${baseUrl}/health`,
    instructions: {
      step1: 'Add this redirect URI to your Slack app settings',
      step2: `Visit ${baseUrl}/oauth/slack to authenticate`,
      step3: 'Use the MCP server with Claude'
    }
  });
});

// MCP Server setup
const server = new Server(
  {
    name: "slack-user-token-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper function to get Slack client
function getSlackClient(teamId, userId) {
  const tokenKey = `${teamId}:${userId}`;
  const tokenData = userTokens.get(tokenKey);
  
  if (!tokenData) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `No token found for team ${teamId} and user ${userId}. Please authenticate first.`
    );
  }
  
  return new WebClient(tokenData.access_token);
}

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "slack_send_message",
        description: "Send a message to a Slack channel or user",
        inputSchema: {
          type: "object",
          properties: {
            team_id: {
              type: "string",
              description: "Slack team/workspace ID"
            },
            user_id: {
              type: "string", 
              description: "Slack user ID (token owner)"
            },
            channel: {
              type: "string",
              description: "Channel ID or name (e.g., #general, @username, or channel ID)"
            },
            text: {
              type: "string",
              description: "Message text to send"
            },
            thread_ts: {
              type: "string",
              description: "Optional: Thread timestamp to reply to a thread"
            }
          },
          required: ["team_id", "user_id", "channel", "text"]
        }
      },
      {
        name: "slack_get_channels",
        description: "Get list of channels the user has access to",
        inputSchema: {
          type: "object",
          properties: {
            team_id: {
              type: "string",
              description: "Slack team/workspace ID"
            },
            user_id: {
              type: "string",
              description: "Slack user ID (token owner)"
            },
            types: {
              type: "string",
              description: "Comma-separated list of channel types (public_channel, private_channel, mpim, im)",
              default: "public_channel,private_channel"
            }
          },
          required: ["team_id", "user_id"]
        }
      },
      {
        name: "slack_get_messages",
        description: "Get messages from a channel",
        inputSchema: {
          type: "object",
          properties: {
            team_id: {
              type: "string",
              description: "Slack team/workspace ID"
            },
            user_id: {
              type: "string",
              description: "Slack user ID (token owner)"
            },
            channel: {
              type: "string",
              description: "Channel ID"
            },
            limit: {
              type: "number",
              description: "Number of messages to retrieve (max 1000)",
              default: 10
            },
            oldest: {
              type: "string",
              description: "Oldest timestamp to include"
            },
            latest: {
              type: "string", 
              description: "Latest timestamp to include"
            }
          },
          required: ["team_id", "user_id", "channel"]
        }
      },
      {
        name: "slack_search_messages",
        description: "Search for messages in the workspace",
        inputSchema: {
          type: "object",
          properties: {
            team_id: {
              type: "string",
              description: "Slack team/workspace ID"
            },
            user_id: {
              type: "string",
              description: "Slack user ID (token owner)"
            },
            query: {
              type: "string",
              description: "Search query"
            },
            sort: {
              type: "string",
              description: "Sort order (score, timestamp)",
              default: "score"
            },
            count: {
              type: "number",
              description: "Number of results to return",
              default: 20
            }
          },
          required: ["team_id", "user_id", "query"]
        }
      },
      {
        name: "slack_get_users",
        description: "Get list of users in the workspace",
        inputSchema: {
          type: "object",
          properties: {
            team_id: {
              type: "string",
              description: "Slack team/workspace ID"
            },
            user_id: {
              type: "string",
              description: "Slack user ID (token owner)"
            }
          },
          required: ["team_id", "user_id"]
        }
      }
    ]
  };
});

// Tool handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    const slack = getSlackClient(args.team_id, args.user_id);
    
    switch (name) {
      case "slack_send_message":
        const result = await slack.chat.postMessage({
          channel: args.channel,
          text: args.text,
          thread_ts: args.thread_ts
        });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message_ts: result.ts,
                channel: result.channel
              }, null, 2)
            }
          ]
        };
        
      case "slack_get_channels":
        const channels = await slack.conversations.list({
          types: args.types || "public_channel,private_channel"
        });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                channels: channels.channels.map(ch => ({
                  id: ch.id,
                  name: ch.name,
                  is_private: ch.is_private,
                  is_member: ch.is_member,
                  topic: ch.topic?.value,
                  purpose: ch.purpose?.value
                }))
              }, null, 2)
            }
          ]
        };
        
      case "slack_get_messages":
        const messages = await slack.conversations.history({
          channel: args.channel,
          limit: Math.min(args.limit || 10, 1000),
          oldest: args.oldest,
          latest: args.latest
        });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                messages: messages.messages.map(msg => ({
                  ts: msg.ts,
                  user: msg.user,
                  text: msg.text,
                  thread_ts: msg.thread_ts,
                  reply_count: msg.reply_count,
                  type: msg.type
                }))
              }, null, 2)
            }
          ]
        };
        
      case "slack_search_messages":
        const searchResult = await slack.search.messages({
          query: args.query,
          sort: args.sort || "score",
          count: args.count || 20
        });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                total: searchResult.messages.total,
                matches: searchResult.messages.matches.matches.map(match => ({
                  ts: match.ts,
                  user: match.user,
                  username: match.username,
                  text: match.text,
                  channel: match.channel,
                  permalink: match.permalink
                }))
              }, null, 2)
            }
          ]
        };
        
      case "slack_get_users":
        const users = await slack.users.list();
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                users: users.members.map(user => ({
                  id: user.id,
                  name: user.name,
                  real_name: user.real_name,
                  display_name: user.profile?.display_name,
                  email: user.profile?.email,
                  is_bot: user.is_bot,
                  deleted: user.deleted
                }))
              }, null, 2)
            }
          ]
        };
        
      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  } catch (error) {
    console.error(`Error in ${name}:`, error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to execute ${name}: ${error.message}`
    );
  }
});

// Start the Express server
app.listen(port, () => {
  console.log(`Slack MCP Server listening on port ${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log(`OAuth URL: http://localhost:${port}/oauth/slack`);
  console.log('');
  console.log('🚀 Server ready! When deployed, the OAuth URL will be:');
  console.log('   https://your-app-name.region.azurecontainerapps.io/oauth/slack');
  console.log('');
  console.log('📝 Remember to add this redirect URI to your Slack app:');
  console.log('   https://your-app-name.region.azurecontainerapps.io/oauth/callback');
});

// Start the MCP server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("Slack MCP Server running on stdio");
}

// Handle process termination
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await server.close();
  process.exit(0);
});

// Start MCP server if running directly
if (process.argv.includes('--mcp')) {
  runServer().catch(console.error);
}