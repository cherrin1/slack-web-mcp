// server.js - Main server file (simplified)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { WebClient } from "@slack/web-api";
import crypto from "crypto";
import { randomUUID } from "node:crypto";
import { registerSlackTools } from "./tools.js";
import { registerSlackResources } from "./resources.js";

const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const MCP_SECRET = process.env.MCP_SECRET || crypto.randomBytes(32).toString('hex');

// Validate required environment variables
if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
  console.error('❌ Missing required environment variables: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET');
  process.exit(1);
}

console.log('✅ Environment variables loaded');

// Enhanced storage for multi-user support
const userTokens = new Map(); // Maps "teamId:userId" to Slack token data
const mcpTransports = new Map(); // Maps MCP session ID to transport
const sessionUsers = new Map(); // Maps MCP session ID to user token data
const claudeTokens = new Map(); // Maps Claude access tokens to user identity

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function to get base URL
function getBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || 'https';
  const host = req.get('host');
  return `${protocol}://${host}`;
}

// Get user-specific token data from Claude auth token
function getUserTokenData(claudeToken) {
  const tokenMapping = claudeTokens.get(claudeToken);
  if (!tokenMapping) {
    return null;
  }
  
  const tokenKey = `${tokenMapping.team_id}:${tokenMapping.user_id}`;
  return userTokens.get(tokenKey);
}

// Create MCP server instance (enhanced for user context)
function createMCPServer(tokenData, sessionId) {
  const server = new McpServer({
    name: "Slack",
    version: "1.0.0"
  });

  console.log(`🔧 Creating MCP server for ${tokenData.user_name} (${tokenData.team_name}) - Session: ${sessionId}`);

  // Register resources from external file
  registerSlackResources(server, tokenData, sessionId);

  // Register tools from external file
  registerSlackTools(server, tokenData, sessionId);

  // Log critical user proxy reminder
  console.log(`🚨 USER PROXY MODE: All Slack communications will appear as ${tokenData.user_name} (${tokenData.team_name})`);
  console.log(`📋 Available resources: system-initialization, user-proxy-guidelines, message-formatting-guidelines`);
  console.log(`🔧 Available tools: send message, DM, get channels/users, search, reactions, files`);
  console.log(`🚫 FILE SHARING: NO markdown formatting, NO technical descriptions, use simple natural messages`);

  return server;
}

// Enhanced MCP Token endpoint - user-specific tokens
app.post('/token', express.json(), (req, res) => {
  const { code, state } = req.body;
  
  console.log('Token exchange request from Claude:', { code: !!code, state });
  
  if (!code) {
    return res.status(400).json({ 
      error: 'invalid_request', 
      error_description: 'Missing authorization code' 
    });
  }
  
  // Look up the auth mapping with user context
  const authMapping = claudeTokens.get(`claude_auth_${code}`);
  
  if (!authMapping) {
    return res.status(400).json({ 
      error: 'invalid_grant', 
      error_description: 'Authorization code not found or expired' 
    });
  }
  
  // Clean up the auth code
  claudeTokens.delete(`claude_auth_${code}`);
  
  // Create user-specific access token with Claude user context
  const accessToken = `mcp_${authMapping.claude_user_id}_${authMapping.team_id}_${authMapping.user_id}_${Date.now()}`;
  
  // Store the mapping for this specific Claude user
  claudeTokens.set(accessToken, {
    team_id: authMapping.team_id,
    user_id: authMapping.user_id,
    claude_user_id: authMapping.claude_user_id,
    created_at: new Date().toISOString()
  });
  
  console.log(`🎫 Issued individual MCP token for Claude user ${authMapping.claude_user_id} → Slack ${authMapping.team_id}:${authMapping.user_id}`);
  
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'slack:read slack:write',
    user_context: {
      claude_user_id: authMapping.claude_user_id,
      slack_team_id: authMapping.team_id,
      slack_user_id: authMapping.user_id
    }
  });
});

// Simplified auth page for Claude web users
app.get('/simple-auth', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  const state = 'claude-web-' + crypto.randomBytes(16).toString('hex');
  const scopes = 'channels:read chat:write users:read channels:history im:history mpim:history search:read groups:read mpim:read channels:write groups:write im:write files:write files:read reactions:read reactions:write';
  
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&user_scope=${encodeURIComponent(scopes)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Slack MCP Server - Multi-User Setup</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
        .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .button { display: inline-block; padding: 12px 24px; background: #4A154B; color: white; text-decoration: none; border-radius: 5px; margin: 10px; }
        .step { margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 5px; text-align: left; }
        .code { background: #e9ecef; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
        .info { background: #d4edda; border: 1px solid #c3e6cb; padding: 10px; border-radius: 5px; margin: 10px 0; }
        .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 5px; margin: 10px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔐 Slack MCP Server Setup</h1>
        
        <div class="info">
          <strong>🔒 Secure Individual Access:</strong> Each person must authenticate with their own Slack account. No shared access allowed.
        </div>

        <div class="warning">
          <strong>🚨 USER PROXY MODE:</strong> When you connect, Claude will act AS YOU on Slack. All messages will appear with your name and profile.
        </div>
        
        <div class="step">
          <strong>Step 1:</strong> Connect Your Slack Account
          <br><br>
          <a href="${authUrl}" class="button">🔗 Connect My Slack Account</a>
          <br><small>This will connect YOUR Slack account specifically</small>
        </div>
        
        <div class="step">
          <strong>Step 2:</strong> Configure Claude
          <br><br>
          After authentication, use this URL in Claude:
          <br><code class="code">${baseUrl}/mcp</code>
        </div>
        
        <div class="step">
          <strong>Step 3:</strong> Test Your Connection
          <br><br>
          In Claude, try: "Show me my Slack channels"
        </div>
        
        <p><strong>Server Status:</strong> 
          <span style="color: green;">✅ Online</span> | 
          <span style="color: ${userTokens.size > 0 ? 'green' : 'orange'};">
            Connected Users: ${userTokens.size}
          </span>
        </p>
        
        <p><small>⚠️ Each user must authenticate individually. You cannot use someone else's Slack connection.</small></p>
      </div>
    </body>
    </html>
  `);
});

// MCP Authorization endpoint for Claude - now user-specific
app.get('/authorize', (req, res) => {
  const { state, redirect_uri } = req.query;
  
  if (!state || !redirect_uri) {
    return res.status(400).json({ 
      error: 'Missing required parameters', 
      details: 'state and redirect_uri are required' 
    });
  }
  
  // Generate unique identifier for this Claude user session
  const claudeUserId = `claude_${crypto.randomBytes(16).toString('hex')}`;
  
  // Store Claude's redirect info with user identifier
  const authSession = {
    claude_user_id: claudeUserId,
    claude_state: state,
    claude_redirect_uri: redirect_uri,
    timestamp: Date.now()
  };
  
  // Store session with unique key
  const sessionKey = `auth_${claudeUserId}_${crypto.randomBytes(8).toString('hex')}`;
  userTokens.set(sessionKey, authSession);
  
  // Redirect to Slack OAuth with user context
  const baseUrl = getBaseUrl(req);
  const slackOAuthUrl = `${baseUrl}/oauth/slack?auth_session=${sessionKey}&claude_user=${claudeUserId}`;
  
  console.log(`🔐 Claude user ${claudeUserId} starting OAuth flow`);
  res.redirect(slackOAuthUrl);
});

// OAuth endpoints with user context
app.get('/oauth/slack', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  console.log('OAuth request - Base URL:', baseUrl);
  console.log('OAuth request - Redirect URI:', redirectUri);
  
  // Get auth session and user context from query params
  const authSession = req.query.auth_session;
  const claudeUser = req.query.claude_user;
  
  const state = authSession || crypto.randomBytes(16).toString('hex');
  const scopes = 'channels:read chat:write users:read channels:history im:history mpim:history search:read groups:read mpim:read channels:write groups:write im:write files:write files:read reactions:read reactions:write';
  
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&user_scope=${encodeURIComponent(scopes)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  console.log(`🔗 OAuth redirect for Claude user ${claudeUser || 'unknown'}:`, authUrl);
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  const { code, state, error } = req.query;
  
  console.log('OAuth callback received:', { code: !!code, state, error });
  
  if (error) {
    console.error('OAuth error received:', error);
    return res.status(400).json({ error: 'OAuth error', details: error });
  }
  
  if (!code) {
    console.error('No authorization code received');
    return res.status(400).json({ error: 'Missing authorization code' });
  }
  
  try {
    console.log('Exchanging code for token...');
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: SLACK_CLIENT_ID,
        client_secret: SLACK_CLIENT_SECRET,
        code: code,
        redirect_uri: redirectUri,
      }),
    });
    
    const data = await response.json();
    console.log('OAuth response:', JSON.stringify(data, null, 2));
    
    if (!data.ok) {
      console.error('OAuth token exchange failed:', data.error);
      return res.status(400).json({ error: 'OAuth token exchange failed', details: data.error });
    }
    
    // Store the token with enhanced user context
    const userId = data.authed_user.id;
    const teamId = data.team.id;
    const tokenKey = `${teamId}:${userId}`;
    
    // Try to get a better user name by calling the Slack API
    let userName = data.authed_user.name || 'Unknown';
    try {
      const tempSlack = new WebClient(data.authed_user.access_token);
      const userInfo = await tempSlack.users.info({ user: userId });
      userName = userInfo.user.real_name || userInfo.user.name || userInfo.user.profile?.display_name || data.authed_user.name || `User_${userId.substring(0, 8)}`;
    } catch (e) {
      console.log('Could not fetch user details, using fallback name');
      userName = data.authed_user.name || `User_${userId.substring(0, 8)}`;
    }

    const tokenData = {
      access_token: data.authed_user.access_token,
      team_id: teamId,
      user_id: userId,
      team_name: data.team.name,
      user_name: userName,
      scope: data.authed_user.scope,
      created_at: new Date().toISOString()
    };
    
    userTokens.set(tokenKey, tokenData);
    console.log(`✅ Slack token stored for user: ${tokenData.user_name} (${tokenKey})`);
    
    // Check if this was initiated from Claude
    const authSession = userTokens.get(state);
    
    if (authSession && authSession.claude_user_id) {
      // This was initiated from Claude - redirect back to Claude with user-specific token
      console.log(`Redirecting Claude user ${authSession.claude_user_id} back to Claude`);
      
      // Clean up the session
      userTokens.delete(state);
      
      // Create an authorization code for Claude with user context
      const claudeAuthCode = crypto.randomBytes(32).toString('hex');
      
      // Store the mapping between auth code and SPECIFIC user token
      claudeTokens.set(`claude_auth_${claudeAuthCode}`, {
        team_id: teamId,
        user_id: userId,
        claude_user_id: authSession.claude_user_id,
        created_at: new Date().toISOString()
      });
      
      // Redirect back to Claude with authorization code
      const claudeCallbackUrl = `${authSession.claude_redirect_uri}?code=${claudeAuthCode}&state=${authSession.claude_state}`;
      
      console.log(`Redirecting Claude user ${authSession.claude_user_id} back with callback URL`);
      
      // Show success page with user-specific information and proxy warning
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Individual Authentication Successful</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
            .container { max-width: 450px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .success { color: #28a745; font-size: 18px; margin-bottom: 20px; }
            .info { color: #666; margin-bottom: 20px; }
            .button { display: inline-block; padding: 10px 20px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; }
            .spinner { border: 2px solid #f3f3f3; border-top: 2px solid #007bff; border-radius: 50%; width: 20px; height: 20px; animation: spin 1s linear infinite; margin: 20px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .highlight { background: #e7f3ff; padding: 10px; border-radius: 5px; margin: 10px 0; }
            .security { background: #d4edda; border: 1px solid #c3e6cb; padding: 10px; border-radius: 5px; margin: 10px 0; }
            .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 5px; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Your Personal Slack Connection!</h1>
            <div class="success">Your individual Slack account has been connected to Claude.</div>
            
            <div class="security">
              <strong>🔒 Private Connection:</strong> This connection is yours alone. Other Claude users cannot access your Slack account.
            </div>

            <div class="warning">
              <strong>🚨 USER PROXY MODE:</strong> Claude will now act AS YOU on Slack. All messages will appear with your name and profile.
            </div>
            
            <div class="highlight">
              <strong>Your Connection Details:</strong><br>
              <strong>Workspace:</strong> ${data.team.name}<br>
              <strong>Your Name:</strong> ${userName}<br>
              <strong>Claude User:</strong> ${authSession.claude_user_id.substring(0, 12)}...<br>
              <strong>Permissions:</strong> ${data.authed_user.scope.split(',').length} scopes
            </div>
            <div class="spinner"></div>
            <p>Redirecting back to Claude...</p>
            <p><a href="${claudeCallbackUrl}" class="button">Continue to Claude</a></p>
          </div>
          <script>
            // Auto-redirect after 3 seconds
            setTimeout(() => {
              window.location.href = "${claudeCallbackUrl}";
            }, 3000);
          </script>
        </body>
        </html>
      `);
    } else {
      // Direct Slack auth - show success message
      res.json({ 
        success: true, 
        message: 'Successfully authenticated with Slack',
        user_data: {
          team: data.team.name,
          user: userName,
          team_id: teamId,
          user_id: userId,
          scopes: data.authed_user.scope.split(',').length
        },
        next_step: 'You can now connect this server to Claude using the MCP endpoint'
      });
    }
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Debug endpoint to show connected users
app.get('/debug/users', async (req, res) => {
  const connectedUsers = Array.from(userTokens.entries())
    .filter(([key, value]) => key.includes(':') && value.access_token)
    .map(([key, value]) => ({
      key: key,
      team_name: value.team_name,
      user_name: value.user_name,
      scopes: value.scope ? value.scope.split(',').length : 0,
      created_at: value.created_at
    }));
  
  const activeSessions = Array.from(sessionUsers.entries()).map(([sessionId, tokenData]) => ({
    session_id: sessionId,
    user_name: tokenData.user_name,
    team_name: tokenData.team_name
  }));
  
  res.json({
    success: true,
    connected_users: connectedUsers,
    active_mcp_sessions: activeSessions,
    claude_tokens: claudeTokens.size,
    total_users: connectedUsers.length
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    connected_users: userTokens.size,
    active_sessions: mcpTransports.size,
    claude_tokens: claudeTokens.size
  });
});

// Info endpoint
app.get('/info', (req, res) => {
  const baseUrl = getBaseUrl(req);
  
  res.json({
    app_name: 'Slack MCP Server - Multi-User',
    version: '2.0.0',
    base_url: baseUrl,
    status: 'online',
    authentication: {
      connected_users: userTokens.size,
      active_sessions: mcpTransports.size,
      claude_tokens: claudeTokens.size,
      slack_teams: Array.from(userTokens.entries())
        .filter(([key, value]) => key.includes(':') && value.team_name)
        .map(([key, value]) => ({
          team_name: value.team_name,
          user_name: value.user_name,
          team_id: value.team_id
        }))
    },
    endpoints: {
      simple_auth: `${baseUrl}/simple-auth`,
      oauth_slack: `${baseUrl}/oauth/slack`,
      mcp_endpoint: `${baseUrl}/mcp`,
      debug_users: `${baseUrl}/debug/users`,
      health_check: `${baseUrl}/health`
    },
    features: [
      "🔒 Individual authentication required",
      "🚫 No shared or fallback tokens",
      "👤 Each user must connect their own Slack", 
      "📊 User activity tracking",
      "🎫 Secure token isolation",
      "🚨 User Proxy Mode with file sharing guidelines"
    ]
  });
});

// Add CORS middleware for Claude integration
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, mcp-session-id');
  res.header('Access-Control-Expose-Headers', 'mcp-session-id');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Enhanced MCP endpoint with smart user selection
app.post('/mcp', async (req, res) => {
  console.log('📡 MCP request received:', req.body?.method || 'unknown');
  
  try {
    const sessionId = req.headers['mcp-session-id'] || randomUUID();
    let transport = mcpTransports.get(sessionId);
    
    // Handle initialize request with smart user selection
    if (req.body?.method === 'initialize') {
      console.log('🚀 Initialize request - session:', sessionId);
      
      if (!transport) {
        // Get user token data - NO FALLBACKS, user must authenticate themselves
        let tokenData = null;
        
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          const token = authHeader.substring(7);
          tokenData = getUserTokenData(token);
          
          if (tokenData) {
            console.log(`🎫 Using authenticated token for ${tokenData.user_name}`);
          } else {
            console.log('❌ Invalid or expired token provided');
            return res.status(401).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'Invalid or expired authentication token. Please re-authenticate via /simple-auth.'
              },
              id: req.body?.id || null
            });
          }
        } else if (sessionUsers.has(sessionId)) {
          tokenData = sessionUsers.get(sessionId);
          console.log(`🔄 Reusing session for ${tokenData.user_name}`);
        } else {
          // NO FALLBACK - user must authenticate
          console.log('❌ No authentication provided - user must authenticate');
          return res.status(401).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Authentication required. Please authenticate with your own Slack account via /simple-auth first.'
            },
            id: req.body?.id || null
          });
        }
        
        console.log(`✅ Creating session for user: ${tokenData.user_name} (${tokenData.team_name})`);
        
        // Create new transport for this session
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          onsessioninitialized: (sid) => {
            console.log('📡 MCP session initialized:', sid);
          }
        });
        
        transport.onclose = () => {
          console.log('📡 MCP session closed:', sessionId);
          mcpTransports.delete(sessionId);
          sessionUsers.delete(sessionId);
        };
        
        mcpTransports.set(sessionId, transport);
        sessionUsers.set(sessionId, tokenData);
        
        // Create user-specific MCP server
        const mcpServer = createMCPServer(tokenData, sessionId);
        
        // Connect server to transport
        await mcpServer.connect(transport);
        
        console.log(`✅ MCP server connected for ${tokenData.user_name}`);
        console.log(`🚨 REMINDER: Claude is now acting as ${tokenData.user_name} in all Slack communications`);
      }
      
      // Handle the initialize request
      await transport.handleRequest(req, res, req.body);
      return;
    }
    
    // For other requests, check if transport exists
    if (!transport) {
      console.log('❌ No transport found for session:', sessionId);
      return res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Session not found. Please initialize first.'
        },
        id: req.body?.id || null
      });
    }
    
    // Handle the request through the existing transport
    await transport.handleRequest(req, res, req.body);
    
  } catch (error) {
    console.error('❌ MCP endpoint error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error',
        details: error.message
      },
      id: req.body?.id || null
    });
  }
});

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  if (!sessionId) {
    return res.status(400).send('Missing session ID');
  }
  
  const transport = mcpTransports.get(sessionId);
  
  if (!transport) {
    return res.status(404).send('Session not found');
  }
  
  try {
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('❌ MCP GET error:', error);
    res.status(500).send('Internal server error');
  }
});

// Handle DELETE requests for session termination
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  if (!sessionId) {
    return res.status(400).send('Missing session ID');
  }
  
  const transport = mcpTransports.get(sessionId);
  
  if (!transport) {
    return res.status(404).send('Session not found');
  }
  
  try {
    await transport.handleRequest(req, res);
    mcpTransports.delete(sessionId);
    sessionUsers.delete(sessionId);
    console.log('🗑️ Session terminated:', sessionId);
  } catch (error) {
    console.error('❌ MCP DELETE error:', error);
    res.status(500).send('Internal server error');
  }
});

// Start the Express server
app.listen(port, () => {
  console.log(`🚀 Multi-User Slack MCP Server listening on port ${port}`);
  console.log(`❤️ Health check: http://localhost:${port}/health`);
  console.log(`📝 Info: http://localhost:${port}/info`);
  console.log(`👥 Simple auth: http://localhost:${port}/simple-auth`);
  console.log(`🔌 MCP Endpoint: http://localhost:${port}/mcp`);
  console.log(`🚨 USER PROXY MODE: All communications appear as the authenticated user`);
  console.log(`🚫 FILE SHARING: Enhanced validation with natural message filtering`);
});

// Handle process termination
process.on('SIGINT', async () => {
  console.log('Shutting down multi-user server...');
  
  // Close all MCP transports
  for (const [sessionId, transport] of mcpTransports) {
    try {
      await transport.close();
      console.log(`Closed MCP transport for session: ${sessionId}`);
    } catch (error) {
      console.error(`Error closing transport ${sessionId}:`, error);
    }
  }
  
  process.exit(0);
});

export default app;
