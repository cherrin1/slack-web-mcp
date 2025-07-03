const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage
const users = new Map();
const tokens = new Map();
const oauthCodes = new Map();

// Slack Client
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    return data;
  }

  async testAuth() { return await this.makeRequest('auth.test'); }
  async getChannels(types = 'public_channel', limit = 100) { 
    return await this.makeRequest('conversations.list', { types, limit }); 
  }
  async getChannelHistory(channel, limit = 50) { 
    return await this.makeRequest('conversations.history', { channel, limit }); 
  }
  async sendMessage(channel, text, options = {}) { 
    return await this.makeRequest('chat.postMessage', { channel, text, ...options }, 'POST'); 
  }
}

// Authentication helper
async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.log('🔍 No authorization header found');
    return null;
  }

  const token = authHeader.replace('Bearer ', '');
  if (!token || !token.startsWith('xoxp-')) {
    console.log('🔍 Invalid token format:', token.substring(0, 10) + '...');
    return null;
  }

  const userId = tokens.get(token);
  if (!userId) {
    console.log('🔍 Token not found in registered tokens');
    return null;
  }

  console.log('✅ Token authenticated for user:', userId);
  return token;
}

// FIXED: Root endpoint with proper MCP server info
app.get('/', (req, res) => {
  res.json({
    jsonrpc: '2.0',
    result: {
      name: "slack-mcp-server",
      version: "1.0.0",
      description: "Slack MCP Server for Claude integration",
      capabilities: {
        tools: {}
      }
    }
  });
});

// FIXED: MCP Protocol Handler
app.post('/', async (req, res) => {
  console.log('🔧 === MCP REQUEST ===');
  console.log('🔧 Method:', req.body?.method);
  console.log('🔧 Request ID:', req.body?.id);
  console.log('🔧 Auth Header:', req.headers.authorization ? 'Present' : 'Missing');
  
  const { method, params, id } = req.body || {};

  try {
    // Handle initialize
    if (method === 'initialize') {
      console.log('🔧 Initialize called');
      const response = {
        jsonrpc: '2.0',
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'slack-mcp-server',
            version: '1.0.0'
          }
        },
        id: id
      };
      console.log('🔧 Initialize response sent');
      return res.json(response);
    }

    // Handle notifications/initialized
    if (method === 'notifications/initialized') {
      console.log('🔧 Notifications/initialized received');
      return res.status(200).send();
    }

    // Handle tools/list - ALWAYS return tools
    if (method === 'tools/list') {
      console.log('🎉 TOOLS/LIST CALLED');
      
      const response = {
        jsonrpc: '2.0',
        result: {
          tools: [
            {
              name: 'slack_get_channels',
              description: 'List available Slack channels',
              inputSchema: {
                type: 'object',
                properties: {
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
              description: 'Get recent messages from a specific channel',
              inputSchema: {
                type: 'object',
                properties: {
                  channel: {
                    type: 'string',
                    description: 'Channel ID or name'
                  },
                  limit: {
                    type: 'number',
                    description: 'Number of messages to retrieve',
                    default: 50
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
                    description: 'Channel ID or name'
                  },
                  text: {
                    type: 'string',
                    description: 'Message text to send'
                  }
                },
                required: ['channel', 'text']
              }
            }
          ]
        },
        id: id
      };
      
      console.log('🎉 Returning', response.result.tools.length, 'tools');
      return res.json(response);
    }

    // Handle tools/call - require authentication
    if (method === 'tools/call') {
      console.log('🔧 Tool call received:', params?.name);
      
      const slackToken = await authenticateRequest(req);
      if (!slackToken) {
        console.log('❌ Authentication required');
        return res.json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Authentication required. Please connect your Slack workspace first.',
            data: {
              connectUrl: `https://${req.get('host')}/connect`
            }
          },
          id: id
        });
      }

      const { name, arguments: args } = params;
      const slackClient = new SlackClient(slackToken);
      let result;

      try {
        switch (name) {
          case 'slack_get_channels':
            const channels = await slackClient.getChannels('public_channel,private_channel', args?.limit || 100);
            result = {
              content: [{
                type: 'text',
                text: `Found ${channels.channels.length} channels:\n\n` +
                      channels.channels.map(ch => `• #${ch.name} (${ch.id})`).join('\n')
              }]
            };
            break;

          case 'slack_get_channel_history':
            const history = await slackClient.getChannelHistory(args.channel, args?.limit || 50);
            result = {
              content: [{
                type: 'text',
                text: `Recent messages in ${args.channel}:\n\n` +
                      history.messages.map(msg => `• ${msg.user}: ${msg.text}`).join('\n')
              }]
            };
            break;

          case 'slack_send_message':
            const sendResult = await slackClient.sendMessage(args.channel, args.text);
            result = {
              content: [{
                type: 'text',
                text: `Message sent successfully to ${args.channel}!`
              }]
            };
            break;

          default:
            result = {
              content: [{
                type: 'text',
                text: `Unknown tool: ${name}`
              }],
              isError: true
            };
        }
      } catch (error) {
        console.error('Tool execution error:', error);
        result = {
          content: [{
            type: 'text',
            text: `Error: ${error.message}`
          }],
          isError: true
        };
      }

      const response = {
        jsonrpc: '2.0',
        result: result,
        id: id
      };
      
      console.log('🔧 Tool call completed:', name);
      return res.json(response);
    }

    // Unknown method
    console.log('❌ Unknown method:', method);
    return res.json({
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      },
      id: id
    });

  } catch (error) {
    console.error('❌ MCP Error:', error);
    return res.json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: `Internal error: ${error.message}`
      },
      id: id
    });
  }
});

// Connect page
app.get('/connect', (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Connect Slack to Claude</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
    .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; }
    button { background: #007cba; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; }
    .status { margin-top: 15px; padding: 12px; border-radius: 5px; display: none; }
    .success { background: #d4edda; color: #155724; }
    .error { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Connect Slack to Claude</h1>
    <p>Get your Slack token from <a href="https://api.slack.com/custom-integrations/legacy-tokens" target="_blank">Slack Legacy Tokens</a></p>
    
    <form id="connectForm">
      <input type="text" id="token" placeholder="xoxp-your-slack-token-here" required>
      <input type="text" id="name" placeholder="Your Name (optional)">
      <button type="submit">Connect</button>
    </form>
    
    <div class="status" id="status"></div>
  </div>

  <script>
    document.getElementById('connectForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = document.getElementById('status');
      const token = document.getElementById('token').value.trim();
      const name = document.getElementById('name').value.trim();

      try {
        const response = await fetch('/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slackToken: token, userInfo: { name } })
        });

        const data = await response.json();
        
        if (data.success) {
          status.className = 'status success';
          status.textContent = '✅ Successfully connected! Return to Claude to use your tools.';
        } else {
          status.className = 'status error';
          status.textContent = '❌ ' + (data.error || 'Connection failed');
        }
        status.style.display = 'block';
      } catch (error) {
        status.className = 'status error';
        status.textContent = '❌ Network error: ' + error.message;
        status.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
  
  res.send(html);
});

// Registration endpoint
app.post('/register', async (req, res) => {
  const { slackToken, userInfo = {} } = req.body;
  console.log('📝 Registration attempt');
  
  if (!slackToken || !slackToken.startsWith('xoxp-')) {
    return res.status(400).json({ error: 'Valid Slack token required (must start with xoxp-)' });
  }
  
  try {
    const slackClient = new SlackClient(slackToken);
    const authTest = await slackClient.testAuth();
    console.log('✅ Slack auth test successful');
    
    const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(7);
    const userData = { 
      id: userId, 
      slackToken, 
      userInfo: { ...userInfo, slackUserId: authTest.user_id }, 
      active: true 
    };
    
    users.set(userId, userData);
    tokens.set(slackToken, userId);
    
    console.log('✅ User registered:', userId);
    return res.json({ success: true, userId });
  } catch (error) {
    console.error('❌ Registration failed:', error);
    return res.status(400).json({ error: 'Registration failed: ' + error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    users: users.size,
    tokens: tokens.size
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server running on port ${PORT}`);
  console.log(`📱 Connect at: https://your-domain.com/connect`);
  console.log(`🔗 MCP endpoint: https://your-domain.com/`);
});