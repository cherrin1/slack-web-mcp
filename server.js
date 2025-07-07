// SSE endpoint for MCP connections
app.get('/sse', async (req, res) => {
  console.log('🔄 SSE MCP connection received from:', req.get('User-Agent') || 'unknown');
  
  // Set proper SSE headers BEFORE creating transport
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
  
  // Generate session ID
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  try {
    // Create SSE transport AFTER setting headers
    const transport = new SSEServerTransport('/sse', res);
    
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
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to establish MCP connection' });
    }
  }
});