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

// Handle preflight requests
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage
const registeredTokens = new Map(); // token -> userInfo
const activeSessions = new Map(); // sessionId -> session info
const oauthClients = new Map(); // clientId -> client info
const authorizationCodes = new Map(); // code -> token info

// Enhanced SlackClient
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

  async testAuth() { 
    return await this.makeRequest('auth.test'); 
  }
  
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

// Enhanced authentication - support both Bearer tokens and OAuth tokens
async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.log('🔍 No authorization header found');
    return null;
  }

  const token = authHeader.replace('Bearer ', '');
  
  // Check if it's a registered Slack token
  if (token.startsWith('xoxp-')) {
    const userInfo = registeredTokens.get(token);
    if (!userInfo) {
      console.log('🔍 Slack token not found in registered tokens');
      return null;
    }
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

  console.log('🔍 Token not recognized:', token.substring(0, 10) + '...');
  return null;
}

// OAuth Discovery endpoint (required for MCP)
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

// Dynamic Client Registration (required for Claude MCP)
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
  
  const { 
    client_id, 
    redirect_uri, 
    response_type, 
    scope, 
    state, 
    code_challenge, 
    code_challenge_method 
  } = req.query;
  
  // Validate client
  const client = oauthClients.get(client_id);
  if (!client) {
    return res.status(400).json({
      error: 'invalid_client',
      error_description: 'Invalid client_id'
    });
  }
  
  // Validate redirect URI
  if (!client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Invalid redirect_uri'
    });
  }
  
  // Generate authorization code
  const authCode = `mcp_code_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const codeInfo = {
    client_id,
    redirect_uri,
    scope: scope || 'mcp',
    state,
    code_challenge,
    code_challenge_method,
    created_at: new Date(),
    expires_at: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
  };
  
  authorizationCodes.set(authCode, codeInfo);
  
  // Auto-approve for registered users or redirect to connect page
  if (registeredTokens.size > 0) {
    // Auto-approve with the first registered token
    const [firstToken, userInfo] = Array.from(registeredTokens.entries())[0];
    codeInfo.approved = true;
    codeInfo.user_token = firstToken;
    
    console.log('✅ Auto-approved OAuth for user:', userInfo.userName);
    
    // Redirect back to Claude
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', authCode);
    if (state) redirectUrl.searchParams.set('state', state);
    
    return res.redirect(redirectUrl.toString());
  }
  
  // Redirect to connect page for token registration
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
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid authorization code'
    });
  }
  
  // Check if code is expired
  if (new Date() > codeInfo.expires_at) {
    authorizationCodes.delete(code);
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Authorization code expired'
    });
  }
  
  // Validate client
  const client = oauthClients.get(client_id);
  if (!client || (client.client_secret && client.client_secret !== client_secret)) {
    return res.status(400).json({
      error: 'invalid_client',
      error_description: 'Invalid client credentials'
    });
  }
  
  // Generate access token
  const accessToken = `mcp_access_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  // Store access token with user info
  if (codeInfo.user_token && registeredTokens.has(codeInfo.user_token)) {
    const userInfo = registeredTokens.get(codeInfo.user_token);
    if (!userInfo.accessTokens) userInfo.accessTokens = [];
    userInfo.accessTokens.push(accessToken);
  }
  
  // Clean up authorization code
  authorizationCodes.delete(code);
  
  console.log('✅ OAuth access token issued:', accessToken.substring(0, 20) + '...');
  
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
    server: "slack-mcp-server",
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    },
    protocolVersion: "2024-11-05",
    status: "ready",
    endpoints: {
      mcp: "/mcp",
      connect: "/connect",
      health: "/health",
      oauth: {
        discovery: "/.well-known/oauth-authorization-server",
        register: "/oauth/register",
        authorize: "/oauth/authorize",
        token: "/oauth/token"
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    connections: activeSessions.size,
    registeredTokens: registeredTokens.size,
    oauthClients: oauthClients.size
  });
});

// Enhanced registration
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
    
    // If there's an OAuth code, approve it
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
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        }
        .container { 
            background: white; padding: 40px; border-radius: 16px; 
            box-shadow: 0 20px 40px rgba(0,0,0,0.1); max-width: 500px; width: 100%;
        }
        h1 { color: #2d3748; margin-bottom: 8px; font-size: 28px; text-align: center; }
        .subtitle { color: #718096; text-align: center; margin-bottom: 32px; }
        .info-box { 
            background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; 
            padding: 16px; margin-bottom: 24px; font-size: 14px; line-height: 1.5;
        }
        .oauth-box {
            background: #e6f3ff; border: 1px solid #3182ce; border-radius: 8px;
            padding: 16px; margin-bottom: 24px; font-size: 14px; line-height: 1.5;
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
            cursor: pointer; transition: background-color 0.2s;
        }
        button:hover { background: #5a67d8; }
        button:disabled { background: #a0aec0; cursor: not-allowed; }
        .status { 
            margin-top: 20px; padding: 12px; border-radius: 8px; display: none;
            font-weight: 500;
        }
        .success { background: #f0fff4; color: #22543d; border: 1px solid #68d391; }
        .error { background: #fed7d7; color: #c53030; border: 1px solid #fc8181; }
        .loading { background: #ebf8ff; color: #2a69ac; border: 1px solid #63b3ed; }
        .step { margin-bottom: 24px; }
        .step-number { 
            display: inline-block; width: 24px; height: 24px; 
            background: #667eea; color: white; border-radius: 50%; 
            text-align: center; line-height: 24px; font-size: 14px; font-weight: 600;
            margin-right: 8px;
        }
        .code-box { 
            background: #1a202c; color: #e2e8f0; padding: 12px; border-radius: 6px; 
            font-family: 'Monaco', 'Consolas', monospace; font-size: 14px; 
            word-break: break-all; margin: 8px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Connect Slack to Claude</h1>
        <p class="subtitle">Integrate your Slack workspace with Claude's AI assistant</p>
        
        ${isOAuth ? `
        <div class="oauth-box">
            <strong>🔐 OAuth Authentication</strong><br>
            Claude is requesting access to your Slack workspace. Please register your token to complete the connection.
        </div>
        ` : ''}
        
        <div class="step">
            <div><span class="step-number">1</span><strong>MCP Server URL</strong></div>
            <div class="info-box">
                Use this URL when adding the MCP server to Claude:
                <div class="code-box">${serverUrl}/mcp</div>
            </div>
        </div>

        <div class="step">
            <div><span class="step-number">2</span><strong>Get Your Slack Token</strong></div>
            <div class="info-box">
                Visit <a href="https://api.slack.com/custom-integrations/legacy-tokens" target="_blank">Slack Legacy Tokens</a> 
                to get your user token (starts with xoxp-).
            </div>
        </div>

        <div class="step">
            <div><span class="step-number">3</span><strong>Register Your Token</strong></div>
            <form id="registrationForm">
                <div class="form-group">
                    <label for="token">Slack User Token *</label>
                    <input type="text" id="token" placeholder="xoxp-your-slack-token-here" required>
                </div>
                <div class="form-group">
                    <label for="name">Your Name (Optional)</label>
                    <input type="text" id="name" placeholder="John Doe">
                </div>
                <button type="submit" id="submitBtn">${isOAuth ? 'Complete OAuth Connection' : 'Connect to Claude'}</button>
            </form>
            <div class="status" id="status"></div>
        </div>
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
            showStatus('loading', 'Validating Slack token...');
            
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
                    showStatus('success', 
                        \`✅ Successfully connected! Welcome \${data.userInfo.userName} from \${data.userInfo.teamName}.\`);
                    
                    if (isOAuth && redirectUri) {
                        showStatus('success', '🔄 Redirecting back to Claude...');
                        setTimeout(() => {
                            const returnUrl = new URL(redirectUri);
                            returnUrl.searchParams.set('code', oauthCode);
                            if (state) returnUrl.searchParams.set('state', state);
                            window.location.href = returnUrl.toString();
                        }, 2000);
                    } else {
                        showStatus('success', 'Your Slack workspace is now ready to use with Claude!');
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

// SSE endpoint following MCP specification
app.get('/mcp', async (req, res) => {
  console.log('🔄 SSE connection request received');
  console.log('🔄 Authorization header:', req.headers.authorization ? 'Present' : 'Missing');
  
  // Authenticate the request
  const auth = await authenticateRequest(req);
  if (!auth) {
    console.log('❌ SSE authentication failed');
    return res.status(401).json({
      error: 'Authentication required. Please register your Slack token first.',
      connectUrl: `https://${req.get('host')}/connect`
    });
  }

  // Generate session ID
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Cache-Control, Mcp-Session-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Mcp-Session-Id': sessionId
  });

  // Store session
  const session = {
    id: sessionId,
    auth: auth,
    startTime: new Date(),
    lastActivity: new Date(),
    res: res
  };
  activeSessions.set(sessionId, session);

  console.log('✅ SSE connection established:', sessionId, 'for user:', auth.userInfo.userName);

  // Send initial endpoint message as required by MCP SSE spec
  res.write(`event: endpoint\n`);
  res.write(`data: /messages\n\n`);

  // Keep connection alive with ping events
  const keepAlive = setInterval(() => {
    if (activeSessions.has(sessionId)) {
      res.write(`: ping ${Date.now()}\n\n`);
      session.lastActivity = new Date();
    } else {
      clearInterval(keepAlive);
    }
  }, 30000);

  // Handle client disconnect
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

// Messages endpoint for POST requests (required by MCP SSE spec)
app.post('/messages', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const { method, params, id } = req.body || {};
  
  console.log(`🔧 MCP Message: ${method} (session: ${sessionId})`);
  
  // Find session
  const session = sessionId ? activeSessions.get(sessionId) : null;
  if (!session) {
    console.log('❌ Session not found:', sessionId);
    return res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Session not found. Please establish SSE connection first.'
      },
      id
    });
  }

  // Update session activity
  session.lastActivity = new Date();

  try {
    let result;
    
    switch (method) {
      case 'initialize':
        console.log('🔧 Initialize request');
        result = {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {}
          },
          serverInfo: {
            name: 'slack-mcp-server',
            version: '2.0.0',
            description: 'Slack integration for Claude via MCP'
          }
        };
        break;

      case 'tools/list':
        console.log('🔧 Tools list request');
        result = {
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
        break;

      case 'tools/call':
        console.log('🔧 Tool call request:', params?.name);
        
        const { name, arguments: args } = params;
        const slackClient = new SlackClient(session.auth.token);
        
        try {
          result = await handleToolCall(name, args, slackClient);
          console.log('✅ Tool call completed:', name);
        } catch (error) {
          console.error('❌ Tool call failed:', error.message);
          result = {
            content: [{ 
              type: 'text', 
              text: `Error executing ${name}: ${error.message}` 
            }],
            isError: true
          };
        }
        break;

      default:
        console.log('❌ Unknown method:', method);
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { 
            code: -32601, 
            message: `Method not found: ${method}` 
          },
          id
        });
    }

    // Send response
    const response = {
      jsonrpc: '2.0',
      result,
      id
    };

    return res.json(response);

  } catch (error) {
    console.error('❌ MCP Error:', error);
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { 
        code: -32603, 
        message: 'Internal error: ' + error.message 
      },
      id
    });
  }
});

// Main MCP POST endpoint for HTTP transport
app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body || {};
  
  console.log(`🔧 MCP HTTP Request: ${method}`);
  
  // For HTTP transport, authenticate on each request (except for discovery)
  const auth = await authenticateRequest(req);
  if (!auth && method !== 'initialize' && method !== 'tools/list') {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Authentication required. Please register your Slack token first.',
        data: {
          connectUrl: `https://${req.get('host')}/connect`
        }
      },
      id
    });
  }

  try {
    let result;
    
    switch (method) {
      case 'initialize':
        console.log('🔧 HTTP Initialize request');
        result = {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {}
          },
          serverInfo: {
            name: 'slack-mcp-server',
            version: '2.0.0',
            description: 'Slack integration for Claude via MCP'
          }
        };
        break;

      case 'tools/list':
        console.log('🔧 HTTP Tools list request');
        result = {
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
        break;

      case 'tools/call':
        console.log('🔧 HTTP Tool call request:', params?.name);
        
        const { name, arguments: args } = params;
        const slackClient = new SlackClient(auth.token);
        
        try {
          result = await handleToolCall(name, args, slackClient);
          console.log('✅ HTTP Tool call completed:', name);
        } catch (error) {
          console.error('❌ HTTP Tool call failed:', error.message);
          result = {
            content: [{ 
              type: 'text', 
              text: `Error executing ${name}: ${error.message}` 
            }],
            isError: true
          };
        }
        break;

      default:
        console.log('❌ Unknown HTTP method:', method);
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { 
            code: -32601, 
            message: `Method not found: ${method}` 
          },
          id
        });
    }

    return res.json({
      jsonrpc: '2.0',
      result,
      id
    });

  } catch (error) {
    console.error('❌ MCP HTTP Error:', error);
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { 
        code: -32603, 
        message: 'Internal error: ' + error.message 
      },
      id
    });
  }
});

// Tool call handler
async function handleToolCall(name, args, slackClient) {
  switch (name) {
    case 'slack_get_channels':
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

    case 'slack_get_channel_history':
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

    case 'slack_send_message':
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

    case 'slack_get_users':
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

    case 'slack_get_channel_info':
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Cleanup on shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Server shutting down...');
  activeSessions.clear();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server v2.0 running on port ${PORT}`);
  console.log(`📱 Connect at: https://your-domain.com/connect`);
  console.log(`🔗 MCP endpoint: https://your-domain.com/mcp`);
  console.log(`🔐 OAuth discovery: https://your-domain.com/.well-known/oauth-authorization-server`);
  console.log(`📊 Ready for Claude integration`);
});