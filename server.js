const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory storage
const users = new Map();
const tokens = new Map();
const oauthCodes = new Map();

// Simple SlackClient
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
  async getChannels(types = 'public_channel', limit = 100) { return await this.makeRequest('conversations.list', { types, limit }); }
  async getChannelHistory(channel, limit = 50) { return await this.makeRequest('conversations.history', { channel, limit }); }
  async sendMessage(channel, text, options = {}) { return await this.makeRequest('chat.postMessage', { channel, text, ...options }, 'POST'); }
  async getUsers(limit = 100) { return await this.makeRequest('users.list', { limit }); }
}

// Authentication
async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  let slackToken = null;
  if (authHeader && authHeader.startsWith('Bearer xoxp-')) {
    slackToken = authHeader.substring(7);
  }
  if (!slackToken || !slackToken.startsWith('xoxp-')) return null;
  try {
    await new SlackClient(slackToken).testAuth();
    return slackToken;
  } catch { return null; }
}

// Main routes
app.get('/', (req, res) => {
  res.json({
    name: "Slack MCP Server",
    version: "1.0.0",
    description: "Connect your Slack workspace to Claude",
    capabilities: { tools: true },
    status: "running"
  });
});

app.get('/connect', (req, res) => {
  const html = `<!DOCTYPE html>
<html><head><title>Connect Slack to Claude</title><style>
body{font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f5f5f5}
.container{background:white;padding:30px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.1)}
.form-group{margin-bottom:15px}
label{display:block;margin-bottom:5px;font-weight:bold;color:#333}
input{width:100%;padding:10px;border:1px solid #ddd;border-radius:5px;font-size:16px}
button{background:#007cba;color:white;padding:12px 24px;border:none;border-radius:5px;cursor:pointer;font-size:16px;width:100%}
button:hover{background:#005a8b}
.status{margin-top:15px;padding:12px;border-radius:5px;display:none}
.success{background:#d4edda;color:#155724}
.error{background:#f8d7da;color:#721c24}
h1{color:#333;text-align:center}
</style></head>
<body><div class="container">
<h1>🚀 Connect Slack to Claude</h1>
<form id="form">
<div class="form-group"><label for="token">Slack User Token *</label>
<input type="text" id="token" placeholder="xoxp-..." required></div>
<div class="form-group"><label for="name">Your Name (Optional)</label>
<input type="text" id="name" placeholder="John Doe"></div>
<button type="submit">Connect to Claude</button>
</form><div class="status" id="status"></div></div>
<script>
document.getElementById('form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const status = document.getElementById('status');
  const token = document.getElementById('token').value.trim();
  const name = document.getElementById('name').value.trim();
  if (!token.startsWith('xoxp-')) {
    status.className = 'status error';
    status.textContent = 'Invalid token format';
    status.style.display = 'block';
    return;
  }
  try {
    const response = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slackToken: token, userInfo: { name: name || 'User' } })
    });
    const data = await response.json();
    if (data.success) {
      status.className = 'status success';
      status.textContent = '✅ Successfully connected!';
    } else {
      status.className = 'status error';
      status.textContent = '❌ ' + (data.error || 'Failed');
    }
    status.style.display = 'block';
  } catch (error) {
    status.className = 'status error';
    status.textContent = '❌ Network error';
    status.style.display = 'block';
  }
});
</script></body></html>`;
  res.send(html);
});

app.post('/register', async (req, res) => {
  const { slackToken, userInfo = {} } = req.body;
  if (!slackToken || !slackToken.startsWith('xoxp-')) {
    return res.status(400).json({ error: 'Valid Slack token required' });
  }
  try {
    const slackClient = new SlackClient(slackToken);
    const authTest = await slackClient.testAuth();
    const userId = 'usr_' + Date.now();
    const userData = { id: userId, slackToken, userInfo: { ...userInfo, slackUserId: authTest.user_id }, active: true };
    users.set(userId, userData);
    tokens.set(slackToken, userId);
    return res.json({ success: true, message: 'Successfully registered', userId });
  } catch (error) {
    return res.status(400).json({ error: 'Registration failed', message: error.message });
  }
});

// OAuth endpoints for Claude Web
app.get('/oauth/config', (req, res) => {
  const baseUrl = `https://${req.get('host')}`;
  res.json({
    client_id: "slack-mcp-claude-web",
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    scope: "slack:read slack:write"
  });
});

app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state } = req.query;
  const authCode = 'claude_web_' + Date.now();
  const baseUrl = `https://${req.get('host')}`;
  const connectUrl = `${baseUrl}/connect?oauth=true&client=claude-web&auth_code=${authCode}&redirect_uri=${redirect_uri}&state=${state}`;
  res.redirect(connectUrl);
});

app.post('/oauth/token', (req, res) => {
  console.log('OAuth token request:', req.body);
  console.log('Headers:', req.headers);
  
  const { grant_type, code, client_id, redirect_uri } = req.body;
  
  // More lenient validation
  if (!grant_type) {
    return res.status(400).json({ 
      error: 'invalid_request',
      error_description: 'grant_type is required'
    });
  }
  
  if (!code) {
    return res.status(400).json({ 
      error: 'invalid_request',
      error_description: 'code is required'
    });
  }
});  
  // Rest of the code stays the same...

app.post('/oauth/store-token', (req, res) => {
  const { authCode, token } = req.body;
  if (authCode && token) {
    oauthCodes.set(authCode, token);
  }
  res.json({ success: true });
});

// MCP Protocol
app.post('/', async (req, res) => {
  const slackToken = await authenticateRequest(req);
  if (!slackToken) return res.status(401).json({ error: 'Authentication required' });
  
  const slackClient = new SlackClient(slackToken);
  const { method, params } = req.body || {};

  try {
    switch (method) {
      case 'initialize':
        return res.json({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'slack-mcp-server', version: '1.0.0' } });
      
      case 'tools/list':
        return res.json({ tools: [
          { name: 'slack_get_channels', description: 'List channels', inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 100 } } } },
          { name: 'slack_get_channel_history', description: 'Get channel messages', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number', default: 50 } }, required: ['channel'] } },
          { name: 'slack_send_message', description: 'Send message', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } }
        ]});
      
      case 'tools/call':
        const { name, arguments: args } = params;
        switch (name) {
          case 'slack_get_channels':
            const channelsData = await slackClient.getChannels('public_channel', args.limit || 100);
            return res.json({ content: [{ type: 'text', text: `Found ${channelsData.channels.length} channels:\n\n` + channelsData.channels.map(ch => `#${ch.name} (${ch.num_members} members)`).join('\n') }] });
          
          case 'slack_get_channel_history':
            const historyData = await slackClient.getChannelHistory(args.channel, args.limit || 50);
            const messages = historyData.messages.slice(0, 10).map(msg => `${new Date(parseFloat(msg.ts) * 1000).toLocaleString()}: ${msg.text || 'No text'}`);
            return res.json({ content: [{ type: 'text', text: `Recent messages in ${args.channel}:\n\n${messages.join('\n')}` }] });
          
          case 'slack_send_message':
            await slackClient.sendMessage(args.channel, args.text);
            return res.json({ content: [{ type: 'text', text: `✅ Message sent to ${args.channel}` }] });
          
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      
      default:
        return res.status(400).json({ error: `Unknown method: ${method}` });
    }
  } catch (error) {
    return res.json({ content: [{ type: 'text', text: `❌ Error: ${error.message}` }], isError: true });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server running on port ${PORT}`);
  console.log(`📱 Connect at: http://localhost:${PORT}/connect`);
  console.log(`🔗 Server ready for Claude Web integration`);
});