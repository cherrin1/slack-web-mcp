#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Slack OAuth credentials (set these in Azure environment variables)
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `https://${process.env.WEBSITE_HOSTNAME || 'localhost:3000'}/authorize`;

// Enhanced CORS for Claude
app.use(cors({
  origin: ['https://claude.ai', 'https://playground.ai.cloudflare.com', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Cache-Control'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory token storage
const userTokens = new Map(); // sessionId -> slackToken
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

// OAuth helper function
async function exchangeCodeForToken(code) {
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    throw new Error('Slack OAuth credentials not configured');
  }

  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code: code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`OAuth error: ${data.error}`);
  }

  return data.authed_user.access_token;
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

  // Get user's Slack token
  const slackToken = userTokens.get(sessionId);
  if (!slackToken) {
    throw new Error('No Slack token found for this session. Please register your token first.');
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
            text: `Found ${channels.channels.length} channels:\n\n${channelList}`
          }]
        };
      }

      case 'slack_get_channel_history': {
        const history = await slackClient.getChannelHistory(args.channel, args?.limit || 20);

        // Get user info for better formatting
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
            text: `Recent messages in ${args.channel}:\n\n${messages}`
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
            text: `✅ Message sent successfully to ${args.channel}!\n` +
                  `Message timestamp: ${sendResult.ts}\n` +
                  `Channel: ${sendResult.channel}`
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
            text: `Users in workspace:\n\n${userList}`
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
            text: `Channel Information:\n\n${info}`
          }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error executing ${name}: ${error.message}`
      }],
      isError: true
    };
  }
});

// Server info endpoint
app.get('/', (req, res) => {
  res.json({
    name: "Slack MCP Server",
    version: "1.0.0",
    description: "Connect your Slack workspace to Claude via MCP",
    status: "ready",
    endpoints: {
      sse: "/sse",
      connect: "/connect",
      authorize: "/authorize",
      health: "/health"
    },
    instructions: "Use this server with mcp-remote: npx -y mcp-remote https://your-domain.com/sse"
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
    registeredTokens: userTokens.size
  });
});

// OAuth authorization endpoint
app.get('/authorize', async (req, res) => {
  const { code, state, error } = req.query;
  
  if (error) {
    return res.status(400).send(`
      <h1>❌ Authorization Failed</h1>
      <p>Error: ${error}</p>
      <p><a href="/connect">Try again</a></p>
    `);
  }
  
  if (!code) {
    return res.status(400).send(`
      <h1>❌ No Authorization Code</h1>
      <p>Missing authorization code from Slack</p>
      <p><a href="/connect">Start over</a></p>
    `);
  }
  
  try {
    // Exchange code for token
    const token = await exchangeCodeForToken(code);
    
    // Test the token
    const slackClient = new SlackClient(token);
    const authTest = await slackClient.testAuth();
    
    // Store token with session ID (from state parameter)
    const sessionId = state || 'default';
    userTokens.set(sessionId, token);
    
    console.log('✅ OAuth token registered for session:', sessionId, 'user:', authTest.user);
    
    res.send(`
      <h1>✅ Successfully Connected!</h1>
      <p>Welcome ${authTest.user} from ${authTest.team}!</p>
      <p>Your Slack workspace is now connected to Claude.</p>
      <script>window.close();</script>
    `);
  } catch (error) {
    console.error('❌ OAuth failed:', error.message);
    res.status(400).send(`
      <h1>❌ Connection Failed</h1>
      <p>Error: ${error.message}</p>
      <p><a href="/connect">Try again</a></p>
    `);
  }
});

// Token registration endpoint (legacy support)
app.post('/register', async (req, res) => {
  const { slackToken, sessionId } = req.body;
  
  if (!slackToken || !slackToken.startsWith('xoxp-')) {
    return res.status(400).json({ 
      success: false,
      error: 'Valid Slack token required (must start with xoxp-)' 
    });
  }
  
  if (!sessionId) {
    return res.status(400).json({ 
      success: false,
      error: 'Session ID required' 
    });
  }
  
  try {
    const slackClient = new SlackClient(slackToken);
    const authTest = await slackClient.testAuth();
    
    // Store token with session ID
    userTokens.set(sessionId, slackToken);
    
    console.log('✅ Token registered for session:', sessionId, 'user:', authTest.user);
    return res.json({ 
      success: true, 
      message: 'Successfully registered with Slack',
      user: authTest.user,
      team: authTest.team
    });
  } catch (error) {
    console.error('❌ Registration failed:', error.message);
    return res.status(400).json({ 
      success: false,
      error: 'Registration failed', 
      message: error.message 
    });
  }
});

// Connect page for token registration
app.get('/connect', (req, res) => {
  const serverUrl = `https://${req.get('host')}`;
  const sessionId = req.query.session || 'default';
  
  // OAuth URL (if credentials are configured)
  const oauthUrl = SLACK_CLIENT_ID ? 
    `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&scope=channels:history,channels:read,chat:write,groups:read,groups:history,im:history,im:read,im:write,mpim:history,mpim:read,search:read,users:read&user_scope=&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${sessionId}` 
    : null;
  
  const html = `<!DOCTYPE html>
<html>
<head>
    <title>Connect Slack to Claude</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        }
        .container { 
            background: white; padding: 40px; border-radius: 16px; 
            box-shadow: 0 20px 40px rgba(0,0,0,0.1); max-width: 600px; width: 100%;
        }
        h1 { color: #2d3748; margin-bottom: 8px; font-size: 28px; text-align: center; }
        .subtitle { color: #718096; text-align: center; margin-bottom: 32px; }
        .step { margin-bottom: 24px; }
        .step-number { 
            display: inline-block; width: 24px; height: 24px; 
            background: #667eea; color: white; border-radius: 50%; 
            text-align: center; line-height: 24px; font-size: 14px; font-weight: 600;
            margin-right: 8px;
        }
        .info-box { 
            background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; 
            padding: 16px; margin-bottom: 16px; font-size: 14px; line-height: 1.5;
        }
        .code-box { 
            background: #1a202c; color: #e2e8f0; padding: 12px; border-radius: 6px; 
            font-family: 'Monaco', 'Consolas', monospace; font-size: 14px; 
            word-break: break-all; margin: 8px 0; user-select: all;
        }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 600; color: #2d3748; }
        input { 
            width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px; 
            font-size: 16px; transition: border-color 0.2s;
        }
        input:focus { outline: none; border-color: #667eea; }
        button { 
            width: 100%; background: #667eea; color: white; padding: 14px; 
            border: none; border-radius: 8px; font-size: 16px; font-weight: 600; 
            cursor: pointer; transition: background-color 0.2s; margin-bottom: 10px;
        }
        button:hover { background: #5a67d8; }
        button:disabled { background: #a0aec0; cursor: not-allowed; }
        .oauth-btn { background: #4A154B; }
        .oauth-btn:hover { background: #611f69; }
        .status { 
            margin-top: 20px; padding: 12px; border-radius: 8px; display: none;
            font-weight: 500;
        }
        .success { background: #f0fff4; color: #22543d; border: 1px solid #68d391; }
        .error { background: #fed7d7; color: #c53030; border: 1px solid #fc8181; }
        .copy-btn { 
            background: #4a5568; color: white; padding: 6px 12px; font-size: 12px; 
            border: none; border-radius: 4px; cursor: pointer; margin-left: 8px;
        }
        .divider { text-align: center; margin: 20px 0; color: #718096; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Connect Slack to Claude</h1>
        <p class="subtitle">Set up your Slack workspace integration with Claude</p>
        
        <div class="step">
            <div><span class="step-number">1</span><strong>Add MCP Server to Claude</strong></div>
            <div class="info-box">
                Use this configuration in your MCP client:
                <div class="code-box">npx -y mcp-remote ${serverUrl}/sse<button class="copy-btn" onclick="copyToClipboard('npx -y mcp-remote ${serverUrl}/sse')">Copy</button></div>
                
                <strong>For Claude Desktop:</strong> Add to your <code>claude_desktop_config.json</code>:
                <div class="code-box">{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${serverUrl}/sse"]
    }
  }
}<button class="copy-btn" onclick="copyToClipboard('{\n  \"mcpServers\": {\n    \"slack\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"mcp-remote\", \"${serverUrl}/sse\"]\n    }\n  }\n}')">Copy</button></div>
            </div>
        </div>

        <div class="step">
            <div><span class="step-number">2</span><strong>Connect Your Slack Account</strong></div>
            
            ${oauthUrl ? `
            <button class="oauth-btn" onclick="window.open('${oauthUrl}', 'slack-oauth', 'width=600,height=700')">
                🔗 Connect with Slack OAuth (Recommended)
            </button>
            
            <div class="divider">— OR —</div>
            ` : ''}
            
            <div class="info-box">
                <strong>Manual Token Method:</strong><br>
                Visit <a href="https://api.slack.com/custom-integrations/legacy-tokens" target="_blank">Slack Legacy Tokens</a> 
                to generate your user token (starts with xoxp-).
            </div>
            
            <form id="registrationForm">
                <div class="form-group">
                    <label for="token">Slack User Token</label>
                    <input type="text" id="token" placeholder="xoxp-your-slack-token-here">
                </div>
                <input type="hidden" id="sessionId" value="${sessionId}">
                <button type="submit" id="submitBtn">Register Token</button>
            </form>
            <div class="status" id="status"></div>
        </div>
    </div>

    <script>
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                event.target.textContent = 'Copied!';
                setTimeout(() => {
                    event.target.textContent = 'Copy';
                }, 1000);
            });
        }

        document.getElementById('registrationForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const status = document.getElementById('status');
            const submitBtn = document.getElementById('submitBtn');
            const token = document.getElementById('token').value.trim();
            const sessionId = document.getElementById('sessionId').value;
            
            if (!token) {
                showStatus('error', 'Please enter a Slack token');
                return;
            }
            
            if (!token.startsWith('xoxp-')) {
                showStatus('error', 'Invalid token format. Must start with xoxp-');
                return;
            }
            
            submitBtn.disabled = true;
            submitBtn.textContent = 'Registering...';
            
            try {
                const response = await fetch('/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        slackToken: token,
                        sessionId: sessionId
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showStatus('success', 
                        \`✅ Successfully registered! Welcome \${data.user} from \${data.team}. ` +
                        `Your Slack workspace is now connected to Claude.\`);
                    document.getElementById('registrationForm').style.display = 'none';
                } else {
                    showStatus('error', '❌ ' + (data.error || 'Registration failed'));
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Register Token';
                }
            } catch (error) {
                showStatus('error', '❌ Network error: ' + error.message);
                submitBtn.disabled = false;
                submitBtn.textContent = 'Register Token';
            }
        });

        function showStatus(type, message) {
            const status = document.getElementById('status');
            status.className = \`status \${type}\`;
            status.textContent = message;
            status.style.display = 'block';
        }
    </script>
</body>
</html>`;
  
  res.send(html);
});

// SSE endpoint for MCP connections
app.get('/sse', async (req, res) => {
  console.log('🔄 SSE MCP connection received');
  
  // Generate session ID
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  try {
    // Create SSE transport
    const transport = new SSEServerTransport('/messages', res);
    
    // Store session info
    activeSessions.set(sessionId, {
      id: sessionId,
      transport: transport,
      startTime: new Date()
    });
    
    // Connect MCP server to this transport with session context
    await mcpServer.connect(transport, {
      meta: { sessionId }
    });
    
    console.log('✅ MCP SSE connection established:', sessionId);
    
    // Handle disconnection
    req.on('close', () => {
      console.log('🔌 SSE connection closed:', sessionId);
      activeSessions.delete(sessionId);
      userTokens.delete(sessionId);
    });
    
  } catch (error) {
    console.error('❌ SSE connection error:', error);
    res.status(500).json({ error: 'Failed to establish MCP connection' });
  }
});

// Handle POST messages for MCP (if needed)
app.post('/messages', (req, res) => {
  // This should be handled by the SSE transport
  res.status(404).json({ error: 'Use SSE endpoint for MCP connections' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server running on port ${PORT}`);
  console.log(`📱 Connect page: https://your-domain.com/connect`);
  console.log(`🔗 SSE endpoint: https://your-domain.com/sse`);
  console.log(`💡 Use with: npx -y mcp-remote https://your-domain.com/sse`);
  console.log(`📊 Ready for Claude integration`);
  
  if (SLACK_CLIENT_ID) {
    console.log(`🔐 OAuth enabled with redirect: ${REDIRECT_URI}`);
  } else {
    console.log(`⚠️  OAuth not configured - using legacy tokens only`);
  }
});