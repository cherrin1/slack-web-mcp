#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const PORT = process.env.PORT || 3000;

// OAuth configuration - Claude Web expects specific values
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || 'slack-mcp-claude-web';
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || 'dummy-secret-for-manual-auth';
const SERVER_URL = process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : `https://slack-mcp-0000034.purplepebble-32448054.westus2.azurecontainerapps.io`;
const REDIRECT_URI = `${SERVER_URL}/authorize`;

// Enhanced CORS for Claude
app.use(cors({
  origin: ['https://claude.ai', 'https://playground.ai.cloudflare.com', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Cache-Control'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage
const sessionTokens = new Map(); // sessionId -> slackToken
const activeSessions = new Map(); // sessionId -> session info
const pendingAuth = new Map(); // state -> sessionId (for OAuth)

// Slack API client
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

// OAuth helper function
async function exchangeCodeForToken(code) {
  if (!SLACK_CLIENT_SECRET || SLACK_CLIENT_SECRET === 'not-configured') {
    throw new Error('OAuth not properly configured - use manual token method instead');
  }

  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code: code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`OAuth error: ${data.error}`);
  }

  return data.authed_user.access_token;
}

// Create MCP server instance
const mcpServer = new Server(
  {
    name: 'slack-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Configure MCP server handlers
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'slack_setup_token',
        description: 'Setup your Slack token manually. Get your token from https://api.slack.com/custom-integrations/legacy-tokens',
        inputSchema: {
          type: 'object',
          properties: {
            token: {
              type: 'string',
              description: 'Your Slack user token (starts with xoxp-)'
            }
          },
          required: ['token']
        }
      },
      {
        name: 'slack_get_auth_url',
        description: 'Get a manual authentication URL if OAuth is not working. This will give you a link to authorize manually.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
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
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  
  // Get session ID from extra context
  const sessionId = extra?.meta?.sessionId;
  if (!sessionId) {
    throw new Error('No session ID found. Please establish a connection first.');
  }

  // Handle manual token setup
  if (name === 'slack_setup_token') {
    if (!args.token || !args.token.startsWith('xoxp-')) {
      return {
        content: [{
          type: 'text',
          text: '❌ Invalid token format. Please provide a valid Slack user token that starts with "xoxp-".\n\nGet your token from: https://api.slack.com/custom-integrations/legacy-tokens'
        }],
        isError: true
      };
    }

    try {
      // Test the token
      const slackClient = new SlackClient(args.token);
      const authTest = await slackClient.testAuth();
      
      // Store token for this session
      sessionTokens.set(sessionId, args.token);
      
      console.log('✅ Manual token setup for session:', sessionId, 'user:', authTest.user);
      
      return {
        content: [{
          type: 'text',
          text: `✅ Successfully connected to Slack!\n\n**User:** ${authTest.user}\n**Team:** ${authTest.team}\n**Method:** Manual token\n\nYou can now use other Slack tools like:\n- slack_get_channels\n- slack_send_message\n- slack_get_channel_history\n- slack_get_users`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ Failed to connect to Slack: ${error.message}\n\nPlease check your token and try again.\nGet your token from: https://api.slack.com/custom-integrations/legacy-tokens`
        }],
        isError: true
      };
    }
  }

  // Handle auth URL request
  if (name === 'slack_get_auth_url') {
    const authUrl = `${SERVER_URL}/auth?session=${sessionId}`;
    
    return {
      content: [{
        type: 'text',
        text: `🔗 **Manual Authentication URL:**\n\n${authUrl}\n\n**Instructions:**\n1. Click the link above\n2. Enter your Slack token on the page\n3. Come back to Claude and use Slack tools\n\n**Alternative:** Use the **slack_setup_token** tool directly in Claude with your token from: https://api.slack.com/custom-integrations/legacy-tokens`
      }]
    };
  }

  // For all other tools, check if token is set
  const slackToken = sessionTokens.get(sessionId);
  if (!slackToken) {
    return {
      content: [{
        type: 'text',
        text: `❌ No Slack token configured for this session.\n\n**Choose one method to authenticate:**\n\n**Method 1: Direct token (Recommended)**\nUse the **slack_setup_token** tool with your Slack user token.\n\n**Method 2: Manual auth page**\nUse the **slack_get_auth_url** tool to get a link.\n\n**Get your token from:** https://api.slack.com/custom-integrations/legacy-tokens`
      }]
    };
  }

  try {
    const slackClient = new SlackClient(slackToken);

    switch (name) {
      case 'slack_get_channels': {
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
      }

      case 'slack_get_channel_history': {
        const history = await slackClient.getChannelHistory(args.channel, args?.limit || 20);

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
      }

      case 'slack_send_message': {
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
      }

      case 'slack_get_users': {
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
      }

      case 'slack_get_channel_info': {
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
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error executing ${name}: ${error.message}`
      }],
      isError: true
    };
  }
});

// OAuth discovery endpoint for Claude
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  console.log('📋 OAuth discovery requested');
  
  res.json({
    issuer: SERVER_URL,
    authorization_endpoint: `${SERVER_URL}/authorize`,
    token_endpoint: `${SERVER_URL}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['claudeai'],
    client_id: SLACK_CLIENT_ID,
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none']
  });
});

// OAuth authorization endpoint
app.get('/authorize', async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, scope } = req.query;
  
  console.log('🔐 OAuth authorize request:', { client_id, redirect_uri, state });
  
  // Store the state for later use
  if (state) {
    pendingAuth.set(state, { redirect_uri, code_challenge });
  }
  
  // Manual token input page
  const serverUrl = `https://${req.get('host')}`;
  
  const html = `<!DOCTYPE html>
<html>
<head>
    <title>Connect Slack to Claude</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        }
        .container { 
            background: white; padding: 40px; border-radius: 16px; 
            box-shadow: 0 20px 40px rgba(0,0,0,0.1); max-width: 500px; width: 100%;
        }
        h1 { color: #2d3748; margin-bottom: 8px; font-size: 24px; text-align: center; }
        .subtitle { color: #718096; text-align: center; margin-bottom: 24px; font-size: 14px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 600; color: #2d3748; }
        input { 
            width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px; 
            font-size: 16px; transition: border-color 0.2s; box-sizing: border-box;
        }
        input:focus { outline: none; border-color: #667eea; }
        button { 
            width: 100%; background: #667eea; color: white; padding: 14px; 
            border: none; border-radius: 8px; font-size: 16px; font-weight: 600; 
            cursor: pointer; transition: background-color 0.2s;
        }
        button:hover { background: #5a67d8; }
        button:disabled { background: #a0aec0; cursor: not-allowed; }
        .info { 
            background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; 
            padding: 12px; margin-bottom: 16px; font-size: 14px;
        }
        .status { 
            margin-top: 20px; padding: 12px; border-radius: 8px; display: none;
            font-weight: 500;
        }
        .success { background: #f0fff4; color: #22543d; border: 1px solid #68d391; }
        .error { background: #fed7d7; color: #c53030; border: 1px solid #fc8181; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔗 Connect Your Slack Account</h1>
        <p class="subtitle">Enter your Slack token to connect to Claude</p>
        
        <div class="info">
            <strong>Get your Slack token:</strong><br>
            Visit <a href="https://api.slack.com/custom-integrations/legacy-tokens" target="_blank">Slack Legacy Tokens</a> 
            and generate a token for your workspace.
        </div>
        
        <form id="authForm">
            <div class="form-group">
                <label for="token">Slack User Token *</label>
                <input type="text" id="token" placeholder="xoxp-your-slack-token-here" required>
            </div>
            <input type="hidden" id="state" value="${state || ''}">
            <input type="hidden" id="redirectUri" value="${redirect_uri || ''}">
            <button type="submit" id="submitBtn">Connect to Claude</button>
        </form>
        <div class="status" id="status"></div>
    </div>

    <script>
        document.getElementById('authForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const status = document.getElementById('status');
            const submitBtn = document.getElementById('submitBtn');
            const token = document.getElementById('token').value.trim();
            const state = document.getElementById('state').value;
            const redirectUri = document.getElementById('redirectUri').value;
            
            if (!token.startsWith('xoxp-')) {
                showStatus('error', 'Invalid token format. Must start with xoxp-');
                return;
            }
            
            submitBtn.disabled = true;
            submitBtn.textContent = 'Connecting...';
            
            try {
                const response = await fetch('/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        token: token,
                        state: state
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showStatus('success', 'Successfully connected! Redirecting to Claude...');
                    
                    // Redirect back to Claude with success
                    if (redirectUri && data.code) {
                        setTimeout(() => {
                            window.location.href = \`\${redirectUri}?code=\${data.code}&state=\${state}\`;
                        }, 1500);
                    } else {
                        setTimeout(() => {
                            window.close();
                        }, 2000);
                    }
                } else {
                    showStatus('error', '❌ ' + (data.error || 'Connection failed'));
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

// OAuth token endpoint
app.post('/token', async (req, res) => {
  const { code, grant_type, client_id, code_verifier, token, state } = req.body;
  
  console.log('🎟️ Token request:', { 
    hasCode: !!code, 
    hasToken: !!token, 
    grant_type, 
    client_id,
    state 
  });
  
  // Set CORS headers for token endpoint
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  try {
    let slackToken;
    let authTest;
    
    if (token) {
      // Manual token flow from auth page
      if (!token.startsWith('xoxp-')) {
        return res.status(400).json({ 
          error: 'invalid_token',
          error_description: 'Invalid token format' 
        });
      }
      
      slackToken = token;
      const slackClient = new SlackClient(slackToken);
      authTest = await slackClient.testAuth();
      
      // Generate a temporary code for Claude
      const tempCode = `manual_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      // Store token with temp code
      sessionTokens.set(tempCode, slackToken);
      
      console.log('✅ Manual token authenticated:', authTest.user);
      
      return res.json({ 
        success: true, 
        code: tempCode,
        user: authTest.user,
        team: authTest.team
      });
    } else if (code && grant_type === 'authorization_code') {
      // OAuth authorization code flow
      
      // Check if this is a manual token code
      if (code.startsWith('manual_')) {
        slackToken = sessionTokens.get(code);
        if (!slackToken) {
          return res.status(400).json({ 
            error: 'invalid_grant',
            error_description: 'Authorization code expired or invalid' 
          });
        }
        
        const slackClient = new SlackClient(slackToken);
        authTest = await slackClient.testAuth();
        
        console.log('✅ Manual auth code exchanged for token:', authTest.user);
        
        return res.json({ 
          access_token: slackToken,
          token_type: 'Bearer',
          scope: 'claudeai',
          expires_in: 3600
        });
      }
      
      // Try real OAuth if configured
      if (SLACK_CLIENT_SECRET !== 'dummy-secret-for-manual-auth') {
        try {
          slackToken = await exchangeCodeForToken(code);
          const slackClient = new SlackClient(slackToken);
          authTest = await slackClient.testAuth();
          
          console.log('✅ OAuth token exchanged:', authTest.user);
          
          return res.json({ 
            access_token: slackToken,
            token_type: 'Bearer',
            scope: 'claudeai',
            expires_in: 3600
          });
        } catch (error) {
          console.error('OAuth exchange failed:', error.message);
        }
      }
      
      // Fallback error
      return res.status(400).json({ 
        error: 'invalid_grant',
        error_description: 'Authorization code invalid or OAuth not configured' 
      });
    }
    
    return res.status(400).json({ 
      error: 'unsupported_grant_type',
      error_description: 'Grant type not supported' 
    });
    
  } catch (error) {
    console.error('❌ Token endpoint error:', error.message);
    return res.status(400).json({ 
      error: 'server_error',
      error_description: error.message 
    });
  }
});

// Manual auth page (alternative to OAuth)
app.get('/auth', (req, res) => {
  const sessionId = req.query.session;
  
  const html = `<!DOCTYPE html>
<html>
<head>
    <title>Manual Slack Authentication</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0; padding: 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        }
        .container { 
            background: white; padding: 40px; border-radius: 16px; 
            box-shadow: 0 20px 40px rgba(0,0,0,0.1); max-width: 500px; width: 100%;
        }
        h1 { color: #2d3748; margin-bottom: 8px; font-size: 24px; text-align: center; }
        .subtitle { color: #718096; text-align: center; margin-bottom: 24px; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; font-weight: 600; color: #2d3748; }
        input { 
            width: 100%; padding: 12px; border: 2px solid #e2e8f0; border-radius: 8px; 
            font-size: 16px; transition: border-color 0.2s; box-sizing: border-box;
        }
        input:focus { outline: none; border-color: #667eea; }
        button { 
            width: 100%; background: #667eea; color: white; padding: 14px; 
            border: none; border-radius: 8px; font-size: 16px; font-weight: 600; 
            cursor: pointer; transition: background-color 0.2s;
        }
        button:hover { background: #5a67d8; }
        .info { 
            background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; 
            padding: 12px; margin-bottom: 16px; font-size: 14px;
        }
        .status { 
            margin-top: 20px; padding: 12px; border-radius: 8px; display: none;
            font-weight: 500;
        }
        .success { background: #f0fff4; color: #22543d; border: 1px solid #68d391; }
        .error { background: #fed7d7; color: #c53030; border: 1px solid #fc8181; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔗 Connect Your Slack Account</h1>
        <p class="subtitle">Enter your Slack token to use with Claude</p>
        
        <div class="info">
            <strong>Get your Slack token:</strong><br>
            Visit <a href="https://api.slack.com/custom-integrations/legacy-tokens" target="_blank">Slack Legacy Tokens</a> 
            and generate a token for your workspace.
        </div>
        
        <form id="authForm">
            <div class="form-group">
                <label for="token">Slack User Token</label>
                <input type="text" id="token" placeholder="xoxp-your-slack-token-here" required>
            </div>
            <input type="hidden" id="sessionId" value="${sessionId || ''}">
            <button type="submit" id="submitBtn">Save Token</button>
        </form>
        <div class="status" id="status"></div>
    </div>

    <script>
        document.getElementById('authForm').addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const status = document.getElementById('status');
            const submitBtn = document.getElementById('submitBtn');
            const token = document.getElementById('token').value.trim();
            const sessionId = document.getElementById('sessionId').value;
            
            if (!token.startsWith('xoxp-')) {
                showStatus('error', 'Invalid token format. Must start with xoxp-');
                return;
            }
            
            submitBtn.disabled = true;
            submitBtn.textContent = 'Saving...';
            
            try {
                const response = await fetch('/manual-auth', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        token: token,
                        sessionId: sessionId
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showStatus('success', \`✅ Connected! Welcome \${data.user} from \${data.team}. You can now close this page and use Slack tools in Claude.\`);
                } else {
                    showStatus('error', '❌ ' + (data.error || 'Connection failed'));
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Save Token';
                }
            } catch (error) {
                showStatus('error', '❌ Network error: ' + error.message);
                submitBtn.disabled = false;
                submitBtn.textContent = 'Save Token';
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

// Manual auth handler
app.post('/manual-auth', async (req, res) => {
  const { token, sessionId } = req.body;
  
  if (!token || !token.startsWith('xoxp-')) {
    return res.status(400).json({ 
      success: false,
      error: 'Valid Slack token required (must start with xoxp-)' 
    });
  }
  
  try {
    const slackClient = new SlackClient(token);
    const authTest = await slackClient.testAuth();
    
    // Store token with session ID
    if (sessionId) {
      sessionTokens.set(sessionId, token);
      console.log('✅ Manual auth for session:', sessionId, 'user:', authTest.user);
    }
    
    return res.json({ 
      success: true, 
      message: 'Successfully connected with Slack',
      user: authTest.user,
      team: authTest.team
    });
  } catch (error) {
    console.error('❌ Manual auth failed:', error.message);
    return res.status(400).json({ 
      success: false,
      error: 'Authentication failed', 
      message: error.message 
    });
  }
});

// Handle OPTIONS requests for CORS
app.options('/token', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(200);
});

// Server info endpoint
app.get('/', (req, res) => {
  res.json({
    name: "Slack MCP Server",
    version: "1.0.0",
    description: "Connect your Slack workspace to Claude via MCP - Supports OAuth and manual tokens",
    status: "ready",
    endpoints: {
      sse: "/sse",
      health: "/health",
      auth: "/auth",
      oauth_discovery: "/.well-known/oauth-authorization-server"
    },
    instructions: [
      "1. Add this server to Claude: " + (process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}/sse` : "your-domain.com/sse"),
      "2. Authenticate via OAuth popup or use slack_setup_token tool",
      "3. Get token from: https://api.slack.com/custom-integrations/legacy-tokens"
    ]
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
    sessionTokens: sessionTokens.size,
    oauth_configured: SLACK_CLIENT_SECRET !== 'not-configured'
  });
});

// SSE endpoint for MCP connections
app.get('/sse', async (req, res) => {
  console.log('🔄 SSE MCP connection received from:', req.get('User-Agent') || 'unknown');
  
  // Generate session ID
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  try {
    // Create SSE transport
    const transport = new SSEServerTransport('/messages', res);
    
    // Store session info
    activeSessions.set(sessionId, {
      id: sessionId,
      transport: transport,
      startTime: new Date()
    });
    
    // Connect MCP server to this transport with session context
    await mcpServer.connect(transport, {
      meta: { sessionId }
    });
    
    console.log('✅ MCP SSE connection established:', sessionId);
    
    // Handle disconnection
    req.on('close', () => {
      console.log('🔌 SSE connection closed:', sessionId);
      activeSessions.delete(sessionId);
      sessionTokens.delete(sessionId);
    });
    
  } catch (error) {
    console.error('❌ SSE connection error:', error);
    res.status(500).json({ error: 'Failed to establish MCP connection' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Slack MCP Server running on port ${PORT}`);
  console.log(`🔗 SSE endpoint: /sse`);
  console.log(`🔐 OAuth discovery: /.well-known/oauth-authorization-server`);
  console.log(`💡 Ready for Claude integration with hybrid auth`);
  console.log(`📊 OAuth configured: ${SLACK_CLIENT_SECRET !== 'not-configured'}`);
});