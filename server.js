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

// Main routes
app.get('/', (req, res) => {
  res.json({
    name: "Slack MCP Server",
    version: "1.0.0", 
    status: "running"
  });
});

// OAuth endpoints
app.get('/oauth/authorize', (req, res) => {
  console.log('OAuth authorize called');
  const { client_id, redirect_uri, state } = req.query;
  
  const authCode = 'code_' + Date.now();
  const baseUrl = `https://${req.get('host')}`;
  
  const connectUrl = `${baseUrl}/connect?auth_code=${authCode}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state || ''}`;
  
  console.log('Redirecting to:', connectUrl);
  res.redirect(302, connectUrl);
});

app.post('/oauth/token', (req, res) => {
  console.log('Token request:', req.body);
  
  const { code } = req.body;
  const slackToken = oauthCodes.get(code);
  
  if (!slackToken) {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  
  oauthCodes.delete(code);
  
  // Return the actual Slack token as the access token
  const tokenResponse = {
    access_token: slackToken,
    token_type: 'bearer',
    expires_in: 31536000
  };
  
  console.log('Issued token:', slackToken.substring(0, 15) + '...');
  res.json(tokenResponse);
});

// Connect page
app.get('/connect', (req, res) => {
  const { auth_code, redirect_uri, state } = req.query;
  
  const html = `<!DOCTYPE html>
<html><head><title>Connect Slack</title></head>
<body>
<h1>Connect Your Slack Token</h1>
<form id="form">
<input type="text" id="token" placeholder="xoxp-your-slack-token" required>
<button type="submit">Connect</button>
</form>
<div id="status"></div>

<script>
document.getElementById('form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const token = document.getElementById('token').value.trim();
  
  if (!token.startsWith('xoxp-')) {
    alert('Invalid token format');
    return;
  }
  
  try {
    // Store the token
    await fetch('/store-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authCode: '${auth_code}', token: token })
    });
    
    // Redirect back to Claude
    const returnUrl = '${redirect_uri}?code=${auth_code}${state ? '&state=' + state : ''}';
    window.location.href = returnUrl;
    
  } catch (error) {
    alert('Error: ' + error.message);
  }
});
</script>
</body></html>`;
  
  res.send(html);
});

app.post('/store-token', (req, res) => {
  const { authCode, token } = req.body;
  console.log('Storing token for code:', authCode);
  
  if (!token.startsWith('xoxp-')) {
    return res.status(400).json({ error: 'Invalid token' });
  }
  
  oauthCodes.set(authCode, token);
  tokens.set(token, 'user_' + Date.now());
  
  res.json({ success: true });
});

// MCP Protocol - REJECT ALL REQUESTS WITHOUT PROPER AUTH
app.post('/', async (req, res) => {
  console.log('=== MCP REQUEST ===');
  console.log('Method:', req.body?.method);
  console.log('Auth header:', req.headers.authorization || 'MISSING');
  
  const { method, id } = req.body || {};
  
  // Check for authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer xoxp-')) {
    console.log('❌ REJECTING - No valid auth header');
    return res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Authentication required. Claude must send Bearer token.',
        data: {
          received: authHeader || 'none',
          expected: 'Bearer xoxp-...',
          instruction: 'Complete OAuth flow first'
        }
      },
      id: id
    });
  }
  
  const token = authHeader.replace('Bearer ', '');
  console.log('✅ Valid auth header received:', token.substring(0, 15) + '...');
  
  switch (method) {
    case 'initialize':
      console.log('✅ Initialize with valid auth');
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

    case 'notifications/initialized':
      console.log('✅ Notifications with valid auth');
      return res.status(200).send();

    case 'tools/list':
      console.log('🎉 TOOLS/LIST called with valid auth!');
      return res.json({
        jsonrpc: '2.0',
        result: {
          tools: [
            {
              name: 'slack_test',
              description: 'Test Slack tool',
              inputSchema: {
                type: 'object',
                properties: {
                  message: { type: 'string' }
                }
              }
            }
          ]
        },
        id: id
      });

    case 'tools/call':
      console.log('🎉 TOOLS/CALL with valid auth!');
      return res.json({
        jsonrpc: '2.0',
        result: {
          content: [{
            type: 'text',
            text: 'Tool called successfully with auth!'
          }]
        },
        id: id
      });

    default:
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32601, message: `Unknown method: ${method}` },
        id: id
      });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Force Auth Server running on port ${PORT}`);
  console.log(`🔐 This server REQUIRES proper authentication for ALL MCP requests`);
});