// Create test-server.js
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.json({ message: "Basic server works" });
});

app.listen(3000, () => {
  console.log('Test server running on port 3000');
});
