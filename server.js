const express = require('express');
const { WebClient } = require('@slack/web-api');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const MCP_SECRET = process.env.MCP_SECRET || crypto.randomBytes(32).toString('hex');

// Validate required environment variables
if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

// In-memory storage
const userTokens = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function to get base URL
function getBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || 'https';
  const host = req.get('host');
  return `${protocol}://${host}`;
}

// MCP Authorization endpoint for Claude
app.get('/authorize', (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.redirect(`${baseUrl}/oauth/slack`);
});

// Start OAuth flow
app.get('/oauth/slack', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  const state = crypto.randomBytes(16).toString('hex');
  
  // Simple user scopes - no bot permissions needed
  const scopes = 'channels:read chat:write users:read';
  
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&scope=${scopes}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  console.log('Redirecting to:', authUrl);
  res.redirect(authUrl);
});

// OAuth callback
app.get('/oauth/callback', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/oauth/callback`;
  
  const { code, error } = req.query;
  
  if (error) {
    return res.json({ error: 'OAuth error', details: error });
  }
  
  if (!code) {
    return res.json({ error: 'Missing authorization code' });
  }
  
  try {
    // Exchange code for token
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
    
    if (!data.ok) {
      return res.json({ error: 'Token exchange failed', details: data.error });
    }
    
    // Store user token
    const userId = data.authed_user.id;
    const teamId = data.team.id;
    const tokenKey = `${teamId}:${userId}`;
    
    userTokens.set(tokenKey, {
      access_token: data.authed_user.access_token,
      team_id: teamId,
      user_id: userId,
      team_name: data.team.name,
      user_name: data.authed_user.name || 'Unknown',
      created_at: new Date().toISOString()
    });
    
    // Success response
    res.json({ 
      success: true, 
      message: 'Successfully authenticated with Slack',
      team: data.team.name,
      user: data.authed_user.name || 'Unknown',
      user_id: userId,
      team_id: teamId,
      token_stored: true
    });
    
  } catch (error) {
    console.error('OAuth error:', error);
    res.json({ error: 'Internal server error' });
  }
});

// Simple tool endpoint for testing
app.post('/slack/send', express.json(), async (req, res) => {
  const { team_id, user_id, channel, text } = req.body;
  
  if (!team_id || !user_id || !channel || !text) {
    return res.json({ error: 'Missing required parameters' });
  }
  
  const tokenKey = `${team_id}:${user_id}`;
  const tokenData = userTokens.get(tokenKey);
  
  if (!tokenData) {
    return res.json({ error: 'No token found. Please authenticate first.' });
  }
  
  try {
    const slack = new WebClient(tokenData.access_token);
    const result = await slack.chat.postMessage({
      channel: channel,
      text: text
    });
    
    res.json({
      success: true,
      message: 'Message sent successfully',
      timestamp: result.ts,
      channel: result.channel
    });
    
  } catch (error) {
    console.error('Slack API error:', error);
    res.json({ error: 'Failed to send message', details: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    tokens_stored: userTokens.size,
    timestamp: new Date().toISOString()
  });
});

// Info endpoint
app.get('/info', (req, res) => {
  const baseUrl = getBaseUrl(req);
  
  res.json({
    app_name: 'Simple Slack User Token Server',
    version: '1.0.0',
    base_url: baseUrl,
    oauth_url: `${baseUrl}/oauth/slack`,
    redirect_uri: `${baseUrl}/oauth/callback`,
    authorize_url: `${baseUrl}/authorize`,
    health_url: `${baseUrl}/health`,
    tokens_stored: userTokens.size,
    instructions: {
      step1: 'Visit /oauth/slack to authenticate',
      step2: 'Use POST /slack/send to send messages',
      step3: 'Connect to Claude as MCP server'
    }
  });
});

// Start server
app.listen(port, () => {
  console.log(`✅ Simple Slack User Token Server running on port ${port}`);
  console.log(`🌐 OAuth URL: http://localhost:${port}/oauth/slack`);
  console.log(`❤️ Health check: http://localhost:${port}/health`);
  console.log(`📝 Info: http://localhost:${port}/info`);
});

console.log('🚀 Server ready for user token authentication (no bot required)!');