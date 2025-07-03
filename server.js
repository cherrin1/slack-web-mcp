const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage
const tokens = new Map();
const users = new Map();

// Simple Slack Client
class SlackClient {
  constructor(token) {
    this.token = token;
  }

  async makeRequest(endpoint, params = {}, method = 'GET') {
    const url = new URL(`https://slack.com/api/${endpoint}`);
    const options = {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
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
      options.body = JSON.stringify(params);
    }

    const response = await fetch(url.toString(), options);
    const data = await response.json();
    
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    
    return data;
  }

  async testAuth() { 
    return await this.makeRequest('auth.test'); 
  }
  
  async getChannels(limit = 100) { 
    return await this.makeRequest('conversations.list', { 
      types: 'public_channel,private_channel', 
      limit 
    }); 
  }
  
  async getChannelHistory(channel, limit = 50) { 
    return await this.makeRequest('conversations.history', { channel, limit }); 
  }
  
  async sendMessage(channel, text) { 
    return await this.makeRequest('chat.postMessage', { channel, text }, 'POST'); 
  }
}

// Authentication helper
function getAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  
  const token = authHeader.replace('Bearer ', '');
  if (!token.startsWith('xoxp-')) return null;
  
  // Check if token is registered
  if (!tokens.has(token)) return null;
  
  return token;
}

// Routes
app.get('/', (req, res) => {
  console.log('GET / - Root endpoint called');
  res.json({
    name: "slack-mcp-server",
    version: "1.0.0",
    description: "Slack MCP Server for Claude",
    status: "running"
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    users: users.size,
    tokens: tokens.size
  });
});

// MCP Protocol Handler
app.post('/', async (req, res) => {
  console.log('POST / - MCP Request:', req.body?.method);
  
  const { method, params, id } = req.body || {};

  try {
    if (method === 'initialize') {
      console.log('Initialize request received');
      return res.json({
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
      });
    }

    if (method === 'notifications/initialized') {
      console.log('Notifications/initialized received');
      return res.status(200).send();
    }

    if (method === 'tools/list') {
      console.log('Tools/list request received');
      return res.json({
        jsonrpc: '2.0',
        result: {
          tools: [
            {
              name: 'slack_get_channels',
              description: 'List Slack channels',
              inputSchema: {
                type: 'object',
                properties: {
                  limit: { type: 'number', default: 100 }
                }
              }
            },
            {
              name: 'slack_get_history',
              description: 'Get channel message history',
              inputSchema: {
                type: 'object',
                properties: {
                  channel: { type: 'string' },
                  limit: { type: 'number', default: 50 }
                },
                required: ['channel']
              }
            },
            {
              name: 'slack_send_message',
              description: 'Send message to channel',
              inputSchema: {
                type: 'object',
                properties: {
                  channel: { type: 'string' },
                  text: { type: 'string' }
                },
                required: ['channel', 'text']
              }
            }
          ]
        },
        id: id
      });
    }

    if (method === 'tools/call') {
      console.log('Tools/call request:', params?.name);
      
      const token = getAuthToken(req);
      if (!token) {
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
      const slack = new SlackClient(token);
      
      try {
        let result;
        
        switch (name) {
          case 'slack_get_channels':
            const channels = await slack.getChannels(args?.limit);
            result = {
              content: [{
                type: 'text',
                text: `Found ${channels.channels.length} channels:\n\n` +
                      channels.channels.map(ch => `• #${ch.name} (${ch.id})`).join('\n')
              }]
            };
            break;

          case 'slack_get_history':
            const history = await slack.getChannelHistory(args.channel, args?.limit);
            result = {
              content: [{
                type: 'text',
                text: `Messages in ${args.channel}:\n\n` +
                      history.messages.slice(0, 10).map(msg => `• ${msg.user}: ${msg.text}`).join('\n')
              }]
            };
            break;

          case 'slack_send_message':
            await slack.sendMessage(args.channel, args.text);
            result = {
              content: [{
                type: 'text',
                text: `Message sent to ${args.channel}: "${args.text}"`
              }]
            };
            break;

          default:
            result = {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true
            };
        }

        return res.json({
          jsonrpc: '2.0',
          result: result,
          id: id
        });

      } catch (error) {
        console.error('Tool execution error:', error);
        return res.json({
          jsonrpc: '2.0',
          result: {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true
          },
          id: id
        });
      }
    }

    // Unknown method
    return res.json({
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: `Unknown method: ${method}`
      },
      id: id
    });

  } catch (error) {
    console.error('MCP handler error:', error);
    return res.json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: error.message
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
  <title>Connect Slack</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
    input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; }
    button { width: 100%; padding: 12px; background: #007cba; color: white; border: none; border-radius: 4px; cursor: pointer; }
    .status { margin: 10px 0; padding: 10px; border-radius: 4px; display: none; }
    .success { background: #d4edda; color: #155724; }
    .error { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <h1>Connect Slack to Claude</h1>
  <p>Get your token from <a href="https://api.slack.com/custom-integrations/legacy-tokens" target="_blank">Slack Legacy Tokens</a></p>
  
  <form id="form">
    <input type="text" id="token" placeholder="xoxp-your-slack-token" required>
    <button type="submit">Connect</button>
  </form>
  
  <div id="status" class="status"></div>

  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = document.getElementById('token').value;
      const status = document.getElementById('status');
      
      try {
        const response = await fetch('/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        
        const data = await response.json();
        
        if (data.success) {
          status.className = 'status success';
          status.textContent = '✅ Connected! Return to Claude to use tools.';
        } else {
          status.className = 'status error';
          status.textContent = '❌ ' + data.error;
        }
        status.style.display = 'block';
      } catch (error) {
        status.className = 'status error';
        status.textContent = '❌ Connection failed: ' + error.message;
        status.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
  
  res.send(html);
});

// Register endpoint
app.post('/register', async (req, res) => {
  const { token } = req.body;
  
  if (!token || !token.startsWith('xoxp-')) {
    return res.json({ error: 'Invalid token format' });
  }
  
  try {
    const slack = new SlackClient(token);
    const auth = await slack.testAuth();
    
    const userId = Date.now().toString();
    users.set(userId, { token, userId: auth.user_id });
    tokens.set(token, userId);
    
    console.log('User registered:', auth.user);
    res.json({ success: true });
  } catch (error) {
    console.error('Registration error:', error);
    res.json({ error: error.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Connect at: /connect`);
});