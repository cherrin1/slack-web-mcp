const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Test MCP server with NO authentication - just to see if tools work
app.post('/', async (req, res) => {
  console.log('=== MCP REQUEST ===');
  console.log('Method:', req.body?.method);
  console.log('Full body:', JSON.stringify(req.body, null, 2));
  
  const { method, params, id } = req.body || {};

  try {
    switch (method) {
      case 'initialize':
        console.log('🔧 Initialize called - returning tools capability');
        return res.json({
          jsonrpc: '2.0',
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {
                listChanged: true
              }
            },
            serverInfo: {
              name: 'minimal-test-server',
              version: '1.0.0',
              description: 'Minimal MCP Test Server'
            }
          },
          id: id
        });

      case 'notifications/initialized':
        console.log('🔧 Notifications/initialized called');
        return res.status(200).send();

      case 'tools/list':
        console.log('🎉 TOOLS/LIST CALLED! SUCCESS!');
        return res.json({
          jsonrpc: '2.0',
          result: {
            tools: [
              {
                name: 'test_tool',
                description: 'A simple test tool',
                inputSchema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string', description: 'Test message' }
                  }
                }
              }
            ]
          },
          id: id
        });

      case 'tools/call':
        console.log('🎉 TOOLS/CALL CALLED! Tool:', params?.name);
        return res.json({
          jsonrpc: '2.0',
          result: {
            content: [{
              type: 'text',
              text: `Test tool called with: ${JSON.stringify(params)}`
            }]
          },
          id: id
        });

      default:
        console.log('❌ Unknown method:', method);
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: `Unknown method: ${method}` },
          id: id
        });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: error.message },
      id: id
    });
  }
});

// Simple status endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Minimal MCP Test Server',
    status: 'running',
    description: 'Testing if Claude Web calls tools/list'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Minimal MCP Test Server running on port ${PORT}`);
  console.log(`📋 Add this URL to Claude: https://your-domain.com/`);
  console.log(`🔍 Waiting to see if Claude calls tools/list...`);
});