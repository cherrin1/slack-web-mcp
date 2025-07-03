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

  async testAuth() { return await this.makeRequest('auth.test'); }
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

// Routes
app.get('/', (req, res) => {
  console.log('GET / - Root endpoint called');
  res.json({
    name: "slack-mcp-server",
    version: "2.0.0",
    description: "Clean Slack MCP Server for Claude",
    status: "running"
  });
});

// MCP Protocol Handler
app.post('/', async (req, res) => {
  console.log('POST / - MCP Request:', req.body?.method);
  
  const { method, params, id } = req.body || {};

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'slack-mcp-server', version: '2.0.0' }
        },
        id: id
      });
    }

    if (method === 'notifications/initialized') {
      return res.status(200).send();
    }

    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        result: {
          tools: [
            {
              name: 'slack_get_channels',
              description: 'List Slack channels',
              inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 100 } } }
            },
            {
              name: 'slack_get_history',
              description: 'Get channel message history',
              inputSchema: {
                type: 'object',
                properties: { channel: { type: 'string' }, limit: { type: 'number', default: 50 } },
                required: ['channel']
              }
            },
            {
              name: 'slack_send_message',
              description: 'Send message to channel',
              inputSchema: {
                type: 'object',
                properties: { channel: { type: 'string' }, text: { type: 'string' } },
                required: ['channel', 'text']
              }
            }
          ]
        },
        id: id
      });
    }

    if (method === 'tools/call') {
      const authHeader = req.headers.authorization;
      const token = authHeader?.replace('Bearer ', '');
      
      if (!token || !token.startsWith('xoxp-') || !tokens.has(token)) {
        return res.json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Authentication required',
            data: { connectUrl: `https://${req.get('host')}/connect` }
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
            result = { content: [{ type: 'text', text: `Channels: ${channels.channels.map(c => c.name).join(', ')}` }] };
            break;
          case 'slack_get_history':
            const history = await slack.getChannelHistory(args.channel, args?.limit);
            result = { content: [{ type: 'text', text: `Messages: ${history.messages.length} found` }] };
            break;
          case 'slack_send_message':
            await slack.sendMessage(args.channel, args.text);
            result = { content: [{ type: 'text', text: 'Message sent successfully' }] };
            break;
          default:
            result = { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }
        return res.json({ jsonrpc: '2.0', result: result, id: id });
      } catch (error) {
        return res.json({
          jsonrpc: '2.0',
          result: { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true },
          id: id
        });
      }
    }

    return res.json({
      jsonrpc: '2.0',
      error: { code: -32601, message: `Unknown method: ${method}` },
      id: id
    });

  } catch (error) {
    return res.json({
      jsonrpc: '2.0',
      error: { code: -32603, message: error.message },
      id: id
    });
  }
});

// Connect page
app.get('/connect', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>Connect Slack</title></head>
<body style="font-family: Arial; max-width: 500px; margin: 50px auto; padding: 20px;">
  <h1>Connect Slack to Claude</h1>
  <form id="form">
    <input type="text" id="token" placeholder="xoxp-your-slack-token" style="width: 100%; padding: 10px; margin: 10px 0;">
    <button type="submit" style="width: 100%; padding: 12px; background: #007cba; color: white; border: none;">Connect</button>
  </form>
  <div id="status" style="margin: 10px 0; padding: 10px; display: none;"></div>
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
        
        status.style.display = 'block';
        if (data.success) {
          status.style.background = '#d4edda';
          status.textContent = '✅ Connected! Return to Claude.';
        } else {
          status.style.background = '#f8d7da';
          status.textContent = '❌ ' + data.error;
        }
      } catch (error) {
        status.style.display = 'block';
        status.style.background = '#f8d7da';
        status.textContent = '❌ Error: ' + error.message;
      }
    });
  </script>
</body>
</html>`);
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
    res.json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 CLEAN SERVER v2.0.0 running on port ${PORT}`);
  console.log(`📱 Connect at: /connect`);
  console.log(`🔗 MCP endpoint: /`);
});