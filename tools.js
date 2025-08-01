import { WebClient } from "@slack/web-api";
import { z } from "zod";

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

// Centralized user search function - used by multiple tools
async function searchUsersFunction(slack, searchTerm, limit = 10) {
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
  
  const searchLower = searchTerm.toLowerCase();
  
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
  
  return matches;
}

// Main function to register all Slack tools
export function registerSlackTools(server, tokenData, sessionId) {
  
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
        if (channel.startsWith('@') || (!channel.startsWith('#') && !channel.startsWith('C'))) {
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

  // Tool: Get Direct Messages
  server.registerTool(
    "slack_get_dms",
    {
      title: "Get Direct Messages",
      description: "Get direct messages with a specific user. Automatically searches for the user first.",
      inputSchema: {
        user: z.string().describe("User ID, @username, display name, or partial name to get DMs with"),
        limit: z.number().optional().describe("Number of messages to retrieve (max 100)").default(10)
      }
    },
    async ({ user, limit = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // First, search for the user to ensure we have the right person
        console.log(`🔍 Searching for user to get DMs: ${user}`);
        const searchResults = await searchUsersFunction(slack, user.replace('@', ''), 5);
        
        if (searchResults.length === 0) {
          return {
            content: [{
              type: "text",
              text: `❌ No user found matching "${user}". Please try:\n- Using the exact username (e.g., @john.smith)\n- Using the full display name (e.g., "John Smith")\n- Using the search users tool first to find the correct person`
            }],
            isError: true
          };
        }
        
        // If multiple matches, show them for disambiguation
        if (searchResults.length > 1) {
          const userList = searchResults.map(({ user: u }) => {
            const realName = u.real_name || u.name;
            const displayName = u.profile?.display_name ? ` (${u.profile.display_name})` : '';
            const email = u.profile?.email ? ` • ${u.profile.email}` : '';
            const status = u.presence === 'active' ? '🟢' : '⚪';
            
            return `• ${status} ${realName}${displayName} (@${u.name}) - ${u.id}${email}`;
          }).join('\n');
          
          return {
            content: [{
              type: "text",
              text: `🔍 Found ${searchResults.length} users matching "${user}":\n\n${userList}\n\nPlease be more specific or use the exact username/ID for the person whose DMs you want to see.`
            }]
          };
        }
        
        // Single match found - get DMs
        const targetUser = searchResults[0].user;
        const userId = targetUser.id;
        const userName = targetUser.real_name || targetUser.name;
        
        console.log(`✅ Found user: ${userName} (${userId}), getting DMs...`);
        
        // Open DM channel with the user
        const dmResult = await slack.conversations.open({
          users: userId
        });
        
        // Get messages from the DM channel
        const messages = await slack.conversations.history({
          channel: dmResult.channel.id,
          limit: Math.min(limit, 100)
        });
        
        if (!messages.messages || messages.messages.length === 0) {
          return {
            content: [{
              type: "text",
              text: `💬 No direct messages found with ${userName}\n\n*Retrieved by: ${tokenData.user_name}*`
            }]
          };
        }
        
        const messageList = messages.messages
          .slice(0, limit)
          .map((msg) => {
            const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
            const isFromMe = msg.user === tokenData.user_id;
            const sender = isFromMe ? 'You' : userName;
            return `[${timestamp}] ${sender}: ${msg.text || '(no text)'}`;
          });
        
        return {
          content: [{
            type: "text",
            text: `💬 Direct messages with ${userName} (@${targetUser.name}):\n\n${messageList.join('\n')}\n\n*Retrieved by: ${tokenData.user_name} • Total messages: ${messageList.length}*`
          }]
        };
      } catch (error) {
        console.error(`❌ Get DMs failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get direct messages: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Search Direct Messages
  server.registerTool(
    "slack_search_dms",
    {
      title: "Search Direct Messages",
      description: "Search for messages in direct message conversations. Automatically searches for the user first.",
      inputSchema: {
        user: z.string().describe("User ID, @username, display name, or partial name to search DMs with"),
        query: z.string().describe("Search query (keywords to search for in the DM conversation)"),
        limit: z.number().optional().describe("Number of results to return").default(10)
      }
    },
    async ({ user, query, limit = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // First, search for the user to ensure we have the right person
        console.log(`🔍 Searching for user to search DMs: ${user}`);
        const searchResults = await searchUsersFunction(slack, user.replace('@', ''), 5);
        
        if (searchResults.length === 0) {
          return {
            content: [{
              type: "text",
              text: `❌ No user found matching "${user}". Please try:\n- Using the exact username (e.g., @john.smith)\n- Using the full display name (e.g., "John Smith")\n- Using the search users tool first to find the correct person`
            }],
            isError: true
          };
        }
        
        // If multiple matches, show them for disambiguation
        if (searchResults.length > 1) {
          const userList = searchResults.map(({ user: u }) => {
            const realName = u.real_name || u.name;
            const displayName = u.profile?.display_name ? ` (${u.profile.display_name})` : '';
            const email = u.profile?.email ? ` • ${u.profile.email}` : '';
            const status = u.presence === 'active' ? '🟢' : '⚪';
            
            return `• ${status} ${realName}${displayName} (@${u.name}) - ${u.id}${email}`;
          }).join('\n');
          
          return {
            content: [{
              type: "text",
              text: `🔍 Found ${searchResults.length} users matching "${user}":\n\n${userList}\n\nPlease be more specific or use the exact username/ID for the person whose DMs you want to search.`
            }]
          };
        }
        
        // Single match found - search DMs
        const targetUser = searchResults[0].user;
        const userId = targetUser.id;
        const userName = targetUser.real_name || targetUser.name;
        
        console.log(`✅ Found user: ${userName} (${userId}), searching DMs...`);
        
        // Open DM channel with the user
        const dmResult = await slack.conversations.open({
          users: userId
        });
        
        // Search messages in the specific DM channel
        const searchQuery = `in:${dmResult.channel.id} ${query}`;
        console.log(`🔍 Searching with query: ${searchQuery}`);
        
        const results = await slack.search.messages({
          query: searchQuery,
          count: Math.min(limit, 20)
        });
        
        if (!results.messages || results.messages.total === 0) {
          return {
            content: [{
              type: "text",
              text: `🔍 No messages found for "${query}" in DMs with ${userName}\n\n*Searched by: ${tokenData.user_name}*`
            }]
          };
        }
        
        const messageList = results.messages.matches
          .slice(0, limit)
          .map(msg => {
            const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
            const isFromMe = msg.user === tokenData.user_id;
            const sender = isFromMe ? 'You' : userName;
            return `[${timestamp}] ${sender}: ${msg.text}`;
          });
        
        return {
          content: [{
            type: "text",
            text: `🔍 Search results for "${query}" in DMs with ${userName} (@${targetUser.name}):\n\n${messageList.join('\n\n')}\n\n*Found ${results.messages.total} total messages • Showing ${messageList.length} • Searched by: ${tokenData.user_name}*`
          }]
        };
      } catch (error) {
        console.error(`❌ Search DMs failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to search direct messages: ${error.message}`
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
        } while (cursor && allChannels.length < limit * 2); // Get extra for sorting
        
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
        active_only: z.boolean().optional().describe("Only show active users").default(false)
      }
    },
    async ({ limit = 50, search, include_bots = false, active_only = false }) => {
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
          if (active_only && user.presence !== 'active') return false;
          
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

  // Tool 5: Get workspace info (user-specific)
  server.registerTool(
    "slack_get_workspace_info",
    {
      title: "Get Workspace Info",
      description: "Get information about your workspace and profile",
      inputSchema: {}
    },
    async () => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const teamInfo = await slack.team.info();
        const userInfo = await slack.users.info({ user: tokenData.user_id });
        
        return {
          content: [{
            type: "text",
            text: `🏢 Your Workspace Information:

**Workspace:** ${teamInfo.team.name}
**Domain:** ${teamInfo.team.domain}.slack.com
**ID:** ${teamInfo.team.id}

**Your Profile:**
**Name:** ${userInfo.user.real_name || userInfo.user.name}
**Username:** @${userInfo.user.name}
**Email:** ${userInfo.user.profile.email || 'Not available'}
**Title:** ${userInfo.user.profile.title || 'Not set'}
**Status:** ${userInfo.user.presence || 'unknown'}

**Session Info:**
**Connected as:** ${tokenData.user_name}
**MCP Session:** ${sessionId}
**Token created:** ${tokenData.created_at}
**Permissions:** ${tokenData.scope ? tokenData.scope.split(',').length + ' scopes' : 'Standard scopes'}`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get workspace info: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 6: Get messages
  server.registerTool(
    "slack_get_messages",
    {
      title: "Get Slack Messages",
      description: "Get messages from a channel or DM",
      inputSchema: {
        channel: z.string().describe("Channel ID or name"),
        limit: z.number().optional().describe("Number of messages to retrieve (max 100)").default(10)
      }
    },
    async ({ channel, limit = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const messages = await slack.conversations.history({
          channel: channel,
          limit: Math.min(limit, 100)
        });
        
        const messageList = await Promise.all(
          messages.messages
            .slice(0, limit)
            .map(async (msg) => {
              const timestamp = new Date(parseInt(msg.ts) * 1000).toLocaleString();
              let userName = msg.user;
              
              // Try to get user's real name
              try {
                const userInfo = await slack.users.info({ user: msg.user });
                userName = userInfo.user.real_name || userInfo.user.name;
              } catch (e) {
                // Keep original user ID if lookup fails
              }
              
              return `[${timestamp}] ${userName}: ${msg.text || '(no text)'}`;
            })
        );
        
        return {
          content: [{
            type: "text",
            text: `💬 Recent messages from ${channel}:\n\n${messageList.join('\n')}\n\n*Retrieved by: ${tokenData.user_name}*`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get messages: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool 7: Search messages (improved with user resolution including display names)
  server.registerTool(
    "slack_search_messages",
    {
      title: "Search Slack Messages",
      description: "Search for messages across your workspace. Automatically resolves user info including display names for better results.",
      inputSchema: {
        query: z.string().describe("Search query (e.g., 'from:@user', 'from:John Smith', 'in:#channel', or just keywords)"),
        limit: z.number().optional().describe("Number of results to return").default(10),
        resolve_users: z.boolean().optional().describe("Resolve user IDs to display names").default(true)
      }
    },
    async ({ query, limit = 10, resolve_users = true }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // Process query to resolve user references (including display names)
        let processedQuery = query;
        
        // Look for user references in the query - expanded patterns
        const userRefPatterns = [
          /(from:|to:|mention:)@(\w+)/gi,           // from:@username
          /(from:|to:|mention:)"([^"]+)"/gi,        // from:"Display Name"
          /(from:|to:|mention:)'([^']+)'/gi,        // from:'Display Name'
          /(from:|to:|mention:)([A-Z][a-z]+ [A-Z][a-z]+)/gi  // from:John Smith
        ];
        
        for (const pattern of userRefPatterns) {
          const userRefs = [...query.matchAll(pattern)];
          
          for (const match of userRefs) {
            const [fullMatch, prefix, userIdentifier] = match;
            try {
              console.log(`🔍 Resolving user reference: ${userIdentifier}`);
              
              // Search for user using our centralized search function
              const searchResults = await searchUsersFunction(slack, userIdentifier, 1);
              
              if (searchResults.length > 0) {
                const userId = searchResults[0].user.id;
                const userName = searchResults[0].user.real_name || searchResults[0].user.name;
                console.log(`✅ Resolved "${userIdentifier}" to ${userName} (${userId})`);
                processedQuery = processedQuery.replace(fullMatch, `${prefix}${userId}`);
              } else {
                console.warn(`⚠️ Could not resolve user "${userIdentifier}" in search query`);
              }
            } catch (e) {
              console.warn(`❌ Error resolving user ${userIdentifier}:`, e.message);
            }
          }
        }
        
        console.log(`🔍 Original query: ${query}`);
        console.log(`🔍 Processed query: ${processedQuery}`);
        
        const results = await slack.search.messages({
          query: processedQuery,
          count: Math.min(limit, 20)
        });
        
        if (!results.messages || results.messages.total === 0) {
          return {
            content: [{
              type: "text",
              text: `🔍 No messages found for query: "${query}"\n\nTip: Try using exact usernames (@john.smith) or display names ("John Smith") for better results.\n\n*Searched by: ${tokenData.user_name}*`
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
            text: `🔍 Search results for "${query}":\n\n${messageList.join('\n\n')}\n\n*Found ${results.messages.total} total messages • Showing ${messageList.length} • Searched by: ${tokenData.user_name}*\n\nNote: User references were automatically resolved for better search results.`
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

  // Tool 9: Get channel info
  server.registerTool(
    "slack_get_channel_info",
    {
      title: "Get Channel Information",
      description: "Get detailed information about a specific channel",
      inputSchema: {
        channel: z.string().describe("Channel ID or name to get info for")
      }
    },
    async ({ channel }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        const channelInfo = await slack.conversations.info({ 
          channel: channel.replace('#', '') 
        });
        
        const ch = channelInfo.channel;
        const created = new Date(ch.created * 1000).toLocaleString();
        
        return {
          content: [{
            type: "text",
            text: `📺 Channel Information:

**Name:** #${ch.name}
**ID:** ${ch.id}
**Type:** ${ch.is_private ? '🔒 Private' : '🌍 Public'}
**Topic:** ${ch.topic?.value || 'None'}
**Purpose:** ${ch.purpose?.value || 'None'}
**Members:** ${ch.num_members || 'Unknown'}
**Created:** ${created}
**Is Archived:** ${ch.is_archived ? 'Yes' : 'No'}
**Is General:** ${ch.is_general ? 'Yes' : 'No'}

**Creator:** ${ch.creator || 'Unknown'}

*Retrieved by: ${tokenData.user_name} from ${tokenData.team_name}*`
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get channel info: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Add user search helper (now uses centralized search function)
  server.registerTool(
    "slack_search_users",
    {
      title: "Search Users",
      description: "Search for users by name, username, display name, or email. Helpful before sending DMs or getting user info.",
      inputSchema: {
        search: z.string().describe("Search term (name, username, display name, or email)"),
        limit: z.number().optional().describe("Maximum number of results").default(10)
      }
    },
    async ({ search, limit = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        console.log(`🔍 Searching for users matching: ${search}`);
        const matches = await searchUsersFunction(slack, search, limit);
        
        if (matches.length === 0) {
          return {
            content: [{
              type: "text",
              text: `🔍 No users found matching "${search}"\n\nTip: Try partial names, usernames, or email addresses.\n\n*Searched by: ${tokenData.user_name}*`
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
        
        console.log(`✅ Found ${matches.length} users matching "${search}"`);
        
        return {
          content: [{
            type: "text",
            text: `🔍 User search results for "${search}":\n\n${userList}\n\n*Found ${matches.length} matches • Searched by: ${tokenData.user_name}*\n*🟢 = Active, ⚪ = Away/Offline*\n\nYou can now use any of these names/usernames for DMs or other operations.`
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

  // Reaction Tools with improved user resolution
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

  // Tool: Remove reaction from message
  server.registerTool(
    "slack_remove_reaction",
    {
      title: "Remove Reaction from Message", 
      description: "Remove an emoji reaction from a Slack message in channels or DMs",
      inputSchema: {
        channel: z.string().describe("Channel ID, channel name (#channel), user ID (U123...), or username (@user) for DMs"),
        timestamp: z.string().describe("Message timestamp"),
        name: z.string().describe("Emoji name without colons (e.g., 'thumbsup', 'heart', 'fire')")
      }
    },
    async ({ channel, timestamp, name }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        let channelId = channel;
        let resolvedTarget = channel;
        
        // Handle different channel formats (same logic as add_reaction)
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
        
        // Remove reaction from the message
        await slack.reactions.remove({
          channel: channelId,
          timestamp: timestamp,
          name: name.replace(/:/g, '')
        });
        
        console.log(`👎 Reaction :${name}: removed by ${tokenData.user_name} from message ${timestamp} in ${resolvedTarget}`);
        
        return {
          content: [{
            type: "text",
            text: `✅ Removed :${name}: reaction from message!\n\nTarget: ${resolvedTarget}\nMessage timestamp: ${timestamp}\nReaction removed: :${name}:\nRemoved by: ${tokenData.user_name}`
          }]
        };
      } catch (error) {
        console.error(`❌ Remove reaction failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to remove reaction: ${error.message}\n\nTip: You can only remove reactions that you added, or you need admin permissions.`
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Get reactions on a message
  server.registerTool(
    "slack_get_reactions",
    {
      title: "Get Message Reactions",
      description: "Get all reactions on a specific Slack message in channels or DMs",
      inputSchema: {
        channel: z.string().describe("Channel ID, channel name (#channel), user ID (U123...), or username (@user) for DMs"),
        timestamp: z.string().describe("Message timestamp")
      }
    },
    async ({ channel, timestamp }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        let channelId = channel;
        let resolvedTarget = channel;
        
        // Handle different channel formats (same logic as add_reaction)
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
        
        // Get message with reactions
        const result = await slack.conversations.history({
          channel: channelId,
          latest: timestamp,
          oldest: timestamp,
          inclusive: true,
          limit: 1
        });
        
        if (!result.messages || result.messages.length === 0) {
          return {
            content: [{
              type: "text", 
              text: `❌ Message not found at timestamp ${timestamp} in ${resolvedTarget}`
            }],
            isError: true
          };
        }
        
        const message = result.messages[0];
        const reactions = message.reactions || [];
        
        if (reactions.length === 0) {
          return {
            content: [{
              type: "text",
              text: `📭 No reactions found on this message in ${resolvedTarget}\n\nMessage timestamp: ${timestamp}\nChecked by: ${tokenData.user_name}`
            }]
          };
        }
        
        // Format reactions with user counts
        const reactionList = reactions.map(reaction => {
          const users = reaction.users || [];
          const userCount = reaction.count || users.length;
          return `• :${reaction.name}: (${userCount} ${userCount === 1 ? 'person' : 'people'})`;
        }).join('\n');
        
        return {
          content: [{
            type: "text",
            text: `👍 Reactions on message in ${resolvedTarget}:\n\n${reactionList}\n\nMessage timestamp: ${timestamp}\nTotal reactions: ${reactions.length}\nChecked by: ${tokenData.user_name}`
          }]
        };
      } catch (error) {
        console.error(`❌ Get reactions failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get reactions: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool: React to latest message in channel or DM
  server.registerTool(
    "slack_react_to_latest",
    {
      title: "React to Latest Message",
      description: "Add a reaction to the most recent message in a channel or DM",
      inputSchema: {
        channel: z.string().describe("Channel ID, channel name (#channel), user ID (U123...), or username (@user) for DMs"),
        name: z.string().describe("Emoji name without colons (e.g., 'thumbsup', 'heart', 'fire', 'tada')"),
        exclude_self: z.boolean().optional().describe("Skip your own messages").default(true)
      }
    },
    async ({ channel, name, exclude_self = true }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        let channelId = channel;
        let resolvedTarget = channel;
        let isDM = false;
        
        // Handle different channel formats (same logic as add_reaction)
        if (channel.startsWith('@')) {
          const userId = await resolveUserId(slack, channel);
          const userName = await getUserDisplayName(slack, userId);
          isDM = true;
          const dmResult = await slack.conversations.open({ users: userId });
          channelId = dmResult.channel.id;
          resolvedTarget = `DM with ${userName}`;
        }
        else if (channel.match(/^U[A-Z0-9]+$/)) {
          const userName = await getUserDisplayName(slack, channel);
          isDM = true;
          const dmResult = await slack.conversations.open({ users: channel });
          channelId = dmResult.channel.id;
          resolvedTarget = `DM with ${userName}`;
        }
        else if (channel.startsWith('#')) {
          channelId = channel.substring(1);
          resolvedTarget = channel;
        }
        
        // Get recent messages
        const messages = await slack.conversations.history({
          channel: channelId,
          limit: 10
        });
        
        if (!messages.messages || messages.messages.length === 0) {
          return {
            content: [{
              type: "text",
              text: `❌ No messages found in ${resolvedTarget}`
            }],
            isError: true
          };
        }
        
        // Find the latest message (optionally excluding own messages)
        let targetMessage = null;
        for (const msg of messages.messages) {
          if (exclude_self && msg.user === tokenData.user_id) {
            continue; // Skip own messages
          }
          targetMessage = msg;
          break;
        }
        
        if (!targetMessage) {
          return {
            content: [{
              type: "text",
              text: `❌ No suitable message found in ${resolvedTarget} (excluding your own messages)`
            }],
            isError: true
          };
        }
        
        // Add reaction to the message
        await slack.reactions.add({
          channel: channelId,
          timestamp: targetMessage.ts,
          name: name.replace(/:/g, '')
        });
        
        console.log(`👍 Reaction :${name}: added by ${tokenData.user_name} to latest message in ${resolvedTarget}`);
        
        // Get user name for the message author
        let authorName = targetMessage.user;
        try {
          const userInfo = await slack.users.info({ user: targetMessage.user });
          authorName = userInfo.user.real_name || userInfo.user.name;
        } catch (e) {
          // Keep original user ID if lookup fails
        }
        
        const conversationType = isDM ? "DM" : "Channel";
        
        return {
          content: [{
            type: "text",
            text: `✅ Added :${name}: reaction to latest message!\n\n${conversationType}: ${resolvedTarget}\nMessage author: ${authorName}\nMessage preview: "${(targetMessage.text || '').substring(0, 100)}${targetMessage.text && targetMessage.text.length > 100 ? '...' : ''}"\nReaction: :${name}:\nAdded by: ${tokenData.user_name}`
          }]
        };
      } catch (error) {
        console.error(`❌ React to latest failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to react to latest message: ${error.message}\n\nTip: For DMs, make sure the user exists and you have permission to message them.`
          }],
          isError: true
        };
      }
    }
  );

  // File Tools
  // Tool: List files in workspace
  server.registerTool(
    "slack_list_files",
    {
      title: "List Slack Files",
      description: "List files uploaded to the workspace with filtering options",
      inputSchema: {
        channel: z.string().optional().describe("Filter by specific channel ID or name"),
        user: z.string().optional().describe("Filter by specific user ID or @username"),
        types: z.string().optional().describe("File types to include (e.g., 'images,pdfs,docs')"),
        count: z.number().optional().describe("Number of files to return (max 100)").default(20)
      }
    },
    async ({ channel, user, types, count = 20 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        const params = {
          count: Math.min(count, 100),
          page: 1
        };
        
        // Add filters if provided
        if (channel) {
          params.channel = channel.replace('#', '');
        }
        if (user) {
          // Resolve user if it's a name/username
          try {
            const userId = await resolveUserId(slack, user);
            params.user = userId;
          } catch (e) {
            params.user = user.replace('@', '');
          }
        }
        if (types) {
          params.types = types;
        }
        
        const result = await slack.files.list(params);
        
        if (!result.files || result.files.length === 0) {
          return {
            content: [{
              type: "text",
              text: `📁 No files found in ${tokenData.team_name}${channel ? ` in channel ${channel}` : ''}${user ? ` from user ${user}` : ''}\n\n*Searched by: ${tokenData.user_name}*`
            }]
          };
        }
        
        const fileList = await Promise.all(
          result.files.map(async (file) => {
            const fileSize = file.size ? `${Math.round(file.size / 1024)}KB` : 'Unknown size';
            const uploadDate = new Date(file.timestamp * 1000).toLocaleDateString();
            
            // Get uploader name
            let uploaderName = file.user;
            try {
              uploaderName = await getUserDisplayName(slack, file.user);
            } catch (e) {
              // Keep original user ID if lookup fails
            }
            
            // Get channel name if file is in a channel
            let channelName = 'Direct Message';
            if (file.channels && file.channels.length > 0) {
              try {
                const channelInfo = await slack.conversations.info({ channel: file.channels[0] });
                channelName = `#${channelInfo.channel.name}`;
              } catch (e) {
                channelName = file.channels[0];
              }
            }
            
            return `📄 **${file.name}** (${file.filetype.toUpperCase()})
   • ID: ${file.id}
   • Size: ${fileSize} 
   • Uploaded: ${uploadDate} by ${uploaderName}
   • Channel: ${channelName}
   • Comments: ${file.comments_count || 0}${file.title ? `\n   • Title: ${file.title}` : ''}`;
          })
        );
        
        return {
          content: [{
            type: "text",
            text: `📁 Files in ${tokenData.team_name}:\n\n${fileList.join('\n\n')}\n\n*Total: ${result.files.length} files • Retrieved by: ${tokenData.user_name}*`
          }]
        };
      } catch (error) {
        console.error(`❌ List files failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to list files: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Get file information and content
  server.registerTool(
    "slack_get_file",
    {
      title: "Get Slack File Content",
      description: "Get detailed information and content of a specific file",
      inputSchema: {
        file_id: z.string().describe("File ID to retrieve")
      }
    },
    async ({ file_id }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // Get file info
        const fileInfo = await slack.files.info({ file: file_id });
        
        if (!fileInfo.file) {
          return {
            content: [{
              type: "text",
              text: `❌ File not found: ${file_id}`
            }],
            isError: true
          };
        }
        
        const file = fileInfo.file;
        const fileSize = file.size ? `${Math.round(file.size / 1024)}KB` : 'Unknown size';
        const uploadDate = new Date(file.timestamp * 1000).toLocaleString();
        
        // Get uploader name
        let uploaderName = file.user;
        try {
          uploaderName = await getUserDisplayName(slack, file.user);
        } catch (e) {
          // Keep original user ID if lookup fails
        }
        
        // Get channel names
        let channelNames = 'Direct Message';
        if (file.channels && file.channels.length > 0) {
          const channelPromises = file.channels.map(async (channelId) => {
            try {
              const channelInfo = await slack.conversations.info({ channel: channelId });
              return `#${channelInfo.channel.name}`;
            } catch (e) {
              return channelId;
            }
          });
          const channels = await Promise.all(channelPromises);
          channelNames = channels.join(', ');
        }
        
        let response = `📄 **File Details:**

**Name:** ${file.name}
**ID:** ${file.id}
**Type:** ${file.filetype.toUpperCase()}
**Size:** ${fileSize}
**Uploaded:** ${uploadDate} by ${uploaderName}
**Channels:** ${channelNames}
**Comments:** ${file.comments_count || 0}
**Public:** ${file.is_public ? 'Yes' : 'No'}`;

        if (file.title) response += `\n**Title:** ${file.title}`;
        if (file.initial_comment) response += `\n**Description:** ${file.initial_comment.comment}`;
        
        // For text files, try to get the content
        if (file.mimetype && file.mimetype.startsWith('text/') && file.url_private) {
          try {
            const contentResponse = await fetch(file.url_private, {
              headers: {
                'Authorization': `Bearer ${tokenData.access_token}`
              }
            });
            
            if (contentResponse.ok) {
              const content = await contentResponse.text();
              response += `\n\n**📝 File Content:**\n\`\`\`\n${content.substring(0, 2000)}${content.length > 2000 ? '\n... (content truncated)' : ''}\n\`\`\``;
            }
          } catch (contentError) {
            response += `\n\n**Note:** Could not retrieve file content: ${contentError.message}`;
          }
        } else if (file.url_private) {
          response += `\n\n**Download URL:** ${file.url_private}`;
          response += `\n**Note:** This file type (${file.filetype}) cannot be displayed as text. Use the download URL to access the file.`;
        }
        
        response += `\n\n*Retrieved by: ${tokenData.user_name}*`;
        
        return {
          content: [{
            type: "text",
            text: response
          }]
        };
      } catch (error) {
        console.error(`❌ Get file failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get file: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Search files by name or content
  server.registerTool(
    "slack_search_files",
    {
      title: "Search Slack Files",
      description: "Search for files by name, content, or other criteria",
      inputSchema: {
        query: z.string().describe("Search query (filename, content, or keywords)"),
        count: z.number().optional().describe("Number of results to return (max 20)").default(10)
      }
    },
    async ({ query, count = 10 }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        const result = await slack.search.files({
          query: query,
          count: Math.min(count, 20)
        });
        
        if (!result.files || result.files.total === 0) {
          return {
            content: [{
              type: "text",
              text: `🔍 No files found for query: "${query}"\n\n*Searched by: ${tokenData.user_name}*`
            }]
          };
        }
        
        const fileList = await Promise.all(
          result.files.matches.slice(0, count).map(async (file) => {
            const fileSize = file.size ? `${Math.round(file.size / 1024)}KB` : 'Unknown size';
            const uploadDate = new Date(file.timestamp * 1000).toLocaleDateString();
            
            // Get uploader name
            let uploaderName = file.user;
            try {
              uploaderName = await getUserDisplayName(slack, file.user);
            } catch (e) {
              // Keep original user ID if lookup fails
            }
            
            return `📄 **${file.name}** (${file.filetype.toUpperCase()})
   • ID: ${file.id}
   • Size: ${fileSize}
   • Uploaded: ${uploadDate} by ${uploaderName}${file.title ? `\n   • Title: ${file.title}` : ''}`;
          })
        );
        
        return {
          content: [{
            type: "text",
            text: `🔍 Search results for "${query}":\n\n${fileList.join('\n\n')}\n\n*Found ${result.files.total} total files • Showing ${fileList.length} • Searched by: ${tokenData.user_name}*`
          }]
        };
      } catch (error) {
        console.error(`❌ Search files failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to search files: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );

  // Tool: Get file comments
  server.registerTool(
    "slack_get_file_comments",
    {
      title: "Get File Comments",
      description: "Get comments and discussions on a specific file",
      inputSchema: {
        file_id: z.string().describe("File ID to get comments for")
      }
    },
    async ({ file_id }) => {
      try {
        const slack = new WebClient(tokenData.access_token);
        
        // Get file info with comments
        const fileInfo = await slack.files.info({ 
          file: file_id,
          count: 100 // Get up to 100 comments
        });
        
        if (!fileInfo.file) {
          return {
            content: [{
              type: "text",
              text: `❌ File not found: ${file_id}`
            }],
            isError: true
          };
        }
        
        const file = fileInfo.file;
        
        if (!file.comments || file.comments.length === 0) {
          return {
            content: [{
              type: "text",
              text: `💬 No comments found on file: ${file.name}\n\n*Checked by: ${tokenData.user_name}*`
            }]
          };
        }
        
        const commentList = await Promise.all(
          file.comments.map(async (comment) => {
            const commentDate = new Date(comment.timestamp * 1000).toLocaleString();
            
            // Get commenter name
            let commenterName = comment.user;
            try {
              commenterName = await getUserDisplayName(slack, comment.user);
            } catch (e) {
              // Keep original user ID if lookup fails
            }
            
            return `💬 **${commenterName}** (${commentDate}):\n${comment.comment}`;
          })
        );
        
        return {
          content: [{
            type: "text",
            text: `💬 Comments on file: **${file.name}**\n\n${commentList.join('\n\n')}\n\n*Total: ${file.comments.length} comments • Retrieved by: ${tokenData.user_name}*`
          }]
        };
      } catch (error) {
        console.error(`❌ Get file comments failed for ${tokenData.user_name}:`, error.message);
        return {
          content: [{
            type: "text",
            text: `❌ Failed to get file comments: ${error.message}`
          }],
          isError: true
        };
      }
    }
  );
}
