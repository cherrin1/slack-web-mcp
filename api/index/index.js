// api/index/index.js - Azure Functions version (just like Vercel!)

// Simple in-memory storage (use Azure Tables or CosmosDB for production)
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

// Main Azure Function handler
export default async function handler(req, context) {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };

  if (req.method === 'OPTIONS') {
    return {
      status: 200,
      headers: corsHeaders
    };
  }

  const path = req.params.path || '';
  const url = new URL(req.url);
  const pathname = url.pathname;

  try {
    // Server info endpoint
    if (req.method === 'GET' && (path === '' || pathname === '/api/index')) {
      return {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: "Slack MCP Server",
          version: "1.0.0",
          description: "Connect your Slack workspace to Claude (Azure)",
          capabilities: { tools: true },
          instructions: {
            setup: "Get registered at /connect",
            authentication: "Use your Slack token as 'Bearer xoxp-your-token'"
          }
        })
      };
    }

    // Connect page
    if (req.method === 'GET' && path === 'connect') {
      const query = url.searchParams;
      const isClaudeWeb = query.get('client') === 'claude-web' || query.get('oauth') === 'true';
      
      const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Connect Slack to Claude MCP</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
        button { background: #007cba; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
        .status { margin-top: 15px; padding: 10px; border-radius: 4px; display: none; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
    </style>
</head>
<body>
    <h1>🚀 Connect Slack to Claude (Azure)</h1>
    <form id="connectionForm">
        <div class="form-group">
            <label for="slackToken">Slack User Token *</label>
            <input type="text" id="slackToken" placeholder="xoxp-..." required>
        </div>
        <div class="form-group">
            <label for="userName">Your Name (Optional)</label>
            <input type="text" id="userName" placeholder="John Doe">
        </div>
        <button type="submit">Connect to Claude</button>
    </form>
    <div class="status" id="status"></div>

    <script>
        document.getElementById('connectionForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const status = document.getElementById('status');
            const slackToken = document.getElementById('slackToken').value.trim();
            const userName = document.getElementById('userName').value.trim();
            
            if (!slackToken.startsWith('xoxp-')) {
                status.className = 'status error';
                status.textContent = 'Invalid token format';
                status.style.display = 'block';
                return;
            }
            
            try {
                const response = await fetch('/api/register', {
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
                    status.textContent = 'Successfully connected!';
                } else {
                    status.className = 'status error';
                    status.textContent = data.error || 'Connection failed';
                }
                status.style.display = 'block';
                
            } catch (error) {
                status.className = 'status error';
                status.textContent = 'Network error';
                status.style.display = 'block';
            }
        });
    </script>
</body>
</html>`;
      
      return {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'text/html' },
        body: html
      };
    }

    // Registration endpoint
    if (req.method === 'POST' && path === 'register') {
      const { slackToken, userInfo = {} } = req.body;
      
      if (!slackToken || !slackToken.startsWith('xoxp-')) {
        return {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Valid Slack user token required' })
        };
      }

      try {
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
            slackTeam: authTest.team_id
          },
          active: true
        };

        users.set(userId, userData);
        tokens.set(slackToken, userId);

        return {
          status: 201,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            message: 'Successfully registered',
            token: slackToken,
            userId
          })
        };

      } catch (error) {
        return {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            error: 'Registration failed',
            message: error.message
          })
        };
      }
    }

    // OAuth endpoints
    if (path.startsWith('oauth/')) {
      const oauthPath = path.replace('oauth/', '');
      
      if (oauthPath === 'config') {
        const baseUrl = `https://${req.headers.host}`;
        return {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: "slack-mcp-claude-web",
            authorization_endpoint: `${baseUrl}/api/oauth/authorize`,
            token_endpoint: `${baseUrl}/api/oauth/token`,
            scope: "slack:read slack:write"
          })
        };
      }
      
      if (oauthPath === 'authorize') {
        const query = url.searchParams;
        const authCode = 'claude_web_' + Date.now();
        const baseUrl = `https://${req.headers.host}`;
        
        const connectUrl = `${baseUrl}/api/connect?oauth=true&client=claude-web&auth_code=${authCode}&redirect_uri=${query.get('redirect_uri')}&state=${query.get('state')}`;
        
        return {
          status: 302,
          headers: { ...corsHeaders, 'Location': connectUrl }
        };
      }
      
      if (oauthPath === 'token') {
        const { grant_type, code } = req.body;
        
        if (grant_type !== 'authorization_code' || !code) {
          return {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'invalid_request' })
          };
        }

        const slackToken = oauthCodes.get(code);
        if (!slackToken) {
          return {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'invalid_grant' })
          };
        }

        oauthCodes.delete(code);

        return {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            access_token: slackToken,
            token_type: 'bearer',
            expires_in: 31536000
          })
        };
      }
      
      if (oauthPath === 'store-token') {
        const { authCode, token } = req.body;
        if (authCode && token) {
          oauthCodes.set(authCode, token);
        }
        return {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true })
        };
      }
    }

    // MCP Protocol - requires authentication
    const slackToken = await authenticateRequest(req);
    if (!slackToken) {
      return {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Authentication required' })
      };
    }

    const slackClient = new SlackClient(slackToken);
    const { method, params } = req.body || {};

    switch (method) {
      case 'initialize':
        return {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'slack-mcp-server',
              version: '1.0.0'
            }
          })
        };

      case 'tools/list':
        return {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
          })
        };

      case 'tools/call':
        const { name, arguments: args } = params;
        
        try {
          let result;
          switch (name) {
            case 'slack_get_channels':
              const channelsData = await slackClient.getChannels('public_channel', args.limit || 100);
              const channels = channelsData.channels.map(ch => `#${ch.name} (${ch.num_members} members)`);
              result = `Found ${channels.length} channels:\n\n${channels.join('\n')}`;
              break;

            case 'slack_get_channel_history':
              const historyData = await slackClient.getChannelHistory(args.channel, args.limit || 50);
              const messages = historyData.messages
                .map(msg => `${new Date(parseFloat(msg.ts) * 1000).toLocaleString()}: ${msg.text || 'No text'}`)
                .slice(0, 10);
              result = `Recent messages in ${args.channel}:\n\n${messages.join('\n')}`;
              break;

            case 'slack_send_message':
              await slackClient.sendMessage(args.channel, args.text);
              result = `Message sent successfully to ${args.channel}`;
              break;

            default:
              throw new Error(`Unknown tool: ${name}`);
          }

          return {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: [{
                type: 'text',
                text: result
              }]
            })
          };

        } catch (error) {
          return {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: [{
                type: 'text',
                text: `Error: ${error.message}`
              }],
              isError: true
            })
          };
        }

      default:
        return {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Unknown method: ${method}` })
        };
    }

  } catch (error) {
    console.error('Function error:', error);
    return {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Server error',
        message: error.message 
      })
    };
  }
}
