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
// Format: @featurebot update "feature title or keywords" to "new status"
function parseUpdateCommand(text) {
  const updateRegex = /update\s+"?([^"]+)"?\s+to\s+"?([^"]+)"?/i;
  const match = text.match(updateRegex);
  
  if (match) {
    return {
      featureQuery: match[1].trim(),
      newStatus: match[2].trim()
    };
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

// Format Notion pages for Slack display
function formatFeaturesForSlack(pages) {
  if (pages.length === 0) {
    return "No features found.";
  }

  let response = "*Feature Requests Status:*\n\n";
  
  pages.forEach(page => {
    const title = page.properties.Title.title[0]?.text.content || "Untitled";
    const status = page.properties.Status.select?.name || "Unknown";
    const pageId = page.id.replace(/-/g, '');
    
    response += `• *${title}* - ${status} (ID: ${pageId})\n`;
  });
  
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
      if (!validStatuses.some(status => status.toLowerCase() === newStatus.toLowerCase())) {
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
    
    // Check if it's a status check command
    if (parseStatusCommand(messageText)) {
      // It's a status check command
      // Query the first 10 features by default, sorted by last edited time
      const response = await notion.databases.query({
        database_id: databaseId,
        sorts: [
          {
            timestamp: "last_edited_time",
            direction: "descending"
          }
        ],
        page_size: 10
      });
      
      const formattedResponse = formatFeaturesForSlack(response.results);
      
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: formattedResponse
      });
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
    
    // Confirm in thread with a link to the created item and the page ID
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: `✅ Feature request saved to Notion database! (ID: ${newPage.id.replace(/-/g, '')})`
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

// Add help command
app.message(/help|commands/, async ({ message, say }) => {
  if (!message.text.includes('@featurebot')) return;
  
  const helpText = `*FeatureBot Commands:*
  
• *Create a feature request:* Tag @featurebot in a thread to save the thread as a feature request
• *Update status:* @featurebot update "feature name or ID" to "status"
• *Check statuses:* @featurebot status or @featurebot list features
• *Help:* @featurebot help

*Valid statuses:* ${validStatuses.join(', ')}`;

  await say({
    text: helpText,
    thread_ts: message.thread_ts || message.ts
  });
});

// Log all received events to help with debugging
app.use((args) => {
  console.log('Received event:', args.payload);
  args.next();
});

// Start the app
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Feature request bot is running on port ' + (process.env.PORT || 3000));
  console.log('Request URL for Slack events: ' + (process.env.PUBLIC_URL || 'https://your-ngrok-url.ngrok-free.app') + '/slack/events');
})();