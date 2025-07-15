# Slack MCP Server for Claude AI

A multi-user Model Context Protocol (MCP) server that enables Claude AI to interact with Slack workspaces through individual user authentication. This server is designed to be deployed on Azure Container Apps with GitHub Actions CI/CD.

## 🚀 Features

- **Individual User Authentication**: Each user must authenticate with their own Slack account
- **Secure Token Management**: No shared tokens - each Claude user gets their own isolated connection
- **Multi-Workspace Support**: Users can connect to different Slack workspaces
- **Comprehensive Slack Integration**: Send messages, read channels, search, and manage workspace data
- **Azure Container Apps Ready**: Optimized for cloud deployment with health checks and scaling
- **GitHub Actions CI/CD**: Automated deployment pipeline

## 📋 Prerequisites

- Node.js 18 or higher
- Slack App with OAuth 2.0 configured
- Azure subscription with Container Apps environment
- GitHub repository with secrets configured

## 🛠️ Slack App Configuration

1. **Create a Slack App** at [api.slack.com](https://api.slack.com/apps)

2. **Configure OAuth & Permissions**:
   - Add redirect URLs:
     - `https://your-app-name.region.azurecontainerapps.io/oauth/callback`
     - `http://localhost:3000/oauth/callback` (for local development)
   
3. **Required User Token Scopes**:
   ```
   channels:history    - Read message history in public channels
   channels:read       - View basic information about public channels
   channels:write      - Manage public channels
   chat:write          - Send messages as the user
   groups:read         - View basic information about private channels
   groups:write        - Manage private channels
   im:history          - Read message history in direct messages
   im:write            - Start direct messages with people
   mpim:history        - Read message history in group direct messages
   mpim:read           - View basic information about group direct messages
   search:read         - Search workspace content
   users:read          - View people in the workspace
   ```

4. **Note your credentials**:
   - Client ID
   - Client Secret

## 🔧 Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SLACK_CLIENT_ID` | Your Slack app's client ID | `1234567890.1234567890` |
| `SLACK_CLIENT_SECRET` | Your Slack app's client secret | `abcdef1234567890abcdef1234567890` |
| `PORT` | Server port (default: 3000) | `3000` |
| `NODE_ENV` | Environment (development/production) | `production` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_SECRET` | Secret for MCP token generation | Auto-generated |
| `SLACK_REDIRECT_URI` | OAuth callback URI | Auto-detected |

## 🚀 Azure Deployment

### 1. GitHub Secrets Setup

Configure these secrets in your GitHub repository:

```
AZURE_CREDENTIALS              # Azure service principal JSON
AZURE_CONTAINER_REGISTRY       # your-registry.azurecr.io
AZURE_REGISTRY_USERNAME        # Registry username
AZURE_REGISTRY_PASSWORD        # Registry password
AZURE_RESOURCE_GROUP           # Resource group name
AZURE_CONTAINER_APP_ENVIRONMENT # Container app environment name
SLACK_CLIENT_ID                # Slack app client ID
SLACK_CLIENT_SECRET            # Slack app client secret
MCP_SECRET                     # Custom MCP secret (optional)
```

### 2. Azure Resources Required

- **Container Registry**: For storing Docker images
- **Container Apps Environment**: Managed environment for your app
- **Resource Group**: To organize your resources

### 3. Deploy via GitHub Actions

The deployment happens automatically when you push to the `main` branch. The workflow:

1. Builds Docker image
2. Pushes to Azure Container Registry
3. Deploys to Azure Container Apps
4. Runs health checks
5. Reports deployment status

### 4. Manual Azure CLI Deployment

```bash
# Login to Azure
az login

# Create resource group (if needed)
az group create --name your-resource-group --location eastus

# Create container app environment (if needed)
az containerapp env create \
  --name your-environment \
  --resource-group your-resource-group \
  --location eastus

# Deploy the container app
az containerapp create \
  --name slack-mcp-server \
  --resource-group your-resource-group \
  --environment your-environment \
  --image your-registry.azurecr.io/slack-mcp-server:latest \
  --target-port 3000 \
  --ingress external \
  --secrets \
    slack-client-id="your-slack-client-id" \
    slack-client-secret="your-slack-client-secret" \
  --env-vars \
    PORT=3000 \
    NODE_ENV=production \
    SLACK_CLIENT_ID=secretref:slack-client-id \
    SLACK_CLIENT_SECRET=secretref:slack-client-secret
```

## 🏃 Local Development

### 1. Clone and Install

```bash
git clone https://github.com/your-username/slack-mcp-server.git
cd slack-mcp-server
npm install
```

### 2. Environment Setup

Create a `.env` file:

```env
SLACK_CLIENT_ID=your_slack_client_id
SLACK_CLIENT_SECRET=your_slack_client_secret
PORT=3000
NODE_ENV=development
```

### 3. Run Locally

```bash
npm start
```

The server will start on `http://localhost:3000`

### 4. Test Endpoints

- Health check: `http://localhost:3000/health`
- User authentication: `http://localhost:3000/simple-auth`
- Server info: `http://localhost:3000/info`

## 🔌 Claude AI Integration

### 1. User Authentication Flow

1. **Each user** must visit: `https://your-app-url/simple-auth`
2. Click "Connect My Slack Account"
3. Authorize with Slack
4. Receive individual authentication token

### 2. Configure Claude

You can connect this MCP server to Claude using two methods:

#### Option A: Custom Connector (Workspace Owners) - **Recommended**

For Claude Pro workspace owners, you can create a custom connector with just two inputs:

1. **Access Custom Connectors:**
   - Go to your Claude workspace settings
   - Navigate to "Integrations" or "Custom Connectors"
   - Click "Add Custom Connector"

2. **Simple Configuration:**
   - **MCP URL**: `https://your-app-url/mcp`
   - **Authorization Token**: `YOUR_MCP_SECRET` (the MCP_SECRET environment variable)

3. **That's it!** The connector will handle:
   - Authentication with the MCP server
   - Tool discovery and registration
   - Session management
   - All Slack API interactions

4. **Enable for Workspace:**
   - Save the custom connector
   - Enable it for your workspace
   - Team members can now use Slack tools in Claude
   - Each user still needs to authenticate with their own Slack account via `/simple-auth`

#### Option B: Desktop Configuration (Individual Users)

For Claude Desktop users, add this to your MCP configuration file:

**Location of config file:**
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**Configuration:**
```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/server-everything",
        "https://your-app-url/mcp"
      ],
      "env": {
        "MCP_SERVER_URL": "https://your-app-url/mcp"
      }
    }
  }
}
```

**Alternative using cURL (for HTTP-based MCP):**
```json
{
  "mcpServers": {
    "slack": {
      "command": "curl",
      "args": [
        "-X", "POST",
        "-H", "Content-Type: application/json",
        "-H", "Authorization: Bearer YOUR_MCP_TOKEN",
        "--data-binary", "@-",
        "https://your-app-url/mcp"
      ]
    }
  }
}
```

#### Option C: Direct HTTP Integration (Advanced)

For advanced users who want to integrate directly:

```bash
# Test the MCP endpoint
curl -X POST https://your-app-url/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_MCP_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'
```

### 3. Connection Methods Summary

| Method | Best For | Setup Complexity | Configuration Required |
|--------|----------|------------------|----------------------|
| **Custom Connector** | Workspace owners | **Very Low** | Just URL + token |
| **Desktop Config** | Individual users | Low | Config file editing |
| **Direct HTTP** | Developers/Advanced users | High | Manual token management |

### 5. Available Tools

Once connected, Claude can use these Slack tools:

- **slack_send_message**: Send message to any channel
- **slack_send_dm**: Send direct message to users
- **slack_get_channels**: List available channels
- **slack_get_users**: List workspace users
- **slack_get_workspace_info**: Get workspace and user details
- **slack_get_messages**: Read channel message history
- **slack_search_messages**: Search across workspace
- **slack_get_user_info**: Get detailed user information
- **slack_get_channel_info**: Get detailed channel information

## 🏢 For Workspace Administrators

### Custom Connector Setup (Option A - Recommended)

If you're a Claude Pro workspace owner, setting up the custom connector is extremely simple:

#### 1. Get Your Server Details

- **MCP URL**: `https://your-app-url/mcp`
- **Authorization Token**: Your `MCP_SECRET` environment variable value

#### 2. Create Custom Connector in Claude

1. **Access Admin Panel:**
   - Log into your Claude Pro workspace
   - Go to "Settings" → "Integrations" → "Custom Connectors"
   - Click "Add Custom Connector"

2. **Enter Connection Details:**
   - **MCP URL**: `https://your-app-url/mcp`
   - **Authorization Token**: `YOUR_MCP_SECRET`
   - **Name**: `Slack Integration` (optional)
   - **Description**: `Connect to Slack workspaces` (optional)

3. **Save and Enable:**
   - Click "Save"
   - Enable the connector for your workspace
   - Done! The connector automatically handles everything else

#### 3. Team Usage

Once the connector is set up:
- Team members can immediately see Slack tools in Claude
- Each user still needs to authenticate with their own Slack account
- Users visit `https://your-app-url/simple-auth` to connect their Slack
- No additional Claude configuration needed per user

#### 4. Benefits of Custom Connector

- **Centralized Management**: One setup for entire team
- **Automatic Updates**: Connector updates automatically
- **Security**: Managed authentication and permissions
- **Usage Analytics**: Track connector usage across team
- **Easy Deployment**: No individual user configuration needed

## 🛡️ Security Features

### Authentication
- **Individual user authentication required** - no shared tokens
- **Secure OAuth 2.0 flow** with Slack
- **Token isolation** - each Claude user gets their own connection
- **Session management** with automatic cleanup

### Privacy
- **No data persistence** - tokens stored in memory only
- **User-specific scopes** - each user can only access their authorized content
- **No cross-user access** - users cannot see each other's data

### Production Security
- **HTTPS enforced** in production
- **Health checks** for monitoring
- **Graceful shutdown** handling
- **Error boundaries** to prevent crashes

## 🔍 Monitoring and Debugging

### Health Endpoints

- `/health` - Application health status
- `/info` - Server information and statistics
- `/debug/users` - Connected users and sessions (development only)

### Logging

The server provides detailed logging for:
- User authentication events
- MCP session creation/destruction
- Slack API calls and responses
- Error conditions and debugging

### Troubleshooting

**Common Issues:**

1. **Authentication Failed**
   - Check Slack app credentials
   - Verify redirect URI configuration
   - Ensure user has proper permissions

2. **MCP Connection Issues**
   - Verify Claude configuration
   - Check server logs for errors
   - Ensure network connectivity

3. **Token Expired**
   - Users need to re-authenticate via `/simple-auth`
   - Check token refresh logic

## 📊 API Reference

### Authentication Endpoints

- `GET /simple-auth` - User authentication page
- `GET /oauth/slack` - Slack OAuth initiation
- `GET /oauth/callback` - OAuth callback handler
- `POST /token` - Claude token exchange

### MCP Endpoints

- `POST /mcp` - Main MCP protocol endpoint
- `GET /mcp` - Server-sent events for notifications
- `DELETE /mcp` - Session termination

### Utility Endpoints

- `GET /health` - Health check
- `GET /info` - Server information
- `GET /debug/users` - Debug information

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License. See the LICENSE file for details.

## 🆘 Support

For support:
1. Check the [Issues](https://github.com/your-username/slack-mcp-server/issues) page
2. Review the troubleshooting section above
3. Create a new issue with detailed information

## 🔮 Roadmap

- [ ] Add support for Slack app installations
- [ ] Implement token refresh mechanism
- [ ] Add database persistence option
- [ ] Enhanced error handling and recovery
- [ ] Metrics and analytics dashboard
- [ ] Multi-region deployment support

---

**Note**: This server requires individual user authentication. Users cannot share tokens or access each other's Slack data. Each person must authenticate with their own Slack account to use the service.