const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS configuration for Claude
app.use(cors({
  origin: ['https://claude.ai', 'https://playground.ai.cloudflare.com', 'https://console.anthropic.com', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Cache-Control', 'Mcp-Session-Id'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 200
}));

app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage
const registeredTokens = new Map();
const activeSessions = new Map();
const oauthClients = new Map();
const authorizationCodes = new Map();

// Pre-register Claude client IDs
const preRegisteredClients = [
  {
    client_id: 'slack-mcp-claude-web',
    client_secret: null,
    client_name: 'Claude Web Client',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'mcp'
  }
];

preRegisteredClients.forEach(client => {
  oauthClients.set(client.client_id, {
    ...client,
    created_at: new Date().toISOString()
  });
});

// SlackClient class
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

// Authentication function
async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const token = authHeader.replace('Bearer ', '');
  
  // Check if it's a registered Slack token
  if (token.startsWith('xoxp-')) {
    const userInfo = registeredTokens.get(token);
    if (!userInfo) return null;
    console.log('✅ Slack token authenticated for user:', userInfo.userName || 'Unknown');
    return { token, userInfo, type: 'slack' };
  }
  
  // Check if it's an OAuth access token
  for (const [slackToken, userInfo] of registeredTokens.entries()) {
    if (userInfo.accessTokens && userInfo.accessTokens.includes(token)) {
      console.log('✅ OAuth token authenticated for user:', userInfo.userName || 'Unknown');
      return { token: slackToken, userInfo, type: 'oauth' };
    }
  }

  return null;
}

// OAuth Discovery endpoint
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const baseUrl = `https://${req.get('host')}`;
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    scopes_supported: ['mcp'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none']
  });
});

// Dynamic Client Registration
app.post('/oauth/register', (req, res) => {
  console.log('🔐 OAuth client registration request:', req.body);
  
  const { client_name, redirect_uris } = req.body;
  
  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'redirect_uris is required and must be an array'
    });
  }

  const clientId = `mcp_client_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const clientSecret = `mcp_secret_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  const clientInfo = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: client_name || 'Claude MCP Client',
    redirect_uris: redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'mcp',
    created_at: new Date().toISOString()
  };
  
  oauthClients.set(clientId, clientInfo);
  console.log('✅ OAuth client registered:', clientId);
  
  res.json({
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientInfo.client_name,
    redirect_uris: clientInfo.redirect_uris,
    grant_types: clientInfo.grant_types,
    response_types: clientInfo.response_types,
    scope: clientInfo.scope,
    client_id_issued_at: Math.floor(new Date().getTime() / 1000),
    client_secret_expires_at: 0
  });
});

// OAuth Authorization endpoint
app.get('/oauth/authorize', (req, res) => {
  console.log('🔐 OAuth authorize request:', req.query);
  
  const { client_id, redirect_uri, response_type, scope, state, code_challenge, code_challenge_method } = req.query;
  
  const client = oauthClients.get(client_id);
  if (!client) {
    return res.status(400).json({
      error: 'invalid_client',
      error_description: 'Invalid client_id'
    });
  }
  
  if (!client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Invalid redirect_uri'
    });
  }
  
  const authCode = `mcp_code_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const codeInfo = {
    client_id,
    redirect_uri,
    scope: scope || 'mcp',
    state,
    code_challenge,
    code_challenge_method,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 10 * 60 * 1000)
  };
  
  authorizationCodes.set(authCode, codeInfo);
  
  // Auto-approve for registered users
  if (registeredTokens.size > 0) {
    const [firstToken, userInfo] = Array.from(registeredTokens.entries())[0];
    codeInfo.approved = true;
    codeInfo.user_token = firstToken;
    
    console.log('✅ Auto-approved OAuth for user:', userInfo.userName);
    
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', authCode);
    if (state) redirectUrl.searchParams.set('state', state);
    
    return res.redirect(redirectUrl.toString());
  }
  
  // Redirect to connect page
  const connectUrl = new URL(`https://${req.get('host')}/connect`);
  connectUrl.searchParams.set('oauth', 'true');
  connectUrl.searchParams.set('client_id', client_id);
  connectUrl.searchParams.set('redirect_uri', redirect_uri);
  connectUrl.searchParams.set('code', authCode);
  if (state) connectUrl.searchParams.set('state', state);
  
  res.redirect(connectUrl.toString());
});

// OAuth Token endpoint
app.post('/oauth/token', (req, res) => {
  console.log('🔐 OAuth token request:', req.body);
  
  const { grant_type, code, client_id, client_secret, redirect_uri } = req.body;
  
  if (grant_type !== 'authorization_code') {
    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code grant type is supported'
    });
  }
  
  const codeInfo = authorizationCodes.get(code);
  if (!codeInfo) {
    console.log('❌ Authorization code not found:', code);
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid authorization code'
    });
  }
  
  if (new Date() > codeInfo.expires_at) {
    authorizationCodes.delete(code);
    console.log('❌ Authorization code expired:', code);
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Authorization code expired'
    });
  }
  
  const client = oauthClients.get(client_id);
  if (!client) {
    console.log('❌ Client not found:', client_id);
    console.log('❌ Available clients:', Array.from(oauthClients.keys()));
    return res.status(400).json({
      error: 'invalid_client',
      error_description: 'Invalid client_id'
    });
  }
  
  if (client.client_secret && client.client_secret !== client_secret) {
    console.log('❌ Client secret mismatch for:', client_id);
    return res.status(400).json({
      error: 'invalid_client',
      error_description: 'Invalid client credentials'
    });
  }
  
  const accessToken = `mcp_access_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  if (codeInfo.user_token && registeredTokens.has(codeInfo.user_token)) {
    const userInfo = registeredTokens.get(codeInfo.user_token);
    if (!userInfo.accessTokens) userInfo.accessTokens = [];
    userInfo.accessTokens.push(accessToken);
    console.log('✅ Access token linked to user:', userInfo.userName);
  }
  
  authorizationCodes.delete(code);
  console.log('✅ OAuth access token issued for client:', client_id);
  
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: codeInfo.scope || 'mcp'
  });
});

// Server info endpoint
app.get('/', (req, res) => {
  res.json({
    name: "Slack MCP Server",
    version: "2.0.0",
    description: "Connect your Slack workspace to Claude via MCP",
    status: "ready",
    endpoints: {
      mcp: "/mcp",
      connect: "/connect",
      health: "/health"
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    connections: activeSessions.size,
    registeredTokens: registeredTokens.size,
    oauthClients: oauthClients.size
  });
});

// Registration
app.post('/register', async (req, res) => {
  const { slackToken, userInfo = {}, oauth_code } = req.body;
  
  if (!slackToken || !slackToken.startsWith('xoxp-')) {
    return res.status(400).json({ 
      success: false,
      error: 'Valid Slack token required (must start with xoxp-)' 
    });
  }
  
  try {
    const slackClient = new SlackClient(slackToken);
    const authTest = await slackClient.testAuth();
    
    const enrichedUserInfo = { 
      ...userInfo,
      slackUserId: authTest.user_id,
      teamId: authTest.team_id,
      teamName: authTest.team,
      userName: authTest.user,
      registeredAt: new Date().toISOString()
    };
    
    registeredTokens.set(slackToken, enrichedUserInfo);
    
    if (oauth_code && authorizationCodes.has(oauth_code)) {
      const codeInfo = authorizationCodes.get(oauth_code);
      codeInfo.approved = true;
      codeInfo.user_token = slackToken;
      console.log('✅ OAuth code approved for registration');
    }
    
    console.log('✅ User registered successfully:', enrichedUserInfo.userName);
    return res.json({ 
      success: true, 
      message: 'Successfully registered with Slack',
      userInfo: enrichedUserInfo
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

// Connect page
app.get('/connect', (req, res) => {
  const serverUrl = `https://${req.get('host')}`;
  const { oauth, client_id, redirect_uri, code, state } = req.query;
  const isOAuth = oauth === 'true';
  
  const html = `<!DOCTYPE html>
<html>
<head>
    <title>Connect Slack to Claude</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        .container { background: white; padding: 30px; border-radius: 10px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
        button { background: #007cba; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; width: 100%; }
        .status { margin-top: 15px; padding: 12px; border-radius: 5px; display: none; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
        .code-box { background: #f8f9fa; padding: 12px; border-radius: 5px; font-family: monospace; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Connect Slack to Claude</h1>
        ${isOAuth ? '<p><strong>OAuth Authentication:</strong> Complete the connection by registering your Slack token.</p>' : ''}
        
        <div style="margin-bottom: 20px;">
            <strong>MCP Server URL:</strong>
            <div class="code-box">${serverUrl}/mcp</div>
            <strong>Client ID:</strong>
            <div class="code-box">slack-mcp-claude-web</div>
        </div>

        <form id="registrationForm">
            <div class="form-group">
                <label for="token">Slack User Token *</label>
                <input type="text" id="token" placeholder="xoxp-your-slack-token-here" required>
                <small>Get your token from <a href="https://api.slack.com/custom-integrations/legacy-tokens" target="_blank">Slack Legacy Tokens</a></small>
            </div>
            <div class="form-group">
                <label for="name">Your Name (Optional)</label>
                <input type="text" id="name" placeholder="John Doe">
            </div>
            <button type="submit" id="submitBtn">${isOAuth ? 'Complete OAuth Connection' : 'Connect to Claude'}</button>
        </form>
        <div class="status" id="status"></div>
    </div>

    <script>
        const isOAuth = ${isOAuth};
        const oauthCode = '${code || ''}';
        const redirectUri = '${redirect_uri || ''}';
        const state = '${state || ''}';
        
        document.getElementById('registrationForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const status = document.getElementById('status');
            const submitBtn = document.getElementById('submitBtn');
            const token = document.getElementById('token').value.trim();
            const name = document.getElementById('name').value.trim();
            
            if (!token.startsWith('xoxp-')) {
                showStatus('error', 'Invalid token format. Must start with xoxp-');
                return;
            }
            
            submitBtn.disabled = true;
            submitBtn.textContent = 'Connecting...';
            showStatus('', 'Validating Slack token...');
            
            try {
                const response = await fetch('/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        slackToken: token, 
                        userInfo: { name: name || 'User' },
                        oauth_code: oauthCode || null
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showStatus('success', \`✅ Successfully connected! Welcome \${data.userInfo.userName} from \${data.userInfo.teamName}.\`);
                    
                    if (isOAuth && redirectUri) {
                        setTimeout(() => {
                            const returnUrl = new URL(redirectUri);
                            returnUrl.searchParams.set('code', oauthCode);
                            if (state) returnUrl.searchParams.set('state', state);
                            window.location.href = returnUrl.toString();
                        }, 2000);
                    }
                    
                    document.getElementById('registrationForm').style.display = 'none';
                } else {
                    showStatus('error', '❌ ' + (data.error || 'Registration failed'));
                    submitBtn.disabled = false;
                    submitBtn.textContent = isOAuth ? 'Complete OAuth Connection' : 'Connect to Claude';
                }
            } catch (error) {
                showStatus('error', '❌ Network error: ' + error.message);
                submitBtn.disabled = false;
                submitBtn.textContent = isOAuth ? 'Complete OAuth Connection' : 'Connect to Claude';
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

// SSE endpoint
app.get('/mcp', async (req, res) => {
  console.log('🔄 SSE connection request received');
  
  const auth = await authenticateRequest(req);
  if (!auth) {
    console.log('❌ SSE authentication failed');
    return res.status(401).json({
      error: 'Authentication required. Please register your Slack token first.',
      connectUrl: `https://${req.get('host')}/connect`
    });
  }

  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Cache-Control, Mcp-Session-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Mcp-Session-Id': sessionId
  });

  const session = {
    id: sessionId,
    auth: auth,
    startTime: new Date(),
    lastActivity: new Date(),
    res: res
  };
  activeSessions.set(sessionId, session);

  console.log('✅ SSE connection established:', sessionId, 'for user:', auth.userInfo.userName);

  res.write(`event: endpoint\n`);
  res.write(`data: /messages\n\n`);

  const keepAlive = setInterval(() => {
    if (activeSessions.has(sessionId)) {
      res.write(`: ping ${Date.now()}\n\n`);
      session.lastActivity = new Date();
    } else {
      clearInterval(keepAlive);
    }
  }, 30000);

  req.on('close', () => {
    console.log('🔌 SSE connection closed:', sessionId);
    clearInterval(keepAlive);
    activeSessions.delete(sessionId);
  });

  req.on('error', (error) => {
    console.error('❌ SSE connection error:', error);
    clearInterval(keepAlive);
    activeSessions.delete(sessionId);
  });
});

// Messages endpoint
app.post('/messages', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const { method, params, id } = req.body || {};
  
  console.log(`🔧 MCP Message: ${method} (session: ${sessionId})`);
  
  const session = sessionId ? activeSessions.get(sessionId) : null;
  if (!session) {
    console.log('❌ Session not found:', sessionId);
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found. Please establish SSE connection first.' },
      id
    });
  }

  session.lastActivity = new Date();

  try {
    let result;
    
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'slack-mcp-server', version: '2.0.0', description: 'Slack integration for Claude via MCP' }
        };
        break;

      case 'tools/list':
        result = {
          tools: [
            {
              name: 'slack_get_channels',
              description: 'List available Slack channels with detailed information',
              inputSchema: {
                type: 'object',
                properties: {
                  types: { type: 'string', description: 'Channel types to include', default: 'public_channel,private_channel' },
                  limit: { type: 'number', description: 'Maximum number of channels to return', default: 100 }
                }
              }
            },
            {
              name: 'slack_get_channel_history',
              description: 'Get recent messages from a specific Slack channel',
              inputSchema: {
                type: 'object',
                properties: {
                  channel: { type: 'string', description: 'Channel ID or name' },
                  limit: { type: 'number', description: 'Number of messages to retrieve', default: 20 }
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
            },
            {
              name: 'slack_get_users',
              description: 'List users in the Slack workspace',
              inputSchema: {
                type: 'object',
                properties: {
                  limit: { type: 'number', description: 'Maximum number of users to return', default: 100 }
                }
              }
            }
          ]
        };
        break;

      case 'tools/call':
        const { name, arguments: args } = params;
        const slackClient = new SlackClient(session.auth.token);
        
        try {
          result = await handleToolCall(name, args, slackClient);
          console.log('✅ Tool call completed:', name);
        } catch (error) {
          console.error('❌ Tool call failed:', error.message);
          result = {
            content: [{ type: 'text', text: `Error executing ${name}: ${error.message}` }],
            isError: true
          };
        }
        break;

      default:
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${method}` },
          id
        });
    }

    return res.json({ jsonrpc: '2.0', result, id });

  } catch (error) {
    console.error('❌ MCP Error:', error);
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error: ' + error.message },
      id
    });
  }
});

// HTTP MCP endpoint
app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body || {};
  console.log(`🔧 MCP HTTP Request: ${method}`);
  
  const auth = await authenticateRequest(req);
  if (!auth && method !== 'initialize' && method !== 'tools/list') {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Authentication required. Please register your Slack token first.' },
      id
    });
  }

  try {
    let result;
    
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'slack-mcp-server', version: '2.0.0', description: 'Slack integration for Claude via MCP' }
        };
        break;

      case 'tools/list':
        result = {
          tools: [
            {
              name: 'slack_get_channels',
              description: 'List available Slack channels',
              inputSchema: {
                type: 'object',
                properties: {
                  types: { type: 'string', default: 'public_channel,private_channel' },
                  limit: { type: 'number', default: 100 }
                }
              }
            },
            {
              name: 'slack_get_channel_history',
              description: 'Get recent messages from a Slack channel',
              inputSchema: {
                type: 'object',
                properties: {
                  channel: { type: 'string' },
                  limit: { type: 'number', default: 20 }
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
                  channel: { type: 'string' },
                  text: { type: 'string' }
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
                  limit: { type: 'number', default: 100 }
                }
              }
            }
          ]
        };
        break;

      case 'tools/call':
        const { name, arguments: args } = params;
        const slackClient = new SlackClient(auth.token);
        
        try {
          result = await handleToolCall(name, args, slackClient);
        } catch (error) {
          result = {
            content: [{ type: 'text', text: `Error executing ${name}: ${error.message}` }],
            isError: true
          };
        }
        break;

      default:
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${method}` },
          id
        });
    }

    return res.json({ jsonrpc: '2.0', result, id });

  } catch (error) {
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error: ' + error.message },
      id
    });
  }
});

// Tool handler
async function handleToolCall(name, args, slackClient) {
  switch (name) {
    case 'slack_get_channels':
      const channels = await slackClient.getChannels(args?.types || 'public_channel,private_channel', args?.limit || 100);
      const channelList = channels.channels.map(ch => {
        const memberCount = ch.num_members ? ` (${ch.num_members} members)` : '';
        const purpose = ch.purpose?.value || ch.topic?.value || 'No description';
        return `• **#${ch.name}** (${ch.id})${memberCount}\n  ${purpose}`;
      }).join('\n\n');
      
      return {
        content: [{ type: 'text', text: `Found ${channels.channels.length} channels:\n\n${channelList}` }]
      };

    case 'slack_get_channel_history':
      const history = await slackClient.getChannelHistory(args.channel, args?.limit || 20);
      const messages = history.messages.reverse().map(msg => {
        const userName = msg.user || 'Unknown';
        const timestamp = new Date(parseFloat(msg.ts) * 1000).toLocaleString();
        const text = msg.text || '[No text content]';
        return `**${userName}** (${timestamp})\n${text}`;
      }).join('\n\n---\n\n');
      
      return {
        content: [{ type: 'text', text: `Recent messages in ${args.channel}:\n\n${messages}` }]
      };

    case 'slack_send_message':
      const sendResult = await slackClient.sendMessage(args.channel, args.text);
      return {
        content: [{ type: 'text', text: `✅ Message sent successfully to ${args.channel}!\nMessage timestamp: ${sendResult.ts}` }]
      };

    case 'slack_get_users':
      const usersData = await slackClient.getUsers(args?.limit || 100);
      const userList = usersData.members
        .filter(user => !user.deleted && !user.is_bot)
        .map(user => {
          const profile = user.profile || {};
          return `**${profile.real_name || user.name}** (@${user.name})`;
        })
        .join('\n');
      
      return {
        content: [{ type: 'text', text: `Users in workspace:\n\n${userList}` }]
      };

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

process.on('SIGTERM', () => {
  console.log('🛑 Server shutting down...');
  activeSessions.clear();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server v2.0 running on port ${PORT}`);
  console.log(`📱 Connect at: https://your-domain.com/connect`);
  console.log(`🔗 MCP endpoint: https://your-domain.com/mcp`);
  console.log(`🔐 Pre-registered clients: ${Array.from(oauthClients.keys()).join(', ')}`);
  console.log(`💡 Use client_id: 'slack-mcp-claude-web' when adding to Claude`);
  console.log(`📊 Ready for Claude integration`);
});