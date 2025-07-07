#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS for Claude with SSE support
app.use(cors({
  origin: ['https://claude.ai', 'https://playground.ai.cloudflare.com', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Cache-Control', 'Last-Event-ID'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage
const sessionTokens = new Map(); // sessionId -> slackToken
const activeSessions = new Map(); // sessionId -> session info

// Slack API client
class SlackClient {
  constructor(token) {
    this.token = token;
    this.baseUrl = 'https://slack.com/api';
  }

  async makeRequest(endpoint, params = {}, method = 'GET') {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    const options = {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': method === 'GET' ? 'application/json' : 'application/x-www-form-urlencoded',
      }
    };

    try {
      if (method === 'GET') {
        Object.keys(params).forEach(key => {
          if (params[key] !== undefined) {
            url.searchParams.append(key, params[key]);
          }
        });
      } else {
        options.method = method;
        const formData = new URLSearchParams();
        Object.keys(params).forEach(key => {
          if (params[key] !== undefined) {
            formData.append(key, params[key]);
          }
        });
        options.body = formData.toString();
      }

      const response = await fetch(url.toString(), options);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      if (!data.ok) {
        throw new Error(`Slack API error: ${data.error || 'Unknown error'}`);
      }
      
      return data;
    } catch (error) {
      console.error(`Slack API request failed for ${endpoint}:`, error.message);
      throw error;
    }
  }

  async testAuth() { return await this.makeRequest('auth.test'); }
  async getChannels(types = 'public_channel,private_channel', limit = 100) { 
    return await this.makeRequest('conversations.list', { types, limit }); 
  }
  async getChannelHistory(channel, limit = 50) { 
    return await this.makeRequest('conversations.history', { channel, limit }); 
  }
  async sendMessage(channel, text, options = {}) { 
    return await this.makeRequest('chat.postMessage', { channel, text, ...options }, 'POST'); 
  }
  async getUsers(limit = 100) { 
    return await this.makeRequest('users.list', { limit }); 
  }
  async getChannelInfo(channel) {
    return await this.makeRequest('conversations.info', { channel });
  }
  async getUserInfo(user) {
    return await this.makeRequest('users.info', { user });
  }
}

// Create MCP server instance
const mcpServer = new Server(
  {
    name: 'slack-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Configure MCP server handlers
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'slack_setup_token',
        description: 'Setup your Slack token to enable all Slack tools. Get your token from https://api.slack.com/custom-integrations/legacy-tokens',
        inputSchema: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              description: 'Your Slack user token (starts with xoxp-)'
            }
          },
          required: ['token']
        }
      },
      {
        name: 'slack_get_channels',
        description: 'List available Slack channels with detailed information',
        inputSchema: {
          type: 'object',
          properties: {
            types: {
              type: 'string',
              description: 'Channel types to include (public_channel,private_channel,mpim,im)',
              default: 'public_channel,private_channel'
            },
            limit: {
              type: 'number',
              description: 'Maximum number of channels to return',
              default: 100
            }
          }
        }
      },
      {
        name: 'slack_get_channel_history',
        description: 'Get recent messages from a specific Slack channel',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: 'Channel ID (e.g., C1234567890) or channel name (e.g., #general)'
            },
            limit: {
              type: 'number',
              description: 'Number of messages to retrieve',
              default: 20
            }
          },
          required: ['channel']
        }
      },
      {
        name: 'slack_send_message',
        description: 'Send a message to a Slack channel',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: 'Channel ID (e.g., C1234567890) or channel name (e.g., #general)'
            },
            text: {
              type: 'string',
              description: 'Message text to send'
            },
            thread_ts: {
              type: 'string',
              description: 'Thread timestamp to reply to a specific message'
            }
          },
          required: ['channel', 'text']
        }
      },
      {
        name: 'slack_get_users',
        description: 'List users in the Slack workspace',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Maximum number of users to return',
              default: 100
            }
          }
        }
      },
      {
        name: 'slack_get_channel_info',
        description: 'Get detailed information about a specific channel',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: 'Channel ID or name'
            }
          },
          required: ['channel']
        }
      }
    ]
  };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  
  // Get session ID from extra context
  const sessionId = extra?.meta?.sessionId;
  if (!sessionId) {
    throw new Error('No session ID found. Please establish a connection first.');
  }

  // Handle token setup
  if (name === 'slack_setup_token') {
    if (!args.token || !args.token.startsWith('xoxp-')) {
      return {
        content: [{
          type: 'text',
          text: '❌ Invalid token format. Please provide a valid Slack user token that starts with "xoxp-".\n\n**Get your token:**\n1. Go to https://api.slack.com/custom-integrations/legacy-tokens\n2. Generate a token for your workspace\n3. Copy the token and use it with this tool'
        }],
        isError: true
      };
    }

    try {
      // Test the token
      const slackClient = new SlackClient(args.token);
      const authTest = await slackClient.testAuth();
      
      // Store token for this session
      sessionTokens.set(sessionId, args.token);
      
      console.log('✅ Token setup for session:', sessionId, 'user:', authTest.user, 'team:', authTest.team);
      
      return {
        content: [{
          type: 'text',
          text: `✅ **Successfully connected to Slack!**\n\n**User:** ${authTest.user}\n**Team:** ${authTest.team}\n**URL:** ${authTest.url}\n\nYou can now use all Slack tools:\n• **slack_get_channels** - List your channels\n• **slack_send_message** - Send messages\n• **slack_get_channel_history** - Read channel messages\n• **slack_get_users** - List workspace users\n• **slack_get_channel_info** - Get channel details`
        }]
      };
    } catch (error) {
      console.error('❌ Token test failed:', error.message);
      return {
        content: [{
          type: 'text',
          text: `❌ **Failed to connect to Slack:** ${error.message}\n\nPlease check that:\n1. Your token is valid and starts with "xoxp-"\n2. You have the necessary permissions in your Slack workspace\n3. The token hasn't expired\n\n**Get a new token:** https://api.slack.com/custom-integrations/legacy-tokens`
        }],
        isError: true
      };
    }
  }

  // For all other tools, check if token is set
  const slackToken = sessionTokens.get(sessionId);
  if (!slackToken) {
    return {
      content: [{
        type: 'text',
        text: `❌ **No Slack token configured.**\n\nTo use ${name}, you need to set up your Slack token first.\n\n**Setup Steps:**\n1. Run the **slack_setup_token** tool\n2. Get your token from: https://api.slack.com/custom-integrations/legacy-tokens\n3. Enter your token when prompted\n\nAfter setup, all Slack tools will be available!`
      }]
    };
  }

  try {
    const slackClient = new SlackClient(slackToken);

    switch (name) {
      case 'slack_get_channels': {
        const channels = await slackClient.getChannels(
          args?.types || 'public_channel,private_channel',
          args?.limit || 100
        );

        const channelList = channels.channels.map(ch => {
          const memberCount = ch.num_members ? ` (${ch.num_members} members)` : '';
          const purpose = ch.purpose?.value || ch.topic?.value || 'No description';
          return `• **#${ch.name}** (${ch.id})${memberCount}\n  ${purpose}`;
        }).join('\n\n');

        return {
          content: [{
            type: 'text',
            text: `**Found ${channels.channels.length} channels:**\n\n${channelList}`
          }]
        };
      }

      case 'slack_get_channel_history': {
        const history = await slackClient.getChannelHistory(args.channel, args?.limit || 20);

        const userIds = [...new Set(history.messages.map(msg => msg.user).filter(Boolean))];
        const users = new Map();

        try {
          for (const userId of userIds.slice(0, 10)) {
            const userInfo = await slackClient.getUserInfo(userId);
            users.set(userId, userInfo.user.real_name || userInfo.user.name);
          }
        } catch (error) {
          console.log('Could not fetch user info:', error.message);
        }

        const messages = history.messages
          .reverse()
          .map(msg => {
            const userName = users.get(msg.user) || msg.user || 'Unknown';
            const timestamp = new Date(parseFloat(msg.ts) * 1000).toLocaleString();
            const text = msg.text || '[No text content]';
            return `**${userName}** (${timestamp})\n${text}`;
          })
          .join('\n\n---\n\n');

        return {
          content: [{
            type: 'text',
            text: `**Recent messages in ${args.channel}:**\n\n${messages}`
          }]
        };
      }

      case 'slack_send_message': {
        const sendResult = await slackClient.sendMessage(
          args.channel,
          args.text,
          args.thread_ts ? { thread_ts: args.thread_ts } : {}
        );

        return {
          content: [{
            type: 'text',
            text: `✅ **Message sent successfully!**\n\n**Channel:** ${args.channel}\n**Message ID:** ${sendResult.ts}\n**Text:** "${args.text}"`
          }]
        };
      }

      case 'slack_get_users': {
        const usersData = await slackClient.getUsers(args?.limit || 100);

        const userList = usersData.members
          .filter(user => !user.deleted && !user.is_bot)
          .map(user => {
            const status = user.presence === 'active' ? '🟢' : '⚫';
            const profile = user.profile || {};
            const title = profile.title ? ` - ${profile.title}` : '';
            return `${status} **${profile.real_name || user.name}** (@${user.name})${title}`;
          })
          .join('\n');

        return {
          content: [{
            type: 'text',
            text: `**Users in workspace:**\n\n${userList}`
          }]
        };
      }

      case 'slack_get_channel_info': {
        const channelInfo = await slackClient.getChannelInfo(args.channel);
        const channel = channelInfo.channel;

        const info = [
          `**Channel:** #${channel.name} (${channel.id})`,
          `**Type:** ${channel.is_private ? 'Private' : 'Public'} channel`,
          `**Members:** ${channel.num_members || 'Unknown'}`,
          `**Created:** ${new Date(channel.created * 1000).toLocaleDateString()}`,
          `**Purpose:** ${channel.purpose?.value || 'No purpose set'}`,
          `**Topic:** ${channel.topic?.value || 'No topic set'}`
        ].join('\n');

        return {
          content: [{
            type: 'text',
            text: `**Channel Information:**\n\n${info}`
          }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`❌ Tool ${name} failed:`, error.message);
    return {
      content: [{
        type: 'text',
        text: `❌ **Error executing ${name}:** ${error.message}\n\nIf this error persists, your Slack token may have expired or lost permissions. Try running **slack_setup_token** again with a fresh token.`
      }],
      isError: true
    };
  }
});

// Alternative: If you enter the base URL without /sse, redirect to SSE
app.get('/mcp', (req, res) => {
  console.log('🔄 MCP endpoint accessed - redirecting to SSE');
  res.redirect(307, '/sse');
});

// Server info endpoint with clear instructions
app.get('/', (req, res) => {
  const serverUrl = `https://${req.get('host')}`;
  res.json({
    name: "Slack MCP Server",
    version: "1.0.0",
    description: "Connect your Slack workspace to Claude via MCP - Simple manual token setup",
    status: "ready",
    endpoints: {
      sse: "/sse",
      health: "/health"
    },
    mcp: {
      server_url: `${serverUrl}/sse`,
      transport: "sse",
      authentication: "none"
    },
    instructions: [
      `1. Add this URL to Claude: ${serverUrl}/sse`,
      "2. Use 'slack_setup_token' tool with your Slack token",
      "3. Get token from: https://api.slack.com/custom-integrations/legacy-tokens"
    ]
  });
});

// Add debugging endpoint to check SSE
app.get('/debug', (req, res) => {
  res.json({
    activeSessions: Array.from(activeSessions.entries()).map(([id, session]) => ({
      id,
      startTime: session.startTime,
      connected: session.connected || false
    })),
    sessionTokens: Array.from(sessionTokens.keys()),
    serverInfo: {
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform
    }
  });
});

// Test endpoint to verify server is responding
app.get('/test', (req, res) => {
  res.json({
    message: 'Server is working!',
    timestamp: new Date().toISOString(),
    headers: req.headers
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
    sessionTokens: sessionTokens.size,
    connectedUsers: Array.from(sessionTokens.keys()).length
  });
});

// OAuth discovery endpoint - make everything point to SSE
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  console.log('🔄 OAuth discovery requested - pointing everything to SSE');
  const serverUrl = `https://${req.get('host')}`;
  
  // Tell Claude that ALL OAuth endpoints are actually the SSE endpoint
  res.json({
    issuer: serverUrl,
    authorization_endpoint: `${serverUrl}/sse`,
    token_endpoint: `${serverUrl}/sse`, 
    sse_endpoint: `${serverUrl}/sse`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp'],
    token_endpoint_auth_methods_supported: ['none'],
    // Add MCP-specific metadata
    mcp_transport: 'sse',
    mcp_endpoint: `${serverUrl}/sse`
  });
});

// All OAuth requests get handled by SSE endpoint
app.all('/authorize', (req, res) => {
  console.log('🔄 OAuth authorize - redirecting to SSE');
  res.redirect(307, '/sse');
});

app.all('/token', (req, res) => {
  console.log('🔄 OAuth token - redirecting to SSE');  
  res.redirect(307, '/sse');
});

// Store active transports to handle messages properly
const activeTransports = new Map(); // sessionId -> transport
const sessionRequests = new Map(); // track requests by session

// SSE endpoint for MCP connections
app.get('/sse', async (req, res) => {
  console.log('🔄 SSE MCP connection received from:', req.get('User-Agent') || 'unknown');
  console.log('🔍 Request headers:', req.headers);
  
  // Generate session ID
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  try {
    // Create SSE transport with the correct message endpoint
    console.log('🚀 Creating SSE transport for session:', sessionId);
    const transport = new SSEServerTransport('/messages', res);
    
    // Store both session info and transport
    activeSessions.set(sessionId, {
      id: sessionId,
      transport: transport,
      startTime: new Date(),
      connected: true
    });
    
    activeTransports.set(sessionId, transport);
    
    // Connect MCP server to this transport with session context
    console.log('🔗 Connecting MCP server to transport...');
    await mcpServer.connect(transport, {
      meta: { sessionId }
    });
    
    console.log('✅ MCP SSE connection established:', sessionId);
    
    // Handle disconnection
    req.on('close', () => {
      console.log('🔌 SSE connection closed:', sessionId);
      const session = activeSessions.get(sessionId);
      if (session) {
        session.connected = false;
      }
      activeSessions.delete(sessionId);
      activeTransports.delete(sessionId);
      sessionTokens.delete(sessionId);
    });
    
    req.on('error', (error) => {
      console.error('❌ SSE connection error:', sessionId, error.message);
      activeSessions.delete(sessionId);
      activeTransports.delete(sessionId);
      sessionTokens.delete(sessionId);
    });
    
  } catch (error) {
    console.error('❌ SSE setup error:', error);
    // Only send error response if headers haven't been sent
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to establish MCP connection',
        message: error.message,
        sessionId: sessionId
      });
    }
  }
});

// Add back POST handler for /messages - this is required for MCP SSE transport
app.post('/messages', async (req, res) => {
  console.log('📨 POST to /messages received:', req.body);
  console.log('📋 Headers:', req.headers);
  
  try {
    // The message should be handled by the MCP server through the transport
    // But we need to provide a proper endpoint for the client to post to
    
    // For now, let's acknowledge the message and let the SSE handle the response
    res.json({
      jsonrpc: "2.0",
      id: req.body.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          logging: {}
        },
        serverInfo: {
          name: "slack-mcp-server",
          version: "1.0.0"
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Message handling error:', error);
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body.id || null,
      error: {
        code: -32603,
        message: "Internal error",
        data: error.message
      }
    });
  }
});

// Also add POST handler for /sse endpoint
app.post('/sse', async (req, res) => {
  console.log('📨 POST to /sse received:', req.body);
  // Redirect POST requests to the messages endpoint
  res.redirect(307, '/messages');
});

// Also handle GET requests to /messages
app.get('/messages', (req, res) => {
  console.log('📬 GET to /messages received');
  res.json({
    endpoint: '/messages',
    description: 'MCP message endpoint handled by SSE transport',
    activeSessions: activeSessions.size,
    activeTransports: activeTransports.size
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server running on port ${PORT}`);
  console.log(`🔗 SSE endpoint: /sse`);
  console.log(`💡 Ready for Claude integration - manual token setup only`);
  console.log(`📊 Simple and reliable - no OAuth complexity`);
});