// Debug script to test your MCP server
// Run this to see if your server is returning tools correctly

const testMCPServer = async () => {
  const serverUrl = 'https://slack-mcp-0000006.purplepebble-32448054.westus2.azurecontainerapps.io';
  
  // Test basic connection
  console.log('Testing server connection...');
  try {
    const response = await fetch(serverUrl);
    const data = await response.json();
    console.log('Server root response:', data);
  } catch (error) {
    console.error('Server connection failed:', error);
  }
  
  // Test tools/list endpoint
  console.log('\nTesting tools/list...');
  try {
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer xoxp-YOUR-TOKEN-HERE', // Replace with your actual token
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 1
      })
    });
    
    const data = await response.json();
    console.log('Tools list response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Tools list failed:', error);
  }
  
  // Test initialize endpoint
  console.log('\nTesting initialize...');
  try {
    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer xoxp-YOUR-TOKEN-HERE', // Replace with your actual token
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        },
        id: 1
      })
    });
    
    const data = await response.json();
    console.log('Initialize response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Initialize failed:', error);
  }
};

// If running in Node.js
if (typeof require !== 'undefined') {
  const fetch = require('node-fetch');
  testMCPServer();
}

// If running in browser console
if (typeof window !== 'undefined') {
  testMCPServer();
}