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

// Authentication function
async function authenticateRequest(req) {
  console.log('=== AUTH DEBUG ===');
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  
  const authHeader = req.headers.authorization;
  let slackToken = null;
  
  if (authHeader) {
    console.log('Authorization header found:', authHeader);
    if (authHeader.startsWith('Bearer xoxp-')) {
      slackToken = authHeader.substring(7);
    } else if (authHeader.startsWith('Bearer ')) {
      slackToken = authHeader.substring(7);
    } else if (authHeader.startsWith('xoxp-')) {
      slackToken = authHeader;
    }
  }
  
  if (!slackToken) {
    slackToken = req.headers['x-api-key'] || req.headers['x-auth-token'] || req.headers['x-slack-token'];
  }
  
  console.log('Final extracted token:', slackToken ? slackToken.substring(0, 20) + '...' : 'null');
  
  if (!slackToken || !slackToken.startsWith('xoxp-')) {
    console.log('Auth failed: No valid Slack token found');
    return null;
  }
  
  try {
    const client = new SlackClient(slackToken);
    const authTest = await client.testAuth();
    console.log('Auth successful for user:', authTest.user_id);
    return slackToken;
  } catch (error) {
    console.log('Auth failed - Slack API error:', error.message);
    return null;
  }
}

// MCP Tool definitions
const MCP_TOOLS = [
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
];

// Execute MCP tool
async function executeTool(slackClient, toolName, args) {
  console.log(`Executing tool: ${toolName} with args:`, args);
  
  switch (toolName) {
    case 'slack_get_channels':
      const channelsData = await slackClient.getChannels('public_channel', args?.limit || 100);
      return { 
        content: [{ 
          type: 'text', 
          text: `Found ${channelsData.channels.length} channels:\n\n` + 
                channelsData.channels.map(ch => `#${ch.name} (${ch.num_members} members)`).join('\n') 
        }] 
      };
    
    case 'slack_get_channel_history':
      const historyData = await slackClient.getChannelHistory(args.channel, args?.limit || 50);
      const messages = historyData.messages.slice(0, 10).map(msg => 
        `${new Date(parseFloat(msg.ts) * 1000).toLocaleString()}: ${msg.text || 'No text'}`
      );
      return { 
        content: [{ 
          type: 'text', 
          text: `Recent messages in ${args.channel}:\n\n${messages.join('\n')}` 
        }] 
      };
    
    case 'slack_send_message':
      await slackClient.sendMessage(args.channel, args.text);
      return { 
        content: [{ 
          type: 'text', 
          text: `✅ Message sent to ${args.channel}` 
        }] 
      };
    
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// Main routes
app.get('/', (req, res) => {
  res.json({
    name: "Slack MCP Server",
    version: "1.0.0",
    description: "Connect your Slack workspace to Claude",
    capabilities: { tools: true },
    status: "running",
    endpoints: {
      sse: "/sse",
      connect: "/connect",
      oauth: "/oauth/config"
    }
  });
});

// **SSE Endpoint for Claude MCP Integration**
app.get('/sse', async (req, res) => {
  console.log('=== SSE CONNECTION STARTED ===');
  console.log('SSE Request Headers:', JSON.stringify(req.headers, null, 2));
  
  // For now, skip authentication for SSE to test connection
  // TODO: Implement proper OAuth flow as per MCP spec
  
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
  
  // SSE helper function
  function sendSSEMessage(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    console.log('Sending SSE message:', message);
    res.write(message);
  }
  
  // Send initial connection message
  sendSSEMessage({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  });
  
  // Handle connection close
  req.on('close', () => {
    console.log('SSE connection closed');
  });
  
  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);
  
  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

// **POST endpoint for SSE messages (MCP protocol over HTTP)**
app.post('/sse', async (req, res) => {
  console.log('=== SSE POST REQUEST ===');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  console.log('Request headers:', JSON.stringify(req.headers, null, 2));
  
  // For now, skip authentication for testing
  // TODO: Implement proper OAuth flow as per MCP spec
  
  const { method, params, id } = req.body || {};
  
  try {
    let response;
    
    switch (method) {
      case 'initialize':
        response = {
          jsonrpc: '2.0',
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: { listChanged: true }
            },
            serverInfo: {
              name: 'slack-mcp-server',
              version: '1.0.0',
              description: 'Slack MCP Server with SSE support'
            }
          },
          id: id
        };
        break;
      
      case 'tools/list':
        response = {
          jsonrpc: '2.0',
          result: { tools: MCP_TOOLS },
          id: id
        };
        break;
      
      case 'tools/call':
        const { name, arguments: args } = params;
        // For now, return dummy response for testing
        response = {
          jsonrpc: '2.0',
          result: {
            content: [{
              type: 'text',
              text: `✅ Tool "${name}" called successfully (testing mode)`
            }]
          },
          id: id
        };
        break;
      
      default:
        response = {
          jsonrpc: '2.0',
          error: { code: -32601, message: `Unknown method: ${method}` },
          id: id
        };
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('SSE POST error:', error);
    res.json({
      jsonrpc: '2.0',
      error: { code: -32603, message: error.message },
      id: id
    });
  }
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
  <code>https://${req.get('host')}/sse</code><br>
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
        status.textContent = '✅ Successfully connected! You can now use the SSE endpoint in Claude.';
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

// OAuth endpoints for Claude Web (MCP Auth Spec Compliant)
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const baseUrl = `https://${req.get('host')}`;
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["slack:read", "slack:write"]
  });
});

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

app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server running on port ${PORT}`);
  console.log(`📱 Connect at: http://localhost:${PORT}/connect`);
  console.log(`🔗 SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`🌐 Server ready for Claude integration`);
});