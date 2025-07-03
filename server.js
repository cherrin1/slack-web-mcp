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

  // Check if token is registered
  const userId = tokens.get(token);
  if (!userId) {
    console.log('🔍 Token not found in registered tokens');
    console.log('🔍 Available tokens:', Array.from(tokens.keys()).map(t => t.substring(0, 15) + '...'));
    return null;
  }

  console.log('✅ Token authenticated for user:', userId);
  return token;
}

// Main routes
app.get('/', (req, res) => {
  res.json({
    name: "Slack MCP Server",
    version: "1.0.0",
    description: "Connect your Slack workspace to Claude",
    capabilities: { tools: true },
    status: "running",
    protocol: "mcp",
    transport: "http"
  });
});

// MCP capabilities endpoint for Claude Web
app.get('/capabilities', (req, res) => {
  res.json({
    capabilities: {
      tools: {
        listChanged: true
      }
    },
    serverInfo: {
      name: "slack-mcp-server",
      version: "1.0.0",
      description: "Slack MCP Server with 3 tools available"
    }
  });
});

// Debug endpoint to check current state
app.get('/debug', (req, res) => {
  res.json({
    users: users.size,
    tokens: tokens.size,
    oauthCodes: oauthCodes.size,
    registeredTokens: Array.from(tokens.keys()).map(t => t.substring(0, 15) + '...')
  });
});

// SSE endpoint for Claude Web MCP integration
app.get('/sse', (req, res) => {
  console.log('🔧 SSE endpoint called for MCP integration');
  
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send the endpoint URL for MCP messaging
  const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substring(7);
  const messageEndpoint = `/messages/${sessionId}`;
  
  res.write(`event: endpoint\n`);
  res.write(`data: ${messageEndpoint}\n\n`);
  
  console.log('🔧 SSE endpoint sent, message endpoint:', messageEndpoint);
  
  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(`event: ping\n`);
    res.write(`data: ${Date.now()}\n\n`);
  }, 30000);
  
  req.on('close', () => {
    console.log('🔧 SSE connection closed');
    clearInterval(keepAlive);
  });
});

// MCP messaging endpoint for SSE
app.post('/messages/:sessionId', async (req, res) => {
  console.log('🔧 === MCP SSE MESSAGE ===');
  console.log('🔧 Session ID:', req.params.sessionId);
  console.log('🔧 Method:', req.body?.method);
  console.log('🔧 Headers Authorization:', req.headers.authorization ? 'Present (' + req.headers.authorization.substring(0, 20) + '...)' : 'Missing');
  console.log('🔧 Request body:', JSON.stringify(req.body, null, 2));
  
  const { method, params, id } = req.body || {};

  try {
    // Handle initialize for SSE
    if (method === 'initialize') {
      console.log('🔧 SSE Initialize called');
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
            description: 'Slack MCP Server with 3 tools available'
          }
        },
        id: id
      };
      console.log('🔧 SSE Initialize response:', JSON.stringify(initResponse, null, 2));
      console.log('🔧 SSE SHOULD NOW CALL tools/list');
      return res.json(initResponse);
    }

    if (method === 'notifications/initialized') {
      console.log('🔧 SSE Notifications/initialized');
      console.log('🔧 SSE SERVER READY - WAITING FOR tools/list');
      return res.status(200).send();
    }

    // Handle tools/list for SSE
    if (method === 'tools/list') {
      console.log('🎉 SSE TOOLS/LIST CALLED');
      
      const toolsResponse = { 
        jsonrpc: '2.0',
        result: {
          tools: [
            { 
              name: 'slack_get_channels', 
              description: 'List available Slack channels (requires authentication)', 
              inputSchema: { 
                type: 'object', 
                properties: { 
                  limit: { type: 'number', description: 'Maximum number of channels to return', default: 100 } 
                } 
              } 
            },
            { 
              name: 'slack_get_channel_history', 
              description: 'Get recent messages from a specific channel (requires authentication)', 
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
              description: 'Send a message to a Slack channel (requires authentication)', 
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
      console.log('🎉 SSE Tools list response:', JSON.stringify(toolsResponse, null, 2));
      return res.json(toolsResponse);
    }

    // Handle tools/call for SSE
    if (method === 'tools/call') {
      const slackToken = await authenticateRequest(req);
      if (!slackToken) {
        console.log('❌ SSE Tools/call requires authentication');
        return res.status(401).json({ 
          jsonrpc: '2.0',
          error: { 
            code: -32001, 
            message: 'Authentication required for tool calls. Please connect your Slack token first.',
            data: {
              authUrl: `https://${req.get('host')}/connect`,
              instructions: 'Visit the connect URL to authenticate your Slack workspace'
            }
          },
          id: id
        });
      }

      const { name, arguments: args } = params;
      console.log('🔧 SSE Tool call with auth:', name, 'Args:', args);
      
      const slackClient = new SlackClient(slackToken);
      let toolResult;
      
      try {
        switch (name) {
          case 'slack_get_channels':
            const channels = await slackClient.getChannels('public_channel,private_channel', args?.limit || 100);
            toolResult = {
              content: [{ 
                type: 'text', 
                text: `Found ${channels.channels.length} channels:\n\n` +
                      channels.channels.map(ch => `• #${ch.name} (${ch.id}) - ${ch.purpose?.value || 'No description'}`).join('\n')
              }]
            };
            break;
            
          case 'slack_get_channel_history':
            const history = await slackClient.getChannelHistory(args.channel, args?.limit || 50);
            toolResult = {
              content: [{ 
                type: 'text', 
                text: `Recent messages in ${args.channel}:\n\n` +
                      history.messages.map(msg => `• ${msg.user}: ${msg.text}`).join('\n')
              }]
            };
            break;
            
          case 'slack_send_message':
            const result = await slackClient.sendMessage(args.channel, args.text);
            toolResult = {
              content: [{ 
                type: 'text', 
                text: `Message sent successfully to ${args.channel}! Message timestamp: ${result.ts}`
              }]
            };
            break;
            
          default:
            toolResult = {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true
            };
        }
      } catch (error) {
        console.error('SSE Tool execution error:', error);
        toolResult = {
          content: [{ type: 'text', text: `Error executing ${name}: ${error.message}` }],
          isError: true
        };
      }
      
      const callResponse = {
        jsonrpc: '2.0',
        result: toolResult,
        id: id
      };
      console.log('🔧 SSE Tool call completed:', name);
      return res.json(callResponse);
    }

    // Handle other methods
    console.log('❌ SSE Unknown method:', method);
    return res.status(400).json({ 
      jsonrpc: '2.0',
      error: { code: -32601, message: `Unknown method: ${method}` },
      id: id
    });

  } catch (error) {
    console.error('❌ SSE MCP Error:', error);
    return res.status(500).json({ 
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
  
  console.log('🔗 Connect page accessed:', { oauth, client, auth_code: auth_code?.substring(0, 20) + '...' });
  
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
.debug{background:#f8f9fa;padding:10px;border-radius:5px;margin-bottom:20px;font-family:monospace;font-size:12px}
</style></head>
<body><div class="container">
<h1>🚀 Connect Slack to Claude</h1>
${isClaudeWeb ? '<div class="info-box"><strong>Claude Web OAuth</strong> - Please enter your Slack token to complete the integration.</div>' : ''}
<div class="info-box">
  <strong>📋 Integration URL:</strong><br>
  <code>https://${req.get('host')}/</code><br>
  <small>Use this URL when adding the integration to Claude</small>
</div>
<div class="debug">
  <strong>Debug Info:</strong><br>
  OAuth: ${oauth || 'false'}<br>
  Client: ${client || 'none'}<br>
  Auth Code: ${auth_code ? auth_code.substring(0, 20) + '...' : 'none'}<br>
  Redirect URI: ${redirect_uri || 'none'}<br>
  State: ${state || 'none'}
</div>
<form id="form">
<div class="form-group"><label for="token">Slack User Token *</label>
<input type="text" id="token" placeholder="xoxp-your-slack-token-here" required>
<small>Get your token from <a href="https://api.slack.com/custom-integrations/legacy-tokens" target="_blank">Slack Legacy Tokens</a></small></div>
<div class="form-group"><label for="name">Your Name (Optional)</label>
<input type="text" id="name" placeholder="John Doe"></div>
<button type="submit">Connect to Claude</button>
</form>
<div class="status" id="status"></div>
<div class="claude-success" id="claudeSuccess">
<h3>✅ Integration Complete!</h3>
<p>Your Slack workspace has been successfully connected to Claude Web.</p>
<p><strong>Important:</strong> Please return to Claude manually and refresh the page to see your tools.</p>
<button class="complete-btn" onclick="completeClaudeOAuth()">🔄 Try Auto-Return to Claude</button>
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
    status.textContent = 'Invalid token format. Must start with xoxp-';
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
        // Store token for OAuth flow
        await fetch('/oauth/store-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ authCode: authCode, token: token })
        });
        
        status.className = 'status success';
        status.textContent = '✅ Successfully connected! You can now return to Claude.';
        document.getElementById('claudeSuccess').style.display = 'block';
        document.getElementById('form').style.display = 'none';
        
        // Don't auto-redirect, let user do it manually
      } else {
        status.className = 'status success';
        status.textContent = '✅ Successfully connected! Tools should now appear in Claude.';
      }
    } else {
      status.className = 'status error';
      status.textContent = '❌ ' + (data.error || 'Registration failed');
    }
    status.style.display = 'block';
  } catch (error) {
    status.className = 'status error';
    status.textContent = '❌ Network error: ' + error.message;
    status.style.display = 'block';
  }
});

function completeClaudeOAuth() {
  console.log('Attempting OAuth completion...');
  console.log('Redirect URI:', redirectUri);
  console.log('Auth Code:', authCode);
  console.log('State:', state);
  
  if (redirectUri && authCode) {
    const returnUrl = redirectUri + '?code=' + authCode + (state ? '&state=' + encodeURIComponent(state) : '');
    console.log('Trying to redirect to:', returnUrl);
    
    // Try multiple redirect methods
    try {
      window.location.replace(returnUrl);
    } catch (e) {
      console.log('Replace failed, trying assign:', e);
      try {
        window.location.assign(returnUrl);
      } catch (e2) {
        console.log('Assign failed, trying href:', e2);
        try {
          window.location.href = returnUrl;
        } catch (e3) {
          console.log('All redirect methods failed:', e3);
          alert('Auto-redirect failed. Please copy this URL and paste it in your browser:\\n\\n' + returnUrl);
        }
      }
    }
  } else {
    alert('Missing OAuth information. Please return to Claude manually and refresh the page.');
  }
}
</script></body></html>`;
  res.send(html);
});

app.post('/register', async (req, res) => {
  const { slackToken, userInfo = {} } = req.body;
  console.log('📝 Registration attempt:', { token: slackToken?.substring(0, 15) + '...', userInfo });
  
  if (!slackToken || !slackToken.startsWith('xoxp-')) {
    return res.status(400).json({ error: 'Valid Slack token required (must start with xoxp-)' });
  }
  
  try {
    const slackClient = new SlackClient(slackToken);
    const authTest = await slackClient.testAuth();
    console.log('✅ Slack auth test successful:', authTest.user, authTest.team);
    
    const userId = 'usr_' + Date.now() + '_' + Math.random().toString(36).substring(7);
    const userData = { 
      id: userId, 
      slackToken, 
      userInfo: { ...userInfo, slackUserId: authTest.user_id, teamId: authTest.team_id }, 
      active: true 
    };
    
    users.set(userId, userData);
    tokens.set(slackToken, userId);
    
    console.log('✅ User registered successfully:', userId);
    console.log('📊 Current stats:', users.size, 'users,', tokens.size, 'tokens');
    return res.json({ success: true, message: 'Successfully registered', userId });
  } catch (error) {
    console.error('❌ Registration failed:', error);
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
  console.log('🔐 OAuth authorize called:', req.query);
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
  
  console.log('🔐 Redirecting to connect page:', connectUrl);
  res.redirect(302, connectUrl);
});

app.post('/oauth/token', (req, res) => {
  console.log('🔐 OAuth token request:', req.body);
  
  const { grant_type, code, client_id, redirect_uri, code_verifier } = req.body;
  
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
  
  const slackToken = oauthCodes.get(code);
  if (!slackToken) {
    console.log('❌ Authorization code not found or expired:', code);
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
  
  console.log('✅ Token issued successfully for:', slackToken.substring(0, 15) + '...');
  res.json(tokenResponse);
});

app.post('/oauth/store-token', (req, res) => {
  const { authCode, token } = req.body;
  console.log('💾 Storing token for auth code:', authCode?.substring(0, 20) + '...');
  
  if (!authCode || !token) {
    return res.status(400).json({ error: 'Both authCode and token are required' });
  }
  
  if (!token.startsWith('xoxp-')) {
    return res.status(400).json({ error: 'Invalid token format' });
  }
  
  oauthCodes.set(authCode, token);
  // Clean up after 10 minutes
  setTimeout(() => {
    oauthCodes.delete(authCode);
    console.log('🗑️ Cleaned up auth code:', authCode.substring(0, 20) + '...');
  }, 600000);
  
  res.json({ success: true });
});

// Direct OAuth routes (for compatibility)
app.get('/authorize', (req, res) => {
  console.log('🔐 Direct /authorize called (redirecting to /oauth/authorize)');
  return res.redirect('/oauth/authorize?' + new URLSearchParams(req.query).toString());
});

app.post('/token', (req, res) => {
  console.log('🔐 Direct /token called - handling directly');
  
  const { grant_type, code, client_id, redirect_uri, code_verifier } = req.body;
  
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
  
  const slackToken = oauthCodes.get(code);
  if (!slackToken) {
    console.log('❌ Authorization code not found or expired:', code);
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
  
  console.log('✅ Token issued successfully for:', slackToken.substring(0, 15) + '...');
  res.json(tokenResponse);
});

// MCP Protocol - SIMPLIFIED: Focus on tools/list as primary entry point
app.post('/', async (req, res) => {
  console.log('🔧 === MCP REQUEST ===');
  console.log('🔧 Method:', req.body?.method);
  console.log('🔧 Headers Authorization:', req.headers.authorization ? 'Present (' + req.headers.authorization.substring(0, 20) + '...)' : 'Missing');
  console.log('🔧 Headers Content-Type:', req.headers['content-type']);
  console.log('🔧 Request body:', JSON.stringify(req.body, null, 2));
  console.log('🔧 Current server stats:', users.size, 'users,', tokens.size, 'tokens');
  
  const { method, params, id } = req.body || {};

  try {
    // PRIORITIZE tools/list - handle it first
    if (method === 'tools/list') {
      console.log('🎉 TOOLS/LIST CALLED - returning tools WITHOUT authentication');
      
      const toolsResponse = { 
        jsonrpc: '2.0',
        result: {
          tools: [
            { 
              name: 'slack_get_channels', 
              description: 'List available Slack channels (requires authentication)', 
              inputSchema: { 
                type: 'object', 
                properties: { 
                  limit: { type: 'number', description: 'Maximum number of channels to return', default: 100 } 
                } 
              } 
            },
            { 
              name: 'slack_get_channel_history', 
              description: 'Get recent messages from a specific channel (requires authentication)', 
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
              description: 'Send a message to a Slack channel (requires authentication)', 
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
      console.log('🎉 Tools list response:', JSON.stringify(toolsResponse, null, 2));
      return res.json(toolsResponse);
    }

    // EXPERIMENTAL: Put tools directly in capabilities
    if (method === 'initialize') {
      console.log('🔧 Initialize called with params:', JSON.stringify(params, null, 2));
      const initResponse = { 
        jsonrpc: '2.0',
        result: {
          protocolVersion: '2024-11-05', 
          capabilities: { 
            tools: [
              { 
                name: 'slack_get_channels', 
                description: 'List available Slack channels (requires authentication)', 
                inputSchema: { 
                  type: 'object', 
                  properties: { 
                    limit: { type: 'number', description: 'Maximum number of channels to return', default: 100 } 
                  } 
                } 
              },
              { 
                name: 'slack_get_channel_history', 
                description: 'Get recent messages from a specific channel (requires authentication)', 
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
                description: 'Send a message to a Slack channel (requires authentication)', 
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
          serverInfo: { 
            name: 'slack-mcp-server', 
            version: '1.0.0',
            description: 'Slack MCP Server with 3 tools available'
          }
        },
        id: id
      };
      console.log('🔧 Initialize response with tools in capabilities:', JSON.stringify(initResponse, null, 2));
      console.log('🔧 TOOLS NOW IN CAPABILITIES - SHOULD BE VISIBLE TO CLAUDE');
      return res.json(initResponse);
    }

    if (method === 'notifications/initialized') {
      console.log('🔧 Notifications/initialized - server ready');
      return res.status(200).send();
    }

    // REQUIRE authentication ONLY for tools/call
    if (method === 'tools/call') {
      const slackToken = await authenticateRequest(req);
      if (!slackToken) {
        console.log('❌ Tools/call requires authentication');
        return res.status(401).json({ 
          jsonrpc: '2.0',
          error: { 
            code: -32001, 
            message: 'Authentication required for tool calls. Please connect your Slack token first.',
            data: {
              authUrl: `https://${req.get('host')}/connect`,
              instructions: 'Visit the connect URL to authenticate your Slack workspace'
            }
          },
          id: id
        });
      }

      const { name, arguments: args } = params;
      console.log('🔧 Tool call with auth:', name, 'Args:', args);
      
      const slackClient = new SlackClient(slackToken);
      let toolResult;
      
      try {
        switch (name) {
          case 'slack_get_channels':
            const channels = await slackClient.getChannels('public_channel,private_channel', args?.limit || 100);
            toolResult = {
              content: [{ 
                type: 'text', 
                text: `Found ${channels.channels.length} channels:\n\n` +
                      channels.channels.map(ch => `• #${ch.name} (${ch.id}) - ${ch.purpose?.value || 'No description'}`).join('\n')
              }]
            };
            break;
            
          case 'slack_get_channel_history':
            const history = await slackClient.getChannelHistory(args.channel, args?.limit || 50);
            toolResult = {
              content: [{ 
                type: 'text', 
                text: `Recent messages in ${args.channel}:\n\n` +
                      history.messages.map(msg => `• ${msg.user}: ${msg.text}`).join('\n')
              }]
            };
            break;
            
          case 'slack_send_message':
            const result = await slackClient.sendMessage(args.channel, args.text);
            toolResult = {
              content: [{ 
                type: 'text', 
                text: `Message sent successfully to ${args.channel}! Message timestamp: ${result.ts}`
              }]
            };
            break;
            
          default:
            toolResult = {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true
            };
        }
      } catch (error) {
        console.error('Tool execution error:', error);
        toolResult = {
          content: [{ type: 'text', text: `Error executing ${name}: ${error.message}` }],
          isError: true
        };
      }
      
      const callResponse = {
        jsonrpc: '2.0',
        result: toolResult,
        id: id
      };
      console.log('🔧 Tool call completed:', name);
      return res.json(callResponse);
    }

    // Handle other methods
    console.log('❌ Unknown method:', method);
    return res.status(400).json({ 
      jsonrpc: '2.0',
      error: { code: -32601, message: `Unknown method: ${method}` },
      id: id
    });

  } catch (error) {
    console.error('❌ MCP Error:', error);
    return res.status(500).json({ 
      jsonrpc: '2.0',
      error: { code: -32603, message: error.message },
      id: id
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server running on port ${PORT}`);
  console.log(`📱 Connect at: https://your-domain.com/connect`);
  console.log(`🔗 Server ready for Claude integration`);
  console.log(`📊 Current stats: ${users.size} users, ${tokens.size} tokens`);
});