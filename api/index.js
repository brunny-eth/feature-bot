// Load environment variables
require('dotenv').config();

const { App, ExpressReceiver } = require('@slack/bolt');
const { Client } = require('@notionhq/client');

// Initialize a custom receiver with explicit challenge handling
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
  endpoints: {
    events: '/slack/events'
  }
});

// Add explicit challenge handling
receiver.router.post('/slack/events', (req, res, next) => {
  if (req.body && req.body.type === 'url_verification') {
    console.log('Received challenge verification request');
    console.log(req.body);
    return res.json({ challenge: req.body.challenge });
  }
  next();
});

receiver.router.get('/test', (req, res) => {
  console.log('Test endpoint hit!');
  return res.send('FeatureBot is running!');
});

// Initialize clients
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

const notion = new Client({
  auth: process.env.NOTION_API_KEY
});
const databaseId = process.env.NOTION_DATABASE_ID;

// Valid status options for features
const validStatuses = ['New', 'In Progress', 'Pending Review', 'Completed', 'Rejected'];

// Helper function to find a feature by title or ID
async function findFeatureInNotion(searchText) {
  // Try searching by title
  const titleResponse = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: 'Title',
      rich_text: {
        contains: searchText
      }
    },
    page_size: 5
  });

  // If we found results, return them
  if (titleResponse.results.length > 0) {
    return titleResponse.results;
  }

  // Otherwise, try checking if searchText is a page ID
  if (searchText.match(/^[a-f0-9]{32}$/)) {
    try {
      const page = await notion.pages.retrieve({
        page_id: searchText
      });
      return [page];
    } catch (error) {
      // Not a valid page ID or no access
      return [];
    }
  }

  return [];
}

// Parse a message for update command pattern
// Format: @featurebot update feature title to new status
function parseUpdateCommand(text) {
  // First check if the text contains "update" and "to"
  if (text.toLowerCase().includes('update') && text.toLowerCase().includes(' to ')) {
    // Extract everything between "update" and "to"
    const parts = text.split(/update\s+/i)[1].split(/\s+to\s+/i);
    
    if (parts.length >= 2) {
      return {
        featureQuery: parts[0].trim(),
        newStatus: parts[1].trim().replace(/"/g, '') // Remove any quotes
      };
    }
  }
  return null;
}

// Parse a message for status command
// Format: @featurebot status or @featurebot list features
function parseStatusCommand(text) {
  return text.toLowerCase().includes('status') || 
         text.toLowerCase().includes('list') ||
         text.toLowerCase().includes('features');
}

// Handle help command in app_mention event
function isHelpCommand(text) {
  return text.toLowerCase().includes('help') || 
         text.toLowerCase().includes('commands');
}

// Format Notion pages for Slack display
async function formatFeaturesForSlack(pages, client) {
  if (pages.length === 0) {
    return "No features found.";
  }

  let response = "*Feature Requests Status:*\n\n";
  
  for (const page of pages) {
    const title = page.properties.Title.title[0]?.text.content || "Untitled";
    const status = page.properties.Status.select?.name || "Unknown";
    
    // Get creator information if available in the page content
    let creator = "Unknown";
    try {
      const { results } = await notion.blocks.children.list({
        block_id: page.id,
      });
      
      // Look for the original request block which contains creator info
      for (const block of results) {
        if (block.type === 'paragraph') {
          const text = block.paragraph.rich_text[0]?.text.content || "";
          if (text.includes("Original request by")) {
            const creatorMatch = text.match(/Original request by ([^:]+):/);
            if (creatorMatch && creatorMatch[1]) {
              creator = creatorMatch[1].trim();
            }
            break;
          }
        }
      }
    } catch (error) {
      console.error("Error fetching creator info:", error);
    }
    
    response += `• *${title}* - ${status} - ${creator}\n`;
  }
  
  return response;
}

// Listen for bot mentions
app.event('app_mention', async ({ event, context, client, say }) => {
  try {
    console.log('Received app_mention event:', event);
    
    const messageText = event.text;
    const threadTs = event.thread_ts || event.ts;
    
    // Check if it's an update command
    const updateCommand = parseUpdateCommand(messageText);
    
    if (updateCommand) {
      // It's an update command
      const { featureQuery, newStatus } = updateCommand;
      
      // Validate the status
      const exactStatusMatch = validStatuses.find(status => 
        status.toLowerCase() === newStatus.toLowerCase()
      );
      
      if (!exactStatusMatch) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: `❌ Invalid status: "${newStatus}". Valid statuses are: ${validStatuses.join(', ')}`
        });
        return;
      }
      
      // Find the feature in Notion
      const features = await findFeatureInNotion(featureQuery);
      
      if (features.length === 0) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: `❌ No feature found matching "${featureQuery}"`
        });
        return;
      }
      
      if (features.length > 1) {
        // Multiple matches, ask for clarification
        let response = `Found multiple matches for "${featureQuery}". Please be more specific or use the ID:\n\n`;
        response += formatFeaturesForSlack(features);
        
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: response
        });
        return;
      }
      
      // Update the feature status
      const feature = features[0];
      const currentStatus = feature.properties.Status.select?.name || "Unknown";
      
      // Find matching status with proper capitalization
      const matchingStatus = validStatuses.find(
        status => status.toLowerCase() === newStatus.toLowerCase()
      );
      
      await notion.pages.update({
        page_id: feature.id,
        properties: {
          Status: {
            select: { name: matchingStatus }
          }
        }
      });
      
      const title = feature.properties.Title.title[0]?.text.content || "Untitled";
      
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `✅ Updated status of "${title}" from "${currentStatus}" to "${matchingStatus}"`
      });
      return;
    }
    
    // Check if it's a help command
    if (isHelpCommand(messageText)) {
      const helpText = `*FeatureBot Commands:*
  
- *Create a feature request:* Tag @featurebot in a thread to save the thread as a feature request
- *Update status:* @featurebot update feature name to status
- *Check statuses:* @featurebot status (or @featurebot status all to include completed features)
- *Help:* @featurebot help

*Valid statuses:* ${validStatuses.join(', ')}`;

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: helpText
      });
      return;
    }

    // Check if it's a status check command
    if (parseStatusCommand(messageText)) {
      // It's a status check command
      // By default, filter out completed features unless specifically requested
      const showCompleted = messageText.toLowerCase().includes('all') || 
                           messageText.toLowerCase().includes('completed');
      
      // Create query options
      const queryOptions = {
        database_id: databaseId,
        sorts: [
          {
            timestamp: "last_edited_time",
            direction: "descending"
          }
        ],
        page_size: 10
      };
      
      // Only add filter if we're hiding completed items
      if (!showCompleted) {
        queryOptions.filter = {
          property: "Status",
          select: {
            does_not_equal: "Completed"
          }
        };
      }
      
      // Send a "working on it" message
      const loadingMsg = await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: "Fetching feature statuses..."
      });
      
      try {
        // Query the database with or without the filter
        const response = await notion.databases.query(queryOptions);
        
        const formattedResponse = await formatFeaturesForSlack(response.results, client);
        
        // Add note about completed features
        let finalResponse = formattedResponse;
        if (!showCompleted) {
          finalResponse += "\n_Completed features are hidden. Use '@featurebot status all' to see everything._";
        }
        
        await client.chat.update({
          channel: event.channel,
          ts: loadingMsg.ts,
          text: finalResponse
        });
      } catch (error) {
        console.error("Error querying Notion database:", error);
        await client.chat.update({
          channel: event.channel,
          ts: loadingMsg.ts,
          text: "❌ Failed to fetch features: " + error.message
        });
      }
      return;
    }
    
    // Original feature request saving functionality
    // Get thread info
    const replies = await client.conversations.replies({
      channel: event.channel,
      ts: threadTs
    });
    
    // Extract all relevant information from thread
    const originalMessage = replies.messages[0];
    const threadMessages = replies.messages.slice(1);
    
    // Get user info for the requester
    const requesterInfo = await client.users.info({
      user: originalMessage.user
    });
    
    // Get channel info
    const channelInfo = await client.conversations.info({
      channel: event.channel
    });
    
    // Format feature request
    let featureTitle = originalMessage.text.split('\n')[0].substring(0, 80);
    if (!featureTitle.toLowerCase().includes('feature')) {
      featureTitle = "Feature request: " + featureTitle;
    }
    
    // Build rich description from entire thread
    let fullDescription = `*Original request by ${requesterInfo.user.real_name}:*\n${originalMessage.text}\n\n`;
    
    if (threadMessages.length > 0) {
      fullDescription += "*Additional context from thread:*\n";
      for (const msg of threadMessages) {
        if (!msg.text.includes('@featurebot')) {
          const userInfo = await client.users.info({ user: msg.user });
          fullDescription += `- ${userInfo.user.real_name}: ${msg.text}\n`;
        }
      }
    }
    
    // Create Notion page with minimal properties
    const newPage = await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        Title: {
          title: [{ text: { content: featureTitle } }]
        },
        Status: {
          select: { name: "New" }
        },
        "Slack URL": {
          url: `https://slack.com/archives/${event.channel}/p${threadTs.replace('.', '')}`
        }
      },
      // Put all the rich content in the page content instead of properties
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
                  content: `Requested in #${channelInfo.channel.name} on ${new Date(parseInt(threadTs) * 1000).toLocaleString()}`
                }
              }
            ]
          }
        }
      ]
    });
    
    // Confirm in thread with a simple confirmation message
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `✅ Feature request saved to Notion database!`
    });
  } catch (error) {
    console.error(error);
    // Error handling in thread
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: "❌ Failed to process request: " + error.message
    });
  }
});

// Log all received events to help with debugging
app.use((args) => {
  console.log('Received event:', args.payload);
  args.next();
});

// Initialize the app only once
let isAppInitialized = false;

// For serverless function handler
module.exports = async (req, res) => {
  try {
    // Special handling for URL verification (doesn't need app to be started)
    if (req.method === 'POST' && req.body && req.body.type === 'url_verification') {
      return res.json({ challenge: req.body.challenge });
    }
    
    // Start the app only once, not on every request
    if (!isAppInitialized) {
      await app.start();
      isAppInitialized = true;
      console.log('⚡️ Bolt app is running!');
    }
    
    // Process the event
    await receiver.app.handle(req, res);
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).send('Internal Server Error');
  }
};