// Load environment variables
require('dotenv').config();

const { App, ExpressReceiver } = require('@slack/bolt');
const { Client } = require('@notionhq/client');

// Define a timeout for Notion API requests (10 seconds)
const NOTION_TIMEOUT_MS = 10000;

// Initialize a custom receiver
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
  endpoints: {
    events: '/slack/events'
  }
});
 
// Add challenge handling
receiver.router.post('/slack/events', (req, res, next) => {
  if (req.body && req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }
  next();
});

receiver.router.get('/test', (req, res) => {
  return res.send('HelperBot is running!');
});

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// Initialize Notion client with timeout
const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  timeoutMs: NOTION_TIMEOUT_MS
});

// Database IDs for different request types
const databaseIds = {
  feature: process.env.NOTION_FEATURE_DATABASE_ID,
  bd: process.env.NOTION_BD_DATABASE_ID
};

// Valid status options for each database type
const validStatuses = {
  feature: ['New', 'In Progress', 'Pending Review', 'Completed', 'Rejected'],
  bd: ['Not in CRM yet', 'Added to CRM']
};

// Determine request type based on message content
function getRequestType(text) {
  console.log(`Checking request type for message: "${text}"`);
  const lowerText = text.toLowerCase();
  const isBdRequest = lowerText.includes('bd') || lowerText.includes('business development');
  const requestType = isBdRequest ? 'bd' : 'feature';
  console.log(`Detected request type: ${requestType}`);
  return requestType;
}

// Test Notion connection at startup
async function testNotionConnections() {
  const results = {};
  
  try {
    // Test feature database connection
    const featureDbInfo = await notion.databases.retrieve({
      database_id: databaseIds.feature
    });
    console.log("Feature database connection successful:", featureDbInfo.title);
    results.feature = true;
  } catch (error) {
    console.error("Failed to connect to feature database:", error.message);
    results.feature = false;
  }
  
  try {
    // Test BD database connection
    const bdDbInfo = await notion.databases.retrieve({
      database_id: databaseIds.bd
    });
    console.log("BD database connection successful:", bdDbInfo.title);
    results.bd = true;
  } catch (error) {
    console.error("Failed to connect to BD database:", error.message);
    results.bd = false;
  }
  
  return results;
}

// Run connection tests at startup
testNotionConnections();

// Parse message commands
function parseCommand(text) {
  const requestType = getRequestType(text);
  const lowerText = text.toLowerCase();
  
  if (lowerText.includes('help') || lowerText.includes('commands')) {
    return { type: 'help' };
  }
  
  if (lowerText.includes('status')) {
    return { 
      type: 'status',
      requestType: requestType,
      showCompleted: lowerText.includes('all') || lowerText.includes('completed')
    };
  }
  
  if (lowerText.includes('update') && lowerText.includes(' to ')) {
    const parts = text.split(/update\s+/i)[1].split(/\s+to\s+/i);
    if (parts.length >= 2) {
      return {
        type: 'update',
        requestType: requestType,
        featureQuery: parts[0].trim(),
        newStatus: parts[1].trim().replace(/"/g, '')
      };
    }
  }
  
  // Default: create request
  return { 
    type: 'create',
    requestType: requestType
  };
}

// Handle app_mention event
app.event('app_mention', async ({ event, client }) => {
  try {
    console.log('Received app_mention event:', event.text);
    const threadTs = event.thread_ts || event.ts;
    const command = parseCommand(event.text);
    console.log('Parsed command:', command);
    
    // Handle different command types
    switch (command.type) {
      case 'help':
        await handleHelpCommand(client, event.channel, threadTs);
        break;
        
      case 'status':
        await handleStatusCommand(client, event.channel, threadTs, command.requestType, command.showCompleted);
        break;
        
      case 'update':
        await handleUpdateCommand(client, event.channel, threadTs, command.requestType, command.featureQuery, command.newStatus);
        break;
        
      case 'create':
      default:
        await handleCreateCommand(client, event.channel, threadTs, command.requestType);
    }
  } catch (error) {
    console.error('Error handling command:', error);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts || event.ts,
        text: `❌ Something went wrong: ${error.message}`,
        unfurl_links: false
      });
    } catch (chatError) {
      console.error('Failed to send error message:', chatError);
    }
  }
});

// Help command handler
async function handleHelpCommand(client, channel, threadTs) {
  const helpText = `*HelperBot Commands:*\n
- *Create a request:* Tag @helperbot in a thread to save the thread
  - Include "bd" in your message for business development requests
  - Otherwise it will be saved as a feature request

- *Update status:* 
  - @helperbot update [feature] to [status]
  - @helperbot update bd [title] to [status]

- *Check statuses:* 
  - @helperbot status (features only)
  - @helperbot status bd (BD requests only)
  - Add "all" to include completed requests

- *Help:* @helperbot help

*Valid statuses:*
- Feature requests: ${validStatuses.feature.join(', ')}
- BD requests: ${validStatuses.bd.join(', ')}`;

  await client.chat.postMessage({
    channel: channel,
    thread_ts: threadTs,
    text: helpText,
    unfurl_links: false
  });
}

// Status command handler
async function handleStatusCommand(client, channel, threadTs, requestType, showCompleted) {
  const dbType = requestType.charAt(0).toUpperCase() + requestType.slice(1);
  
  const loadingMessage = await client.chat.postMessage({
    channel: channel,
    thread_ts: threadTs,
    text: `Fetching ${dbType} statuses...`,
    unfurl_links: false
  });

  try {
    // Get the appropriate database ID
    const dbId = databaseIds[requestType];
    
    if (!dbId) {
      throw new Error(`No database ID configured for ${requestType} requests`);
    }
    
    console.log(`Querying ${requestType} database with ID: ${dbId}`);
    
    // Create query options
    const queryOptions = {
      database_id: dbId,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 10
    };
    
    if (!showCompleted) {
      // Use the appropriate statuses for each database type
      const completedStatus = requestType === 'bd' ? 'Added to CRM' : 'Completed';
      
      queryOptions.filter = {
        property: "Status",
        select: { does_not_equal: completedStatus }
      };
    }
    
    // Query with timeout protection
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timed out')), NOTION_TIMEOUT_MS)
    );
    
    const responsePromise = notion.databases.query(queryOptions);
    const response = await Promise.race([responsePromise, timeoutPromise]);
    
    // Format response
    let formattedResponse = `*${dbType} Requests Status:*\n\n`;
    
    if (response.results.length === 0) {
      formattedResponse += "No requests found.";
    } else {
      response.results.forEach((page) => {
        try {
          const title = page.properties.Title?.title[0]?.text?.content || "Untitled";
          const status = page.properties.Status?.select?.name || "Unknown";
          formattedResponse += `• *${title}* - ${status}\n`;
        } catch (err) {
          formattedResponse += `• *Error formatting request*\n`;
        }
      });
    }
    
    if (!showCompleted) {
      const completedStatus = requestType === 'bd' ? 'Added to CRM' : 'Completed';
      formattedResponse += `\n_${completedStatus} ${requestType} requests are hidden. Use '@helperbot status ${requestType} all' to see everything._`;
    }
    
    await client.chat.update({
      channel: channel,
      ts: loadingMessage.ts,
      text: formattedResponse,
      unfurl_links: false
    });
  } catch (error) {
    let errorMessage = `❌ Failed to fetch ${requestType} requests`;
    
    if (error.message.includes('timed out')) {
      errorMessage += ": Request timed out. The Notion API might be experiencing delays.";
    } else if (error.code === 'notFound') {
      errorMessage += ": Database not found. Please check your configuration.";
    } else {
      errorMessage += `: ${error.message}`;
    }
    
    console.error(`Error fetching ${requestType} status:`, error);
    
    await client.chat.update({
      channel: channel,
      ts: loadingMessage.ts,
      text: errorMessage,
      unfurl_links: false
    });
  }
}

// Update command handler
async function handleUpdateCommand(client, channel, threadTs, requestType, featureQuery, newStatus) {
  try {
    console.log(`Updating ${requestType} request: "${featureQuery}" to status: "${newStatus}"`);
    
    // Get the appropriate database ID
    const dbId = databaseIds[requestType];
    
    if (!dbId) {
      throw new Error(`No database ID configured for ${requestType} requests`);
    }
    
    // Validate status based on request type
    const statusOptions = validStatuses[requestType];
    const exactStatusMatch = statusOptions.find(status => 
      status.toLowerCase() === newStatus.toLowerCase()
    );
    
    if (!exactStatusMatch) {
      await client.chat.postMessage({
        channel: channel,
        thread_ts: threadTs,
        text: `❌ Invalid status: "${newStatus}". Valid statuses for ${requestType} are: ${statusOptions.join(', ')}`,
        unfurl_links: false
      });
      return;
    }
    
    // Find the item
    const response = await notion.databases.query({
      database_id: dbId,
      filter: {
        property: 'Title',
        rich_text: { contains: featureQuery }
      },
      page_size: 5
    });
    
    if (response.results.length === 0) {
      await client.chat.postMessage({
        channel: channel,
        thread_ts: threadTs,
        text: `❌ No ${requestType} request found matching "${featureQuery}"`,
        unfurl_links: false
      });
      return;
    }
    
    if (response.results.length > 1) {
      let multipleMatches = `Found multiple matches for "${featureQuery}". Please be more specific:\n\n`;
      response.results.forEach(page => {
        const title = page.properties.Title.title[0]?.text.content || "Untitled";
        multipleMatches += `• *${title}*\n`;
      });
      
      await client.chat.postMessage({
        channel: channel,
        thread_ts: threadTs,
        text: multipleMatches,
        unfurl_links: false
      });
      return;
    }
    
    // Update the item
    const item = response.results[0];
    const currentStatus = item.properties.Status.select?.name || "Unknown";
    const title = item.properties.Title.title[0]?.text.content || "Untitled";
    
    await notion.pages.update({
      page_id: item.id,
      properties: {
        Status: {
          select: { name: exactStatusMatch }
        }
      }
    });
    
    await client.chat.postMessage({
      channel: channel,
      thread_ts: threadTs,
      text: `✅ Updated status of "${title}" from "${currentStatus}" to "${exactStatusMatch}"`,
      unfurl_links: false
    });
  } catch (error) {
    let errorMessage = `❌ Failed to update ${requestType} request status`;
    
    if (error.message.includes('timed out')) {
      errorMessage += ": Request timed out. The Notion API might be experiencing delays.";
    } else if (error.code === 'notFound') {
      errorMessage += ": Item or database not found. Please check your request.";
    } else {
      errorMessage += `: ${error.message}`;
    }
    
    console.error(`Error updating ${requestType} status:`, error);
    
    await client.chat.postMessage({
      channel: channel,
      thread_ts: threadTs,
      text: errorMessage,
      unfurl_links: false
    });
  }
}

// Create command handler
async function handleCreateCommand(client, channel, threadTs, requestType) {
  try {
    console.log(`Creating ${requestType} request in thread ${threadTs}`);
    
    // Get thread info
    const replies = await client.conversations.replies({
      channel: channel,
      ts: threadTs
    });
    
    if (!replies.messages || replies.messages.length === 0) {
      throw new Error('No messages found in thread');
    }
    
    // Extract thread information
    const originalMessage = replies.messages[0];
    const threadMessages = replies.messages.slice(1);
    
    // Get user info
    const requesterInfo = await client.users.info({
      user: originalMessage.user
    });
    
    // Get channel info
    const channelInfo = await client.conversations.info({
      channel: channel
    });
    
   // Format request title
let requestTitle = originalMessage.text.split('\n')[0].substring(0, 80);
const requestTypeCapitalized = requestType.charAt(0).toUpperCase() + requestType.slice(1);

// NEW CODE: Extract team name for BD requests
if (requestType === 'bd') {
  // Look for patterns like "add X to bd" or "add X to business development"
  const addToBdRegex = /add\s+(\w+)\s+to\s+(bd|business development)/i;
  const match = originalMessage.text.match(addToBdRegex);
  
  if (match && match[1]) {
    // We found a team name to add
    const teamName = match[1];
    requestTitle = `${requestTypeCapitalized} request: Add ${teamName}`;
  } else if (requestTitle.includes('<@')) {
    // Clean up any Slack user IDs if present
    requestTitle = requestTitle.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!requestTitle.toLowerCase().includes(requestType)) {
      requestTitle = `${requestTypeCapitalized} request: ${requestTitle}`;
    }
  } else if (!requestTitle.toLowerCase().includes(requestType)) {
    requestTitle = `${requestTypeCapitalized} request: ${requestTitle}`;
  }
} else if (!requestTitle.toLowerCase().includes(requestType)) {
  requestTitle = `${requestTypeCapitalized} request: ${requestTitle}`;
}
    
    // Build description from thread
    let fullDescription = `*Original request by ${requesterInfo.user.real_name}:*\n${originalMessage.text}\n\n`;
    
    if (threadMessages.length > 0) {
      fullDescription += "*Additional context from thread:*\n";
      for (const msg of threadMessages) {
        if (!msg.text || msg.text.includes('@helperbot')) continue;
        
        try {
          const userInfo = await client.users.info({ user: msg.user });
          fullDescription += `- ${userInfo.user.real_name}: ${msg.text}\n`;
        } catch (error) {
          fullDescription += `- Unknown User: ${msg.text}\n`;
        }
      }
    }
    
    // Select the database ID based on request type
    const dbId = databaseIds[requestType];
    console.log(`Using database ID: ${dbId} for ${requestType} request`);
    
    if (!dbId) {
      throw new Error(`No database ID configured for ${requestType} requests`);
    }
    
    // Determine initial status based on request type
    const initialStatus = requestType === 'bd' ? validStatuses.bd[0] : validStatuses.feature[0];
    
    // Create Notion page with retry logic
    const maxRetries = 3;
    let attempt = 0;
    let success = false;
    
    while (attempt < maxRetries && !success) {
      try {
        attempt++;
          await notion.pages.create({
            parent: { database_id: dbId },
            properties: {
              Title: {
                title: [{ text: { content: requestTitle } }]
              },
              Status: {
                select: { name: initialStatus }
              },
              "Slack URL": {
                url: `https://slack.com/archives/${channel}/p${threadTs.replace('.', '')}`
              },
              "Date Created": {
                date: { 
                  start: new Date().toISOString() 
                }
              }
            },
          children: [
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [
                  {
                    type: "text",
                    text: {
                      content: fullDescription
                    }
                  }
                ]
              }
            },
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: [
                  {
                    type: "text",
                    text: {
                      content: `Requested in #${channelInfo.channel?.name || channel} on ${new Date(parseInt(threadTs) * 1000).toLocaleString()}`
                    }
                  }
                ]
              }
            }
          ]
        });
        success = true;
        console.log(`Successfully created ${requestType} request in Notion`);
      } catch (error) {
        if (attempt >= maxRetries) {
          throw error;
        }
        console.error(`Create attempt ${attempt} failed: ${error.message}. Retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
      }
    }
    
    // Confirm in thread
    await client.chat.postMessage({
      channel: channel,
      thread_ts: threadTs,
      text: `✅ ${requestTypeCapitalized} request saved to Notion database!`,
      unfurl_links: false
    });
  } catch (error) {
    let errorMessage = `❌ Failed to save ${requestType} request`;
    
    if (error.message.includes('timed out')) {
      errorMessage += ": Request timed out. The Notion API might be experiencing delays.";
    } else if (error.code === 'notFound') {
      errorMessage += ": Database not found. Please check your configuration.";
    } else if (error.message.includes('Date Created')) {
      errorMessage += ": 'Date Created' property issue. Please add this property to your Notion database.";
    } else {
      errorMessage += `: ${error.message}`;
    }
    
    console.error(`Error creating ${requestType} request:`, error);
    
    await client.chat.postMessage({
      channel: channel,
      thread_ts: threadTs,
      text: errorMessage,
      unfurl_links: false
    });
  }
}

// For serverless function handles
module.exports = async (req, res) => {
  // Special handling for URL verification
  if (req.method === 'POST' && req.body && req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }
   
  // Use the receiver's request handler
  try {
    await receiver.app.handle(req, res);
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).send('Internal Server Error');
  }
};