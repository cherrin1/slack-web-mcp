// Improved Slack MCP Tools - Optimized for Large Workspaces (180+ users)

// Helper function to resolve user ID from username or display name
async function resolveUserId(slack, userInput) {
  // If it's already a user ID (starts with U), return as-is
  if (userInput.match(/^U[A-Z0-9]+$/)) {
    return userInput;
  }
  
  // Remove @ if present
  const cleanInput = userInput.replace('@', '').toLowerCase();
  
  try {
    // First try direct username lookup
    const userByName = await slack.users.info({ user: cleanInput });
    if (userByName.user) {
      return userByName.user.id;
    }
  } catch (e) {
    // Username lookup failed, try searching all users
  }
  
  // Search through users list for matching username or real name
  let cursor = null;
  const limit = 200; // Slack API limit per request
  
  do {
    const params = { limit };
    if (cursor) params.cursor = cursor;
    
    const users = await slack.users.list(params);
    
    for (const user of users.members) {
      if (user.deleted || user.is_bot) continue;
      
      // Check username match
      if (user.name && user.name.toLowerCase() === cleanInput) {
        return user.id;
      }
      
      // Check real name match (case insensitive, partial match)
      if (user.real_name && user.real_name.toLowerCase().includes(cleanInput)) {
        return user.id;
      }
      
      // Check display name match
      if (user.profile?.display_name && 
          user.profile.display_name.toLowerCase().includes(cleanInput)) {
        return user.id;
      }
    }
    
    cursor = users.response_metadata?.next_cursor;
  } while (cursor);
  
  throw new Error(`User not found: ${userInput}`);
}

// Helper function to get user display name
async function getUserDisplayName(slack, userId) {
  try {
    const userInfo = await slack.users.info({ user: userId });
    return userInfo.user.real_name || userInfo.user.name || userId;
  } catch (e) {
    return userId;
  }
}

// Tool 1: Send message to channel (improved)
server.registerTool(
  "slack_send_message",
  {
    title: "Send Slack Message",
    description: "Send a message to a Slack channel or user",
    inputSchema: {
      channel: z.string().describe("Channel ID or name (e.g., #general, @username, or channel ID)"),
      text: z.string().describe("Message text to send")
    }
  },
  async ({ channel, text }) => {
    try {
      const slack = new WebClient(tokenData.access_token);
      
      let targetChannel = channel;
      
      // Handle user mentions - resolve to DM channel
      if (channel.startsWith('@') || !channel.startsWith('#') && !channel.startsWith('C')) {
        try {
          const userId = await resolveUserId(slack, channel);
          const dmResult = await slack.conversations.open({ users: userId });
          targetChannel = dmResult.channel.id;
        } catch (e) {
          return {
            content: [{
              type: "text",
              text: `❌ Could not find user or create DM with: ${channel}. Error: ${e.message}`
            }],
            isError: true
          };
        }
      }
      
      const result = await slack.chat.postMessage({
        channel: targetChannel,
        text: text
      });
      
      console.log(`📤 Message sent by ${tokenData.user_name} to ${channel}`);
      
      return {
        content: [{
          type: "text",
          text: `✅ Message sent successfully to ${channel}!\n\nTimestamp: ${result.ts}\nChannel: ${result.channel}\nSent as: ${tokenData.user_name} (${tokenData.team_name})`
        }]
      };
    } catch (error) {
      console.error(`❌ Send message failed for ${tokenData.user_name}:`, error.message);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to send message: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool 2: Send direct message (improved with user resolution)
server.registerTool(
  "slack_send_dm",
  {
    title: "Send Direct Message",
    description: "Send a direct message to a specific user. Always searches user info first to find the correct user.",
    inputSchema: {
      user: z.string().describe("User ID, @username, or display name to send DM to"),
      text: z.string().describe("Message text to send")
    }
  },
  async ({ user, text }) => {
    try {
      const slack = new WebClient(tokenData.access_token);
      
      // Always resolve user first
      const userId = await resolveUserId(slack, user);
      const userName = await getUserDisplayName(slack, userId);
      
      // Open DM channel with resolved user ID
      const dmResult = await slack.conversations.open({
        users: userId
      });
      
      const result = await slack.chat.postMessage({
        channel: dmResult.channel.id,
        text: text
      });
      
      console.log(`💬 DM sent by ${tokenData.user_name} to ${userName} (${userId})`);
      
      return {
        content: [{
          type: "text",
          text: `✅ Direct message sent to ${userName}!\n\nRecipient: ${userName} (@${user})\nUser ID: ${userId}\nTimestamp: ${result.ts}\nSent as: ${tokenData.user_name}`
        }]
      };
    } catch (error) {
      console.error(`❌ Send DM failed for ${tokenData.user_name}:`, error.message);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to send DM: ${error.message}\n\nTip: Try using the exact username, display name, or user ID. Use the search users tool first if needed.`
        }],
        isError: true
      };
    }
  }
);

// Tool 3: Get channels (improved pagination for large workspaces)
server.registerTool(
  "slack_get_channels",
  {
    title: "Get Slack Channels",
    description: "Get list of channels you have access to",
    inputSchema: {
      types: z.string().optional().describe("Channel types to include (public_channel,private_channel,mpim,im)").default("public_channel,private_channel"),
      limit: z.number().optional().describe("Maximum number of channels to return").default(100)
    }
  },
  async ({ types = "public_channel,private_channel", limit = 100 }) => {
    try {
      const slack = new WebClient(tokenData.access_token);
      
      let allChannels = [];
      let cursor = null;
      const pageLimit = 200; // Slack API limit
      
      do {
        const params = {
          types: types,
          limit: pageLimit
        };
        if (cursor) params.cursor = cursor;
        
        const channels = await slack.conversations.list(params);
        allChannels = allChannels.concat(channels.channels || []);
        cursor = channels.response_metadata?.next_cursor;
      } while (cursor && allChannels.length < limit);
      
      // Sort by member count (descending) then by name
      allChannels.sort((a, b) => {
        const membersA = a.num_members || 0;
        const membersB = b.num_members || 0;
        if (membersA !== membersB) {
          return membersB - membersA;
        }
        return (a.name || '').localeCompare(b.name || '');
      });
      
      const channelList = allChannels
        .slice(0, limit)
        .map(ch => {
          const type = ch.is_private ? '🔒 Private' : '🌍 Public';
          const members = ch.num_members ? ` (${ch.num_members} members)` : '';
          const archived = ch.is_archived ? ' [ARCHIVED]' : '';
          return `• #${ch.name} ${type}${members}${archived} - ${ch.id}`;
        })
        .join('\n');
      
      return {
        content: [{
          type: "text",
          text: `📋 Your channels in ${tokenData.team_name} (showing ${Math.min(limit, allChannels.length)} of ${allChannels.length}):\n\n${channelList}\n\n*Connected as: ${tokenData.user_name}*\n*Sorted by member count, then name*`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Failed to get channels: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool 4: Get workspace users (improved for large workspaces)
server.registerTool(
  "slack_get_users",
  {
    title: "Get Workspace Users",
    description: "Get list of users in your workspace. Optimized for large workspaces with search and filtering.",
    inputSchema: {
      limit: z.number().optional().describe("Maximum number of users to return").default(50),
      search: z.string().optional().describe("Search term to filter users by name or username"),
      include_bots: z.boolean().optional().describe("Include bot users").default(false),
      active_only: z.boolean().optional().describe("Only show active users").default(true)
    }
  },
  async ({ limit = 50, search, include_bots = false, active_only = true }) => {
    try {
      const slack = new WebClient(tokenData.access_token);
      
      let allUsers = [];
      let cursor = null;
      const pageLimit = 200; // Slack API limit
      
      // Get all users with pagination
      do {
        const params = { limit: pageLimit };
        if (cursor) params.cursor = cursor;
        
        const users = await slack.users.list(params);
        allUsers = allUsers.concat(users.members || []);
        cursor = users.response_metadata?.next_cursor;
      } while (cursor);
      
      // Filter users
      let filteredUsers = allUsers.filter(user => {
        if (user.deleted) return false;
        if (!include_bots && user.is_bot) return false;
        
        // Filter by search term if provided
        if (search) {
          const searchLower = search.toLowerCase();
          const matchesName = (user.real_name || '').toLowerCase().includes(searchLower);
          const matchesUsername = (user.name || '').toLowerCase().includes(searchLower);
          const matchesDisplayName = (user.profile?.display_name || '').toLowerCase().includes(searchLower);
          
          if (!matchesName && !matchesUsername && !matchesDisplayName) {
            return false;
          }
        }
        
        return true;
      });
      
      // Sort by presence (active first), then by real name
      filteredUsers.sort((a, b) => {
        // Active users first
        if (a.presence === 'active' && b.presence !== 'active') return -1;
        if (b.presence === 'active' && a.presence !== 'active') return 1;
        
        // Then by real name
        const nameA = (a.real_name || a.name || '').toLowerCase();
        const nameB = (b.real_name || b.name || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });
      
      const userList = filteredUsers
        .slice(0, limit)
        .map(user => {
          const status = user.presence || 'unknown';
          const statusIcon = status === 'active' ? '🟢' : '⚪';
          const realName = user.real_name || user.name;
          const displayName = user.profile?.display_name ? ` (${user.profile.display_name})` : '';
          const isCurrentUser = user.id === tokenData.user_id ? ' (YOU)' : '';
          const botIndicator = user.is_bot ? ' 🤖' : '';
          
          return `• ${statusIcon} ${realName}${displayName} (@${user.name}) - ${user.id}${isCurrentUser}${botIndicator}`;
        })
        .join('\n');
      
      const searchInfo = search ? ` matching "${search}"` : '';
      const totalInfo = `showing ${Math.min(limit, filteredUsers.length)} of ${filteredUsers.length} users${searchInfo}`;
      
      return {
        content: [{
          type: "text",
          text: `👥 Users in ${tokenData.team_name} (${totalInfo}):\n\n${userList}\n\n*Connected as: ${tokenData.user_name}*\n*🟢 = Active, ⚪ = Away/Offline, 🤖 = Bot*`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Failed to get users: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool 7: Search messages (improved with user resolution)
server.registerTool(
  "slack_search_messages",
  {
    title: "Search Slack Messages",
    description: "Search for messages across your workspace. Always resolves user info for better results.",
    inputSchema: {
      query: z.string().describe("Search query (e.g., 'from:@user', 'in:#channel', or just keywords)"),
      limit: z.number().optional().describe("Number of results to return").default(10),
      resolve_users: z.boolean().optional().describe("Resolve user IDs to display names").default(true)
    }
  },
  async ({ query, limit = 10, resolve_users = true }) => {
    try {
      const slack = new WebClient(tokenData.access_token);
      
      // Process query to resolve user references
      let processedQuery = query;
      
      // Look for user references in the query (from:@username, to:@username, etc.)
      const userRefPattern = /(from:|to:|mention:)@(\w+)/gi;
      const userRefs = [...query.matchAll(userRefPattern)];
      
      for (const match of userRefs) {
        const [fullMatch, prefix, username] = match;
        try {
          const userId = await resolveUserId(slack, username);
          processedQuery = processedQuery.replace(fullMatch, `${prefix}${userId}`);
        } catch (e) {
          console.warn(`Could not resolve user ${username} in search query`);
        }
      }
      
      const results = await slack.search.messages({
        query: processedQuery,
        count: Math.min(limit, 20)
      });
      
      if (!results.messages || results.messages.total === 0) {
        return {
          content: [{
            type: "text",
            text: `🔍 No messages found for query: "${query}"\n\n*Searched by: ${tokenData.user_name}*`
          }]
        };
      }
      
      const messageList = await Promise.all(
        results.messages.matches
          .slice(0, limit)
          .map(async (msg) => {
            const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
            const channel = msg.channel ? `#${msg.channel.name}` : 'DM';
            
            let userName = msg.user || 'Unknown';
            if (resolve_users && msg.user) {
              userName = await getUserDisplayName(slack, msg.user);
            }
            
            return `[${timestamp}] ${userName} in ${channel}: ${msg.text}`;
          })
      );
      
      return {
        content: [{
          type: "text",
          text: `🔍 Search results for "${query}":\n\n${messageList.join('\n\n')}\n\n*Found ${results.messages.total} total messages • Showing ${messageList.length} • Searched by: ${tokenData.user_name}*`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Failed to search messages: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool 8: Get user info (improved search capabilities)
server.registerTool(
  "slack_get_user_info",
  {
    title: "Get User Information",
    description: "Get detailed information about a specific user. Searches by username, display name, or user ID.",
    inputSchema: {
      user: z.string().describe("User ID, @username, or display name to get info for")
    }
  },
  async ({ user }) => {
    try {
      const slack = new WebClient(tokenData.access_token);
      
      // Resolve user ID first
      const userId = await resolveUserId(slack, user);
      const userInfo = await slack.users.info({ user: userId });
      
      const u = userInfo.user;
      const profile = u.profile || {};
      
      // Get additional presence info
      let presenceInfo = 'Unknown';
      try {
        const presence = await slack.users.getPresence({ user: userId });
        presenceInfo = presence.presence || 'Unknown';
        if (presence.auto_away) presenceInfo += ' (auto away)';
      } catch (e) {
        // Presence info not available
      }
      
      return {
        content: [{
          type: "text",
          text: `👤 User Information:

**Name:** ${u.real_name || u.name}
**Username:** @${u.name}
**Display Name:** ${profile.display_name || 'Not set'}
**ID:** ${u.id}
**Email:** ${profile.email || 'Not available'}
**Phone:** ${profile.phone || 'Not available'}
**Title:** ${profile.title || 'Not set'}
**Department:** ${profile.fields?.Xf0DMHFDQA?.value || 'Not set'}
**Status:** ${presenceInfo}
**Timezone:** ${u.tz_label || 'Not available'}
**Is Admin:** ${u.is_admin ? 'Yes' : 'No'}
**Is Owner:** ${u.is_owner ? 'Yes' : 'No'}
**Account Type:** ${u.is_bot ? 'Bot' : u.is_app_user ? 'App User' : 'Regular User'}
**2FA Enabled:** ${u.has_2fa ? 'Yes' : 'No'}

**Status Text:** ${profile.status_text || 'None'}
**Status Emoji:** ${profile.status_emoji || 'None'}

**Profile Image:** ${profile.image_original || profile.image_512 || 'Not available'}

*Retrieved by: ${tokenData.user_name}*`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Failed to get user info: ${error.message}\n\nTip: Try searching for users first with the "Get Workspace Users" tool to find the correct username or ID.`
        }],
        isError: true
      };
    }
  }
);

// Tool: Add user search helper
server.registerTool(
  "slack_search_users",
  {
    title: "Search Users",
    description: "Search for users by name, username, or email. Helpful before sending DMs or getting user info.",
    inputSchema: {
      search: z.string().describe("Search term (name, username, or email)"),
      limit: z.number().optional().describe("Maximum number of results").default(10)
    }
  },
  async ({ search, limit = 10 }) => {
    try {
      const slack = new WebClient(tokenData.access_token);
      
      let allUsers = [];
      let cursor = null;
      
      // Get all users with pagination
      do {
        const params = { limit: 200 };
        if (cursor) params.cursor = cursor;
        
        const users = await slack.users.list(params);
        allUsers = allUsers.concat(users.members || []);
        cursor = users.response_metadata?.next_cursor;
      } while (cursor);
      
      const searchLower = search.toLowerCase();
      
      // Filter and score matches
      const matches = allUsers
        .filter(user => !user.deleted && !user.is_bot)
        .map(user => {
          let score = 0;
          const realName = (user.real_name || '').toLowerCase();
          const username = (user.name || '').toLowerCase();
          const displayName = (user.profile?.display_name || '').toLowerCase();
          const email = (user.profile?.email || '').toLowerCase();
          
          // Exact matches get highest score
          if (username === searchLower) score += 100;
          if (realName === searchLower) score += 90;
          if (displayName === searchLower) score += 85;
          if (email === searchLower) score += 80;
          
          // Starts with matches
          if (username.startsWith(searchLower)) score += 50;
          if (realName.startsWith(searchLower)) score += 40;
          if (displayName.startsWith(searchLower)) score += 35;
          
          // Contains matches
          if (username.includes(searchLower)) score += 20;
          if (realName.includes(searchLower)) score += 15;
          if (displayName.includes(searchLower)) score += 10;
          if (email.includes(searchLower)) score += 5;
          
          return { user, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      
      if (matches.length === 0) {
        return {
          content: [{
            type: "text",
            text: `🔍 No users found matching "${search}"\n\n*Searched by: ${tokenData.user_name}*`
          }]
        };
      }
      
      const userList = matches.map(({ user, score }) => {
        const realName = user.real_name || user.name;
        const displayName = user.profile?.display_name ? ` (${user.profile.display_name})` : '';
        const email = user.profile?.email ? ` • ${user.profile.email}` : '';
        const status = user.presence === 'active' ? '🟢' : '⚪';
        
        return `• ${status} ${realName}${displayName} (@${user.name}) - ${user.id}${email}`;
      }).join('\n');
      
      return {
        content: [{
          type: "text",
          text: `🔍 User search results for "${search}":\n\n${userList}\n\n*Found ${matches.length} matches • Searched by: ${tokenData.user_name}*\n*🟢 = Active, ⚪ = Away/Offline*`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ Failed to search users: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Improved reaction tools with better user resolution
// (The reaction tools from your original code can be updated to use the resolveUserId helper function)
// I'll show the improved add_reaction as an example:

server.registerTool(
  "slack_add_reaction",
  {
    title: "Add Reaction to Message",
    description: "Add an emoji reaction to a Slack message in channels or DMs. Automatically resolves usernames.",
    inputSchema: {
      channel: z.string().describe("Channel ID, channel name (#channel), user ID (U123...), or username (@user) for DMs"),
      timestamp: z.string().describe("Message timestamp (from message history or search results)"),
      name: z.string().describe("Emoji name without colons (e.g., 'thumbsup', 'heart', 'fire', 'tada')")
    }
  },
  async ({ channel, timestamp, name }) => {
    try {
      const slack = new WebClient(tokenData.access_token);
      
      let channelId = channel;
      let resolvedTarget = channel;
      
      // Handle different channel formats with improved user resolution
      if (channel.startsWith('@')) {
        const userId = await resolveUserId(slack, channel);
        const userName = await getUserDisplayName(slack, userId);
        const dmResult = await slack.conversations.open({ users: userId });
        channelId = dmResult.channel.id;
        resolvedTarget = `DM with ${userName}`;
      }
      else if (channel.match(/^U[A-Z0-9]+$/)) {
        const userName = await getUserDisplayName(slack, channel);
        const dmResult = await slack.conversations.open({ users: channel });
        channelId = dmResult.channel.id;
        resolvedTarget = `DM with ${userName}`;
      }
      else if (channel.startsWith('#')) {
        channelId = channel.substring(1);
        resolvedTarget = channel;
      }
      
      // Add reaction to the message
      await slack.reactions.add({
        channel: channelId,
        timestamp: timestamp,
        name: name.replace(/:/g, '')
      });
      
      console.log(`👍 Reaction :${name}: added by ${tokenData.user_name} to message ${timestamp} in ${resolvedTarget}`);
      
      return {
        content: [{
          type: "text",
          text: `✅ Added :${name}: reaction to message!\n\nTarget: ${resolvedTarget}\nMessage timestamp: ${timestamp}\nReaction: :${name}:\nAdded by: ${tokenData.user_name}`
        }]
      };
    } catch (error) {
      console.error(`❌ Add reaction failed for ${tokenData.user_name}:`, error.message);
      return {
        content: [{
          type: "text",
          text: `❌ Failed to add reaction: ${error.message}\n\nTip: Make sure the message timestamp is correct and you have permission to react. Use the user search tool if you can't find the right user.`
        }],
        isError: true
      };
    }
  }
);
