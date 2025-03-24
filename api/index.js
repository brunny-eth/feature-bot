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
  return res.send('FeatureBot is running!');
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

const databaseId = process.env.NOTION_DATABASE_ID;

// Valid status options
const validStatuses = ['New', 'In Progress', 'Pending Review', 'Completed', 'Rejected'];

// Test Notion connection at startup
async function testNotionConnection() {
  try {
    const dbInfo = await notion.databases.retrieve({
      database_id: databaseId
    });
    console.log("Notion connection successful:", dbInfo.title);
    return true;
  } catch (error) {
    console.error("Failed to connect to Notion:", error.message);
    return false;
  }
}

testNotionConnection();

// Parse message commands
function parseCommand(text) {
  const lowerText = text.toLowerCase();
  
  if (lowerText.includes('help') || lowerText.includes('commands')) {
    return { type: 'help' };
  }
  
  if (lowerText.includes('status')) {
    return { 
      type: 'status',
      showCompleted: lowerText.includes('all') || lowerText.includes('completed')
    };
  }
  
  if (lowerText.includes('update') && lowerText.includes(' to ')) {
    const parts = text.split(/update\s+/i)[1].split(/\s+to\s+/i);
    if (parts.length >= 2) {
      return {
        type: 'update',
        featureQuery: parts[0].trim(),
        newStatus: parts[1].trim().replace(/"/g, '')
      };
    }
  }
  
  // Default: create feature request
  return { type: 'create' };
}

// Handle app_mention event
app.event('app_mention', async ({ event, client }) => {
  try {
    console.log('Received app_mention event');
    const threadTs = event.thread_ts || event.ts;
    const command = parseCommand(event.text);
    
    // Handle different command types
    switch (command.type) {
      case 'help':
        await handleHelpCommand(client, event.channel, threadTs);
        break;
        
      case 'status':
        await handleStatusCommand(client, event.channel, threadTs, command.showCompleted);
        break;
        
      case 'update':
        await handleUpdateCommand(client, event.channel, threadTs, command.featureQuery, command.newStatus);
        break;
        
      case 'create':
      default:
        await handleCreateCommand(client, event.channel, threadTs);
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
  const helpText = `*FeatureBot Commands:*\n
- *Create a feature request:* Tag @featurebot in a thread to save the thread as a feature request
- *Update status:* @featurebot update [feature] to [status]
- *Check statuses:* @featurebot status (or @featurebot status all to include completed features)
- *Help:* @featurebot help
*Valid statuses:* New, In Progress, Pending Review, Completed, Rejected`;

  await client.chat.postMessage({
    channel: channel,
    thread_ts: threadTs,
    text: helpText,
    unfurl_links: false
  });
}

// Status command handler
async function handleStatusCommand(client, channel, threadTs, showCompleted) {
  const loadingMessage = await client.chat.postMessage({
    channel: channel,
    thread_ts: threadTs,
    text: "Fetching feature statuses...",
    unfurl_links: false
  });

  try {
    // Create query options
    const queryOptions = {
      database_id: databaseId,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 10
    };
    
    if (!showCompleted) {
      queryOptions.filter = {
        property: "Status",
        select: { does_not_equal: "Completed" }
      };
    }
    
    // Query with timeout protection
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timed out')), NOTION_TIMEOUT_MS)
    );
    
    const responsePromise = notion.databases.query(queryOptions);
    const response = await Promise.race([responsePromise, timeoutPromise]);
    
    // Format response
    let formattedResponse = "*Feature Requests Status:*\n\n";
    
    if (response.results.length === 0) {
      formattedResponse += "No features found.";
    } else {
      response.results.forEach((page) => {
        try {
          const title = page.properties.Title?.title[0]?.text?.content || "Untitled";
          const status = page.properties.Status?.select?.name || "Unknown";
          formattedResponse += `• *${title}* - ${status}\n`;
        } catch (err) {
          formattedResponse += `• *Error formatting feature*\n`;
        }
      });
    }
    
    if (!showCompleted) {
      formattedResponse += "\n_Completed features are hidden. Use '@featurebot status all' to see everything._";
    }
    
    await client.chat.update({
      channel: channel,
      ts: loadingMessage.ts,
      text: formattedResponse,
      unfurl_links: false
    });
  } catch (error) {
    let errorMessage = "❌ Failed to fetch features";
    
    if (error.message.includes('timed out')) {
      errorMessage += ": Request timed out. The Notion API might be experiencing delays.";
    } else {
      errorMessage += `: ${error.message}`;
    }
    
    await client.chat.update({
      channel: channel,
      ts: loadingMessage.ts,
      text: errorMessage,
      unfurl_links: false
    });
  }
}

// Update command handler
async function handleUpdateCommand(client, channel, threadTs, featureQuery, newStatus) {
  try {
    // Validate status
    const exactStatusMatch = validStatuses.find(status => 
      status.toLowerCase() === newStatus.toLowerCase()
    );
    
    if (!exactStatusMatch) {
      await client.chat.postMessage({
        channel: channel,
        thread_ts: threadTs,
        text: `❌ Invalid status: "${newStatus}". Valid statuses are: ${validStatuses.join(', ')}`,
        unfurl_links: false
      });
      return;
    }
    
    // Find the feature
    const response = await notion.databases.query({
      database_id: databaseId,
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
        text: `❌ No feature found matching "${featureQuery}"`,
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
    
    // Update the feature
    const feature = response.results[0];
    const currentStatus = feature.properties.Status.select?.name || "Unknown";
    const title = feature.properties.Title.title[0]?.text.content || "Untitled";
    
    await notion.pages.update({
      page_id: feature.id,
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
    await client.chat.postMessage({
      channel: channel,
      thread_ts: threadTs,
      text: `❌ Failed to update feature status: ${error.message}`,
      unfurl_links: false
    });
  }
}

// Create command handler
async function handleCreateCommand(client, channel, threadTs) {
  try {
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
    
    // Format feature request
    let featureTitle = originalMessage.text.split('\n')[0].substring(0, 80);
    if (!featureTitle.toLowerCase().includes('feature')) {
      featureTitle = "Feature request: " + featureTitle;
    }
    
    // Build description from thread
    let fullDescription = `*Original request by ${requesterInfo.user.real_name}:*\n${originalMessage.text}\n\n`;
    
    if (threadMessages.length > 0) {
      fullDescription += "*Additional context from thread:*\n";
      for (const msg of threadMessages) {
        if (!msg.text || msg.text.includes('@featurebot')) continue;
        
        try {
          const userInfo = await client.users.info({ user: msg.user });
          fullDescription += `- ${userInfo.user.real_name}: ${msg.text}\n`;
        } catch (error) {
          fullDescription += `- Unknown User: ${msg.text}\n`;
        }
      }
    }
    
    // Create Notion page
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        Title: {
          title: [{ text: { content: featureTitle } }]
        },
        Status: {
          select: { name: "New" }
        },
        "Slack URL": {
          url: `https://slack.com/archives/${channel}/p${threadTs.replace('.', '')}`
        },
        "Date Created": {
          date: {
            start: new Date(parseInt(originalMessage.ts) * 1000).toISOString()
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
    
    // Confirm in thread
    await client.chat.postMessage({
      channel: channel,
      thread_ts: threadTs,
      text: `✅ Feature request saved to Notion database!`,
      unfurl_links: false
    });
  } catch (error) {
    let errorMessage = `❌ Failed to save feature request: ${error.message}`;
    await client.chat.postMessage({
      channel: channel,
      thread_ts: threadTs,
      text: errorMessage,
      unfurl_links: false
    });
  }
}

// For serverless function handler
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