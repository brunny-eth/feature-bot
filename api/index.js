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
// Initialize clients with better connection handling
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver,
    logLevel: 'debug',
    customClientOptions: {
      retryConfig: {
        retries: 2,
        minTimeout: 100,
        maxTimeout: 3000
      }
    }
});

const notion = new Client({
  auth: process.env.NOTION_API_KEY
});
const databaseId = process.env.NOTION_DATABASE_ID;

console.log('ENV CHECK: SLACK_BOT_TOKEN exists:', !!process.env.SLACK_BOT_TOKEN);
console.log('ENV CHECK: SLACK_BOT_TOKEN prefix:', process.env.SLACK_BOT_TOKEN?.substring(0, 5) + '...');
console.log('ENV CHECK: NOTION_API_KEY exists:', !!process.env.NOTION_API_KEY);
console.log('ENV CHECK: NOTION_DATABASE_ID exists:', !!process.env.NOTION_DATABASE_ID);

// Add test endpoint
receiver.router.get('/test-slack', async (req, res) => {
  try {
    console.log('Testing Slack message send');
    
    const result = await app.client.chat.postMessage({
      channel: 'C08GSKL822E', // Use the channel ID from your logs
      text: 'Test message from FeatureBot'
    });
    
    console.log('Test message sent successfully');
    res.send('Message sent successfully: ' + JSON.stringify(result));
  } catch (error) {
    console.error('Test message failed:', error);
    res.status(500).send('Error: ' + error.message);
  }
});

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

/*
// Listen for bot mentions
app.event('app_mention', async ({ event, context, client, say }) => {
    try {
      console.log('Processing app_mention event, starting response...', event);
      
      const messageText = event.text;
      const threadTs = event.thread_ts || event.ts;
      
      console.log('Parsed message details:', { messageText, threadTs });
      
      // Check if it's an update command
      const updateCommand = parseUpdateCommand(messageText);
      
      if (updateCommand) {
        console.log('Detected update command:', updateCommand);
        // It's an update command
        const { featureQuery, newStatus } = updateCommand;
        
        // Validate the status
        const exactStatusMatch = validStatuses.find(status => 
          status.toLowerCase() === newStatus.toLowerCase()
        );
        
        if (!exactStatusMatch) {
          console.log('Invalid status provided:', newStatus);
          try {
            await client.chat.postMessage({
              channel: event.channel,
              thread_ts: threadTs,
              text: `❌ Invalid status: "${newStatus}". Valid statuses are: ${validStatuses.join(', ')}`,
              unfurl_links: false
            });
            console.log('Successfully sent invalid status message');
          } catch (msgError) {
            console.error('Failed to send invalid status message:', msgError);
          }
          return;
        }
        
        // Find the feature in Notion
        console.log('Searching for feature in Notion:', featureQuery);
        const features = await findFeatureInNotion(featureQuery);
        console.log('Feature search results:', features.length);
        
        if (features.length === 0) {
          try {
            await client.chat.postMessage({
              channel: event.channel,
              thread_ts: threadTs,
              text: `❌ No feature found matching "${featureQuery}"`,
              unfurl_links: false
            });
            console.log('Successfully sent no feature found message');
          } catch (msgError) {
            console.error('Failed to send no feature found message:', msgError);
          }
          return;
        }
        
        if (features.length > 1) {
          // Multiple matches, ask for clarification
          let response = `Found multiple matches for "${featureQuery}". Please be more specific or use the ID:\n\n`;
          response += await formatFeaturesForSlack(features, client);
          
          try {
            await client.chat.postMessage({
              channel: event.channel,
              thread_ts: threadTs,
              text: response,
              unfurl_links: false
            });
            console.log('Successfully sent multiple matches message');
          } catch (msgError) {
            console.error('Failed to send multiple matches message:', msgError);
          }
          return;
        }
        
        // Update the feature status
        const feature = features[0];
        const currentStatus = feature.properties.Status.select?.name || "Unknown";
        
        // Find matching status with proper capitalization
        const matchingStatus = validStatuses.find(
          status => status.toLowerCase() === newStatus.toLowerCase()
        );
        
        console.log('Updating feature status in Notion:', { 
          pageId: feature.id, 
          currentStatus, 
          newStatus: matchingStatus 
        });
        
        await notion.pages.update({
          page_id: feature.id,
          properties: {
            Status: {
              select: { name: matchingStatus }
            }
          }
        });
        
        const title = feature.properties.Title.title[0]?.text.content || "Untitled";
        
        try {
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: `✅ Updated status of "${title}" from "${currentStatus}" to "${matchingStatus}"`,
            unfurl_links: false
          });
          console.log('Successfully sent status update confirmation');
        } catch (msgError) {
          console.error('Failed to send status update confirmation:', msgError);
        }
        return;
      }
      
      // Check if it's a help command
      if (isHelpCommand(messageText)) {
        console.log('Detected help command');
        const helpText = `*FeatureBot Commands:*
    
  - *Create a feature request:* Tag @featurebot in a thread to save the thread as a feature request
  - *Update status:* @featurebot update feature name to status
  - *Check statuses:* @featurebot status (or @featurebot status all to include completed features)
  - *Help:* @featurebot help
  
  *Valid statuses:* ${validStatuses.join(', ')}`;
  
        try {
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: helpText,
            unfurl_links: false
          });
          console.log('Successfully sent help message');
        } catch (msgError) {
          console.error('Failed to send help message:', msgError);
        }
        return;
      }
  
      // Check if it's a status check command
      if (parseStatusCommand(messageText)) {
        console.log('Detected status command');
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
        let loadingMsg;
        try {
          loadingMsg = await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: "Fetching feature statuses...",
            unfurl_links: false
          });
          console.log('Successfully sent loading message');
        } catch (msgError) {
          console.error('Failed to send loading message:', msgError);
          // Continue anyway, we'll try to post the results directly
        }
        
        try {
          // Query the database with or without the filter
          console.log('Querying Notion database with options:', queryOptions);
          const response = await notion.databases.query(queryOptions);
          console.log('Notion query returned', response.results.length, 'results');
          
          const formattedResponse = await formatFeaturesForSlack(response.results, client);
          
          // Add note about completed features
          let finalResponse = formattedResponse;
          if (!showCompleted) {
            finalResponse += "\n_Completed features are hidden. Use '@featurebot status all' to see everything._";
          }
          
          if (loadingMsg) {
            try {
              await client.chat.update({
                channel: event.channel,
                ts: loadingMsg.ts,
                text: finalResponse,
                unfurl_links: false
              });
              console.log('Successfully updated loading message with results');
            } catch (updateError) {
              console.error('Failed to update loading message:', updateError);
              // Try to post a new message instead
              await client.chat.postMessage({
                channel: event.channel,
                thread_ts: threadTs,
                text: finalResponse,
                unfurl_links: false
              });
            }
          } else {
            // If loading message failed, post results directly
            await client.chat.postMessage({
              channel: event.channel,
              thread_ts: threadTs,
              text: finalResponse,
              unfurl_links: false
            });
          }
        } catch (error) {
          console.error("Error querying Notion database:", error);
          
          const errorMessage = "❌ Failed to fetch features: " + error.message;
          
          if (loadingMsg) {
            try {
              await client.chat.update({
                channel: event.channel,
                ts: loadingMsg.ts,
                text: errorMessage,
                unfurl_links: false
              });
            } catch (updateError) {
              console.error('Failed to update loading message with error:', updateError);
              // Try to post a new message
              await client.chat.postMessage({
                channel: event.channel,
                thread_ts: threadTs,
                text: errorMessage,
                unfurl_links: false
              });
            }
          } else {
            // If loading message failed, post error directly
            await client.chat.postMessage({
              channel: event.channel,
              thread_ts: threadTs,
              text: errorMessage,
              unfurl_links: false
            });
          }
        }
        return;
      }
      
      // Original feature request saving functionality
      console.log('Processing as new feature request');
      
      // Get thread info
      console.log('Fetching thread info');
      let replies;
      try {
        replies = await client.conversations.replies({
          channel: event.channel,
          ts: threadTs
        });
        console.log('Successfully fetched thread with', replies.messages.length, 'messages');
      } catch (repliesError) {
        console.error('Failed to fetch thread replies:', repliesError);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: "❌ Failed to read thread: " + repliesError.message,
          unfurl_links: false
        });
        return;
      }
      
      if (!replies || !replies.messages || replies.messages.length === 0) {
        console.error('No thread messages found');
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: "❌ Unable to find thread messages",
          unfurl_links: false
        });
        return;
      }
      
      // Extract all relevant information from thread
      const originalMessage = replies.messages[0];
      const threadMessages = replies.messages.slice(1);
      
      // Get user info for the requester
      console.log('Fetching requester info for user:', originalMessage.user);
      let requesterInfo;
      try {
        requesterInfo = await client.users.info({
          user: originalMessage.user
        });
        console.log('Successfully fetched requester info');
      } catch (userError) {
        console.error('Failed to fetch requester info:', userError);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: "❌ Failed to get user info: " + userError.message,
          unfurl_links: false
        });
        return;
      }
      
      // Get channel info
      console.log('Fetching channel info for:', event.channel);
      let channelInfo;
      try {
        channelInfo = await client.conversations.info({
          channel: event.channel
        });
        console.log('Successfully fetched channel info');
      } catch (channelError) {
        console.error('Failed to fetch channel info:', channelError);
        // Continue anyway, we'll use channel ID if we can't get the name
      }
      
      // Format feature request
      let featureTitle = originalMessage.text.split('\n')[0].substring(0, 80);
      if (!featureTitle.toLowerCase().includes('feature')) {
        featureTitle = "Feature request: " + featureTitle;
      }
      
      console.log('Feature title:', featureTitle);
      
      // Build rich description from entire thread
      let fullDescription = `*Original request by ${requesterInfo.user.real_name}:*\n${originalMessage.text}\n\n`;
      
      if (threadMessages.length > 0) {
        console.log('Processing', threadMessages.length, 'thread messages');
        fullDescription += "*Additional context from thread:*\n";
        
        for (const msg of threadMessages) {
          if (!msg.text.includes('@featurebot')) {
            try {
              const userInfo = await client.users.info({ user: msg.user });
              fullDescription += `- ${userInfo.user.real_name}: ${msg.text}\n`;
            } catch (userError) {
              console.error('Failed to fetch user info for message:', userError);
              fullDescription += `- Unknown User: ${msg.text}\n`;
            }
          }
        }
      }
      
      // Create Notion page with minimal properties
      console.log('Creating Notion page');
      let newPage;
      try {
        newPage = await notion.pages.create({
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
                      content: `Requested in #${channelInfo?.channel?.name || event.channel} on ${new Date(parseInt(threadTs) * 1000).toLocaleString()}`
                    }
                  }
                ]
              }
            }
          ]
        });
        console.log('Successfully created Notion page');
      } catch (notionError) {
        console.error('Failed to create Notion page:', notionError);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: "❌ Failed to save to Notion: " + notionError.message,
          unfurl_links: false
        });
        return;
      }
      
      // Confirm in thread with a simple confirmation message
      console.log('Sending confirmation message');
      try {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: `✅ Feature request saved to Notion database!`,
          unfurl_links: false
        });
        console.log('Successfully sent confirmation message');
      } catch (msgError) {
        console.error('Failed to send confirmation message:', msgError);
      }
      
      console.log('Successfully completed handling app_mention event');
    } catch (error) {
      console.error('Detailed error in app_mention handler:', error);
      // Error handling in thread
      try {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts || event.ts,
          text: "❌ Failed to process request: " + error.message,
          unfurl_links: false
        });
      } catch (msgError) {
        console.error('Failed to send error message:', msgError);
      }
    }
  });
*/

app.event('app_mention', async ({ event, client }) => {
    try {
      console.log('TEST: Received minimal app_mention event');
      
      // Just try to send a simple message
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts || event.ts,
        text: "I received your mention!"
      });
      
      console.log('TEST: Successfully sent message');
    } catch (error) {
      console.error('TEST ERROR:', error);
    }
  });

// Log all received events to help with debugging
app.use((args) => {
  console.log('Received event:', args.payload);
  args.next();
});

// Initialize the app only once
let isAppInitialized = false;

receiver.router.get('/test-endpoint', (req, res) => {
    res.send('FeatureBot is running!');
  });

// For serverless function handler
module.exports = async (req, res) => {
    // Special handling for URL verification (doesn't need app to be started)
    if (req.method === 'POST' && req.body && req.body.type === 'url_verification') {
      return res.json({ challenge: req.body.challenge });
    }
    
    // Just use the receiver's request handler directly
    try {
      await receiver.app.handle(req, res);
    } catch (error) {
      console.error('Error handling request:', error);
      res.status(500).send('Internal Server Error');
    }
  };