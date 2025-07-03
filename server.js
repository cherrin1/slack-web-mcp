const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Connect page with OAuth support
app.get('/connect', (req, res) => {
  const { oauth, client, auth_code, redirect_uri, state, client_id } = req.query;
  const isClaudeWeb = client === 'claude-web' || oauth === 'true';
  
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
.claude-success{background:#f0fff4;border:2px solid #68d391;border-radius:8px;padding:20px;margin-top:20px;text-align:center;display:none}
.claude-success h3{color:#22543d;margin-bottom:12px}
.complete-btn{background:#48bb78;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;font-size:16px;font-weight:600}
.info-box{background:#e6f3ff;padding:15px;border-radius:5px;margin-bottom:20px;border-left:4px solid #007cba}
</style></head>
<body><div class="container">
<h1>🚀 Connect Slack to Claude</h1>
${isClaudeWeb ? '<div class="info-box"><strong>Claude Web OAuth</strong> - Complete your integration below.</div>' : ''}
<div class="info-box">
  <strong>📋 Integration URL:</strong><br>
  <code>https://${req.get('host')}/</code><br>
  <small>Use this URL when adding the integration to Claude</small>
</div>
<form id="form">
<div class="form-group"><label for="token">Slack User Token *</label>
<input type="text" id="token" placeholder="xoxp-..." required></div>
<div class="form-group"><label for="name">Your Name (Optional)</label>
<input type="text" id="name" placeholder="John Doe"></div>
<button type="submit">Connect to Claude</button>
</form>
<div class="status" id="status"></div>
<div class="claude-success" id="claudeSuccess">
<h3>✅ Integration Complete!</h3>
<p>Your Slack workspace has been successfully connected to Claude Web.</p>
<button class="complete-btn" onclick="completeClaudeOAuth()">🚀 Return to Claude</button>
</div>
</div>
<script>
const isClaudeWeb = ${isClaudeWeb};
const authCode = '${auth_code || ''}';
const redirectUri = '${redirect_uri || ''}';
const state = '${state || ''}';

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
      if (isClaudeWeb && authCode) {
        await fetch('/oauth/store-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authCode: authCode, token: token })
        });
        
        status.className = 'status success';
        status.textContent = '✅ Successfully connected!';
        document.getElementById('claudeSuccess').style.display = 'block';
        document.getElementById('form').style.display = 'none';
      } else {
        status.className = 'status success';
        status.textContent = '✅ Successfully connected! Tools should now appear in Claude.';
      }
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

function completeClaudeOAuth() {
  if (redirectUri && authCode) {
    const returnUrl = redirectUri + '?code=' + authCode + (state ? '&state=' + state : '');
    window.location.href = returnUrl;
  } else {
    window.close();
  }
}
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
    client_secret: "not-required-for-public-client",
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    scope: "slack:read slack:write",
    response_type: "code",
    grant_type: "authorization_code"
  });
});

app.get('/oauth/authorize', (req, res) => {
  console.log('OAuth authorize called:', req.query);
  const { client_id, redirect_uri, state, response_type } = req.query;
  
  if (!redirect_uri) {
    return res.status(400).json({ error: 'redirect_uri is required' });
  }
  
  if (!client_id) {
    return res.status(400).json({ error: 'client_id is required' });
  }
  
  const authCode = 'claude_web_' + Date.now() + '_' + Math.random().toString(36).substring(7);
  const baseUrl = `https://${req.get('host')}`;
  
  const connectUrl = `${baseUrl}/connect?oauth=true&client=claude-web&auth_code=${authCode}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state || ''}&client_id=${client_id}`;
  
  console.log('Redirecting to:', connectUrl);
  res.redirect(302, connectUrl);
});

app.post('/oauth/token', (req, res) => {
  console.log('OAuth token request:', req.body);
  
  const { grant_type, code, client_id, redirect_uri } = req.body;
  
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ 
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code is supported'
    });
  }
  
  if (!code) {
    return res.status(400).json({ 
      error: 'invalid_request',
      error_description: 'authorization_code is required'
    });
  }
  
  if (!client_id || client_id !== 'slack-mcp-claude-web') {
    return res.status(400).json({ 
      error: 'invalid_client',
      error_description: 'Invalid client_id'
    });
  }
  
  const slackToken = oauthCodes.get(code);
  if (!slackToken) {
    console.log('Authorization code not found:', code);
    return res.status(400).json({ 
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code'
    });
  }
  
  oauthCodes.delete(code);
  
  const tokenResponse = {
    access_token: slackToken,
    token_type: 'bearer',
    expires_in: 31536000,
    refresh_token: `refresh_${Date.now()}_${Math.random().toString(36)}`,
    scope: 'slack:read slack:write'
  };
  
  console.log('Returning token response');
  res.json(tokenResponse);
});

app.post('/oauth/store-token', (req, res) => {
  console.log('Store token request:', req.body);
  const { authCode, token } = req.body;
  
  if (!authCode || !token) {
    return res.status(400).json({ error: 'Both authCode and token are required' });
  }
  
  if (!token.startsWith('xoxp-')) {
    return res.status(400).json({ error: 'Invalid token format' });
  }
  
  oauthCodes.set(authCode, token);
  setTimeout(() => oauthCodes.delete(authCode), 600000);
  
  console.log('Token stored for auth code:', authCode.substring(0, 20) + '...');
  res.json({ success: true });
});

// Direct OAuth routes (without /oauth prefix) for Claude Web compatibility
app.get('/authorize', (req, res) => {
  console.log('Direct /authorize called:', req.query);
  const { client_id, redirect_uri, state, response_type } = req.query;
  
  if (!redirect_uri) {
    return res.status(400).json({ error: 'redirect_uri is required' });
  }
  
  if (!client_id) {
    return res.status(400).json({ error: 'client_id is required' });
  }
  
  const authCode = 'claude_web_' + Date.now() + '_' + Math.random().toString(36).substring(7);
  const baseUrl = `https://${req.get('host')}`;
  
  const connectUrl = `${baseUrl}/connect?oauth=true&client=claude-web&auth_code=${authCode}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state || ''}&client_id=${client_id}`;
  
  console.log('Redirecting to:', connectUrl);
  res.redirect(302, connectUrl);
});

app.post('/token', (req, res) => {
  console.log('Direct /token request:', req.body);
  
  const { grant_type, code, client_id, redirect_uri } = req.body;
  
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ 
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code is supported'
    });
  }
  
  if (!code) {
    return res.status(400).json({ 
      error: 'invalid_request',
      error_description: 'authorization_code is required'
    });
  }
  
  if (!client_id || client_id !== 'slack-mcp-claude-web') {
    return res.status(400).json({ 
      error: 'invalid_client',
      error_description: 'Invalid client_id'
    });
  }
  
  const slackToken = oauthCodes.get(code);
  if (!slackToken) {
    console.log('Authorization code not found:', code);
    return res.status(400).json({ 
      error: 'invalid_grant',
      error_description: 'Invalid or expired authorization code'
    });
  }
  
  oauthCodes.delete(code);
  
  const tokenResponse = {
    access_token: slackToken,
    token_type: 'bearer',
    expires_in: 31536000,
    refresh_token: `refresh_${Date.now()}_${Math.random().toString(36)}`,
    scope: 'slack:read slack:write'
  };
  
  console.log('Returning token response');
  res.json(tokenResponse);
});

// MCP Protocol - TEMPORARILY DISABLE AUTHENTICATION FOR TESTING
app.post('/', async (req, res) => {
  console.log('=== MCP REQUEST ===');
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  
  // TEMPORARILY SKIP AUTHENTICATION FOR TESTING
  // const slackToken = await authenticateRequest(req);
  // if (!slackToken) {
  //   console.log('MCP request failed: Authentication required');
  //   return res.status(401).json({ 
  //     jsonrpc: '2.0',
  //     error: { code: -32001, message: 'Authentication required' },
  //     id: req.body?.id || null
  //   });
  // }
  
  const { method, params, id } = req.body || {};
  
  console.log('MCP method:', method);
  console.log('MCP params:', params);
  console.log('Request ID:', id);

  try {
    switch (method) {
      case 'initialize':
        console.log('Handling initialize request');
        const initResponse = { 
          jsonrpc: '2.0',
          result: {
            protocolVersion: '2024-11-05', 
            capabilities: { 
              tools: {
                listChanged: true
              }
            }, 
            serverInfo: { 
              name: 'slack-mcp-server', 
              version: '1.0.0',
              description: 'Slack MCP Server with OAuth support'
            }
          },
          id: id
        };
        console.log('Initialize response:', initResponse);
        
        // Force Claude to call tools/list by logging that we're ready
        console.log('🚀 Server initialized - Claude should now call tools/list');
        return res.json(initResponse);
      
      case 'tools/list':
        console.log('Handling tools/list request');
        const toolsResponse = { 
          jsonrpc: '2.0',
          result: {
            tools: [
              { 
                name: 'slack_get_channels', 
                description: 'List available Slack channels', 
                inputSchema: { 
                  type: 'object', 
                  properties: { 
                    limit: { type: 'number', description: 'Maximum number of channels to return', default: 100 } 
                  } 
                } 
              },
              { 
                name: 'slack_get_channel_history', 
                description: 'Get recent messages from a specific channel', 
                inputSchema: { 
                  type: 'object', 
                  properties: { 
                    channel: { type: 'string', description: 'Channel ID or name' }, 
                    limit: { type: 'number', description: 'Number of messages to retrieve', default: 50 } 
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
                    channel: { type: 'string', description: 'Channel ID or name' }, 
                    text: { type: 'string', description: 'Message text to send' } 
                  }, 
                  required: ['channel', 'text'] 
                } 
              }
            ]
          },
          id: id
        };
        console.log('Tools response:', JSON.stringify(toolsResponse, null, 2));
        return res.json(toolsResponse);
      
      case 'tools/call':
        console.log('Handling tools/call request');
        const { name, arguments: args } = params;
        console.log('Tool name:', name);
        console.log('Tool arguments:', args);
        
        // Return dummy response for testing since we're not authenticating
        const toolResult = {
          content: [{ 
            type: 'text', 
            text: `✅ Tool "${name}" called successfully (test mode - authentication disabled)` 
          }]
        };
        
        const callResponse = {
          jsonrpc: '2.0',
          result: toolResult,
          id: id
        };
        console.log('Tool call result:', callResponse);
        return res.json(callResponse);
      
      case 'notifications/initialized':
        console.log('Handling notifications/initialized request');
        // After receiving the initialized notification, let's immediately call tools/list
        // Since this is a notification, we'll return success and then Claude should call tools/list
        
        // Send a tools/list changed notification to Claude
        setTimeout(() => {
          console.log('Sending tools/list_changed notification to Claude');
          // We can't send notifications back to Claude in HTTP mode, 
          // but we can log that we're ready for tools/list
        }, 100);
        
        return res.status(200).send();
      
      default:
        console.log('Unknown method:', method);
        return res.status(400).json({ 
          jsonrpc: '2.0',
          error: { code: -32601, message: `Unknown method: ${method}` },
          id: id
        });
    }
  } catch (error) {
    console.log('MCP Error:', error);
    const errorResponse = { 
      jsonrpc: '2.0',
      error: { code: -32603, message: error.message },
      id: id
    };
    console.log('Error response:', errorResponse);
    return res.json(errorResponse);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server running on port ${PORT}`);
  console.log(`📱 Connect at: http://localhost:${PORT}/connect`);
  console.log(`🔗 Server ready for Claude Web integration`);
});