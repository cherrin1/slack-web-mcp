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
  
  if (!state || !redirect_uri) {
    return res.status(400).json({ 
      error: 'Missing required parameters', 
      details: 'state and redirect_uri are required' 
    });
  }
  
  // For now, we'll redirect to Slack OAuth
  // In a production setup, you might want to show a page explaining the flow
  const baseUrl = getBaseUrl(req);
  const slackOAuthUrl = `${baseUrl}/oauth/slack?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirect_uri)}`;
  
  res.redirect(slackOAuthUrl);
});

// MCP Token endpoint for Claude
app.post('/token', express.json(), (req, res) => {
  const { code, state } = req.body;
  
  if (!code) {
    return res.status(400).json({ 
      error: 'invalid_request', 
      error_description: 'Missing authorization code' 
    });
  }
  
  // In a real implementation, you'd validate the code and return an access token
  // For now, we'll return a simple token that includes the MCP secret
  const accessToken = `mcp_${MCP_SECRET}_${Date.now()}`;
  
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
  
  const state = crypto.randomBytes(16).toString('hex');
  
  // Updated scopes - these are the correct user token scopes
  const scopes = [
    'channels:history',
    'channels:read',
    'chat:write',
    'groups:history',
    'groups:read',
    'im:history',
    'im:read',
    'im:write',
    'mpim:history',
    'mpim:read',
    'search:read',
    'users:read'
  ].join(',');
  
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&scope=${scopes}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  const { code, state, error } = req.query;
  
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
        redirect_uri: redirectUri, // Use the same redirect URI
      }),
    });
    
    const data = await response.json();
    
    if (!data.ok) {
      return res.status(400).json({ error: 'OAuth token exchange failed', details: data.error });
    }
    
    // Store the token (replace with proper database storage)
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
    
    res.json({ 
      success: true, 
      message: 'Successfully authenticated with Slack',
      team: data.team.name,
      user: data.authed_user.name || 'Unknown',
      redirect_uri_used: redirectUri
    });
    
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
    mcp_version: "1.0",
    server: {
      name: "slack-user-token-server",
      version: "1.0.0"
    },
    endpoints: {
      authorize: `${baseUrl}/authorize`,
      token: `${baseUrl}/token`,
      mcp: `${baseUrl}/mcp`
    },
    capabilities: {
      tools: true,
      resources: false,
      prompts: false
    }
  });
});

// MCP endpoint for Claude to connect to
app.post('/mcp', express.json(), async (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  
  const token = authHeader.substring(7);
  
  // Validate the token (in production, you'd verify this properly)
  if (!token.startsWith('mcp_')) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  // Handle MCP protocol messages
  try {
    const { method, params } = req.body;
    
    // This is a simplified MCP handler - in production you'd use the full MCP SDK
    switch (method) {
      case 'tools/list':
        return res.json({
          tools: [
            {
              name: "slack_send_message",
              description: "Send a message to a Slack channel or user"
            },
            {
              name: "slack_get_channels", 
              description: "Get list of channels"
            },
            {
              name: "slack_get_messages",
              description: "Get messages from a channel"
            }
          ]
        });
        
      case 'tools/call':
        // Handle tool calls - you'd implement the actual Slack API calls here
        return res.json({
          content: [
            {
              type: "text",
              text: "Tool call received - implement actual Slack API integration"
            }
          ]
        });
        
      default:
        return res.status(400).json({ error: 'Unknown method' });
    }
  } catch (error) {
    console.error('MCP error:', error);
    return res.status(500).json({ error: 'Internal server error' });
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
                matches: searchResult.messages.matches.map(match => ({
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