// server.js - Simple container server for Azure
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Simple in-memory storage
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

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  async testAuth() {
    return await this.makeRequest('auth.test');
  }

  async getChannels(types = 'public_channel', limit = 100) {
    return await this.makeRequest('conversations.list', { types, limit });
  }

  async getChannelHistory(channel, limit = 50) {
    return await this.makeRequest('conversations.history', { channel, limit });
  }

  async sendMessage(channel, text, options = {}) {
    return await this.makeRequest('chat.postMessage', {
      channel,
      text,
      ...options
    }, 'POST');
  }

  async getUsers(limit = 100) {
    return await this.makeRequest('users.list', { limit });
  }

  async searchMessages(query, count = 20) {
    return await this.makeRequest('search.messages', { query, count });
  }
}

// Authentication function
async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  let slackToken = null;
  
  if (authHeader) {
    if (authHeader.startsWith('Bearer xoxp-')) {
      slackToken = authHeader.substring(7);
    } else if (authHeader.startsWith('xoxp-')) {
      slackToken = authHeader;
    }
  }
  
  if (!slackToken || !slackToken.startsWith('xoxp-')) {
    return null;
  }
  
  try {
    const slackClient = new SlackClient(slackToken);
    await slackClient.testAuth();
    return slackToken;
  } catch (error) {
    console.error('Token validation error:', error);
    return null;
  }
}

// Routes
app.get('/', (req, res) => {
  res.json({
    name: "Slack MCP Server",
    version: "1.0.0",
    description: "Connect your Slack workspace to Claude (Azure Container)",
    capabilities: { tools: true },
    instructions: {
      setup: "Get registered at /connect",
      authentication: "Use your Slack token as 'Bearer xoxp-your-token'"
    }
  });
});

// Connect page
app.get('/connect', (req, res) => {
  const { oauth, client, auth_code, redirect_uri, state, client_id } = req.query;
  const isClaudeWeb = client === 'claude-web' || oauth === 'true';
  
  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Connect Slack to Claude MCP</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
        .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; color: #333; }
        input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-size: 16px; }
        button { background: #007cba; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; width: 100%; }
        button:hover { background: #005a8b; }
        .status { margin-top: 15px; padding: 12px; border-radius: 5px; display: none; }
        .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
        .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
        h1 { color: #333; text-align: center; }
        .note { background: #e7f3ff; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #007cba; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Connect Slack to Claude</h1>
        <div class="note">
            <strong>Azure Container App</strong> - Enter your Slack user token below to connect your workspace.
        </div>
        
        <form id="connectionForm">
            <div class="form-group">
                <label for="slackToken">Slack User Token *</label>
                <input type="text" id="slackToken" placeholder="xoxp-..." required>
                <small style="color: #666;">Get this from your Slack app's OAuth settings</small>
            </div>
            
            <div class="form-group">
                <label for="userName">Your Name (Optional)</label>
                <input type="text" id="userName" placeholder="John Doe">
            </div>
            
            <button type="submit">Connect to Claude</button>
        </form>
        
        <div class="status" id="status"></div>
    </div>

    <script>
        document.getElementById('connectionForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const status = document.getElementById('status');
            const button = e.target.querySelector('button');
            const slackToken = document.getElementById('slackToken').value.trim();
            const userName = document.getElementById('userName').value.trim();
            
            if (!slackToken.startsWith('xoxp-')) {
                status.className = 'status error';
                status.textContent = 'Invalid token format. Must start with xoxp-';
                status.style.display = 'block';
                return;
            }
            
            button.textContent = 'Connecting...';
            button.disabled = true;
            
            try {
                const response = await fetch('/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        slackToken: slackToken,
                        userInfo: { name: userName || 'Azure User' }
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    status.className = 'status success';
                    status.textContent = '✅ Successfully connected! You can now use this server with Claude.';
                } else {
                    status.className = 'status error';
                    status.textContent = '❌ ' + (data.error || 'Connection failed');
                }
                status.style.display = 'block';
                
            } catch (error) {
                status.className = 'status error';
                status.textContent = '❌ Network error. Please try again.';
                status.style.display = 'block';
            } finally {
                button.textContent = 'Connect to Claude';
                button.disabled = false;
            }
        });
    </script>
</body>
</html>`;
  
  res.send(html);
});

// Registration
app.post('/register', async (req, res) => {
  const { slackToken, userInfo = {} } = req.body;
  
  if (!slackToken || !slackToken.startsWith('xoxp-')) {
    return res.status(400).json({ 
      error: 'Valid Slack user token required (must start with xoxp-)' 
    });
  }

  try {
    console.log('Registering user...');
    const slackClient = new SlackClient(slackToken);
    const authTest = await slackClient.testAuth();
    
    const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(7);
    
    const userData = {
      id: userId,
      slackToken,
      createdAt: new Date().toISOString(),
      userInfo: {
        ...userInfo,
        slackUserId: authTest.user_id,
        slackTeam: authTest.team_id,
        slackTeamName: authTest.team
      },
      active: true
    };

    users.set(userId, userData);
    tokens.set(slackToken, userId);

    console.log('User registered successfully:', userId);

    return res.json({
      success: true,
      message: 'Successfully registered',
      token: slackToken,
      userId,
      serverUrl: req.get('host')
    });

  } catch (error) {
    console.error('Registration error:', error);
    return res.status(400).json({ 
      error: 'Registration failed',
      message: error.message
    });
  }
});

// OAuth endpoints
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
  const { grant_type, code } = req.body;
  
  if (grant_type !== 'authorization_code' || !code) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const slackToken = oauthCodes.get(code);
  if (!slackToken) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  oauthCodes.delete(code);

  res.json({
    access_token: slackToken,
    token_type: 'bearer',
    expires_in: 31536000
  });
});

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
  if (!slackToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const slackClient = new SlackClient(slackToken);
  const { method, params } = req.body || {};

  try {
    switch (method) {
      case 'initialize':
        return res.json({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'slack-mcp-server',
            version: '1.0.0'
          }
        });

      case 'tools/list':
        return res.json({
          tools: [
            {
              name: 'slack_get_channels',
              description: 'List available channels',
              inputSchema: {
                type: 'object',
                properties: {
                  limit: { type: 'number', default: 100 }
                }
              }
            },
            {
              name: 'slack_get_channel_history',
              description: 'Get recent messages from a channel',
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
              description: 'Send a message to a channel',
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
        });

      case 'tools/call':
        const { name, arguments: args } = params;
        
        switch (name) {
          case 'slack_get_channels':
            const channelsData = await slackClient.getChannels('public_channel', args.limit || 100);
            const channels = channelsData.channels.map(ch => `#${ch.name} (${ch.num_members} members)`);
            
            return res.json({
              content: [{
                type: 'text',
                text: `Found ${channels.length} channels:\n\n${channels.join('\n')}`
              }]
            });

          case 'slack_get_channel_history':
            const historyData = await slackClient.getChannelHistory(args.channel, args.limit || 50);
            const messages = historyData.messages
              .map(msg => `${new Date(parseFloat(msg.ts) * 1000).toLocaleString()}: ${msg.text || 'No text'}`)
              .slice(0, 10);
            
            return res.json({
              content: [{
                type: 'text',
                text: `Recent messages in ${args.channel}:\n\n${messages.join('\n')}`
              }]
            });

          case 'slack_send_message':
            await slackClient.sendMessage(args.channel, args.text);
            return res.json({
              content: [{
                type: 'text',
                text: `✅ Message sent successfully to ${args.channel}`
              }]
            });

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

      default:
        return res.status(400).json({ error: `Unknown method: ${method}` });
    }
  } catch (error) {
    return res.json({
      content: [{
        type: 'text',
        text: `❌ Error: ${error.message}`
      }],
      isError: true
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server running on port ${PORT}`);
  console.log(`📱 Connect at: http://localhost:${PORT}/connect`);
  console.log(`🔗 Server ready for Claude Web integration`);
});
