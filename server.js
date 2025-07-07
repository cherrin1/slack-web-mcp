const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS configuration for Claude integration
app.use(cors({
  origin: ['https://claude.ai', 'https://console.anthropic.com', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage with better structure
const registeredTokens = new Map(); // token -> userInfo
const activeConnections = new Set();

// Enhanced SlackClient with better error handling
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

// Enhanced authentication with better token validation
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

  const userInfo = registeredTokens.get(token);
  if (!userInfo) {
    console.log('🔍 Token not found in registered tokens');
    return null;
  }

  // Test if token is still valid
  try {
    const slackClient = new SlackClient(token);
    await slackClient.testAuth();
    console.log('✅ Token authenticated for user:', userInfo.name || 'Unknown');
    return { token, userInfo };
  } catch (error) {
    console.log('❌ Token validation failed:', error.message);
    // Remove invalid token
    registeredTokens.delete(token);
    return null;
  }
}

// Server info endpoint (similar to SSE MCP pattern)
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
      health: "/health"
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    connections: activeConnections.size,
    registeredTokens: registeredTokens.size
  });
});

// Enhanced registration with better validation
app.post('/register', async (req, res) => {
  const { slackToken, userInfo = {} } = req.body;
  
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

// Enhanced connect page with better UX
app.get('/connect', (req, res) => {
  const serverUrl = `https://${req.get('host')}`;
  
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
                <button type="submit" id="submitBtn">Connect to Claude</button>
            </form>
            <div class="status" id="status"></div>
        </div>
    </div>

    <script>
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
                        userInfo: { name: name || 'User' } 
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showStatus('success', 
                        \`✅ Successfully connected! Welcome \${data.userInfo.userName} from \${data.userInfo.teamName}. ` +
                        `Your Slack workspace is now ready to use with Claude.\`);
                    document.getElementById('registrationForm').style.display = 'none';
                } else {
                    showStatus('error', '❌ ' + (data.error || 'Registration failed'));
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Connect to Claude';
                }
            } catch (error) {
                showStatus('error', '❌ Network error: ' + error.message);
                submitBtn.disabled = false;
                submitBtn.textContent = 'Connect to Claude';
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

// Main MCP endpoint with enhanced protocol support
app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body || {};
  
  console.log(`🔧 MCP Request: ${method}`, params ? Object.keys(params) : 'no params');
  
  try {
    // Handle MCP protocol methods
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0',
          result: {
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
          },
          id
        });

      case 'notifications/initialized':
        activeConnections.add(req.ip);
        console.log('✅ MCP session initialized');
        return res.status(200).send();

      case 'tools/list':
        return res.json({
          jsonrpc: '2.0',
          result: {
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
          },
          id
        });

      case 'tools/call':
        const auth = await authenticateRequest(req);
        if (!auth) {
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

        const { name, arguments: args } = params;
        const slackClient = new SlackClient(auth.token);
        
        let result;
        try {
          result = await handleToolCall(name, args, slackClient);
        } catch (error) {
          return res.json({
            jsonrpc: '2.0',
            result: {
              content: [{ 
                type: 'text', 
                text: `Error executing ${name}: ${error.message}` 
              }],
              isError: true
            },
            id
          });
        }

        return res.json({
          jsonrpc: '2.0',
          result,
          id
        });

      default:
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { 
            code: -32601, 
            message: `Method not found: ${method}` 
          },
          id
        });
    }
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

// Enhanced tool call handler with better formatting
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
        for (const userId of userIds.slice(0, 10)) { // Limit to avoid rate limits
          const userInfo = await slackClient.getUserInfo(userId);
          users.set(userId, userInfo.user.real_name || userInfo.user.name);
        }
      } catch (error) {
        console.log('Could not fetch user info:', error.message);
      }
      
      const messages = history.messages
        .reverse() // Show chronological order
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
  activeConnections.clear();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server v2.0 running on port ${PORT}`);
  console.log(`📱 Connect at: https://your-domain.com/connect`);
  console.log(`🔗 MCP endpoint: https://your-domain.com/mcp`);
  console.log(`📊 Ready for Claude integration`);
});