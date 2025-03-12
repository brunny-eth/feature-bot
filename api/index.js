// Load environment variables
require('dotenv').config();

const { App, ExpressReceiver } = require('@slack/bolt');
const { Client } = require('@notionhq/client');

// Define a timeout for Notion API requests
const NOTION_TIMEOUT_MS = 5000; // 5 seconds


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


function testNotionConnection() {
    return new Promise(async (resolve, reject) => {
      try {
        console.log("Testing Notion connection...");
        const dbInfo = await notion.databases.retrieve({
          database_id: process.env.NOTION_DATABASE_ID
        });
        console.log("Notion connection successful:", dbInfo.title);
        resolve(dbInfo);
      } catch (error) {
        console.error("Notion connection test failed:", error);
        reject(error);
      }
    });
}

testNotionConnection()
  .then(info => console.log("Database connected successfully"))
  .catch(err => console.log("Could not connect to database"));


// Valid status options for features
const validStatuses = ['New', 'In Progress', 'Pending Review', 'Completed', 'Rejected'];

// Handle help command in app_mention event
function isHelpCommand(text) {
  return text.toLowerCase().includes('help') || 
         text.toLowerCase().includes('commands');
}

// Parse a message for status command
// Format: @featurebot status or @featurebot list features
function parseStatusCommand(text) {
  return text.toLowerCase().includes('status') || 
         text.toLowerCase().includes('list') ||
         text.toLowerCase().includes('features');
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

// Event handler for app_mention
app.event('app_mention', async ({ event, client }) => {
    try {
        console.log('TEST: Received app_mention event');

        const messageText = event.text.toLowerCase();
        const threadTs = event.thread_ts || event.ts;

        if (messageText.includes('help')) {
            console.log('TEST: Detected help command');
            const helpText = `*FeatureBot Commands:*\n
- *Create a feature request:* Tag @featurebot in a thread to save the thread as a feature request
- *Update status:* @featurebot update [feature] to [status]
- *Check statuses:* @featurebot status (or @featurebot status all to include completed features)
- *Help:* @featurebot help
*Valid statuses:* New, In Progress, Pending Review, Completed, Rejected`;

            await client.chat.postMessage({
                channel: event.channel,
                thread_ts: threadTs,
                text: helpText,
                unfurl_links: false
            });
            return;
        }

        // When running the status command, use this code:
        if (messageText.includes('status')) {
            console.log('TEST: Detected status command');

            const showCompleted = messageText.includes('all') || messageText.includes('completed');
            const queryOptions = {
                database_id: process.env.NOTION_DATABASE_ID,
                sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
                page_size: 10
            };

            if (!showCompleted) {
                queryOptions.filter = {
                    property: "Status",
                    select: {
                        does_not_equal: "Completed"
                    }
                };
            }

            const loadingMessage = await client.chat.postMessage({
                channel: event.channel,
                thread_ts: threadTs,
                text: "Fetching feature statuses...",
                unfurl_links: false
            });

            try {
                console.log("TEST: Sending request to Notion with options:", queryOptions);

                // Create a new Notion client with a shorter timeout
                const notionClient = new (require('@notionhq/client')).Client({
                    auth: process.env.NOTION_API_KEY,
                    timeoutMs: NOTION_TIMEOUT_MS
                });
                
                // Use a simple mock response if we're in development or testing
                // (You can remove this in production or keep it as a fallback)
                const mockResponse = {
                    results: [
                        {
                            properties: {
                                Title: { title: [{ text: { content: "Mock Feature 1" } }] },
                                Status: { select: { name: "In Progress" } }
                            }
                        },
                        {
                            properties: {
                                Title: { title: [{ text: { content: "Mock Feature 2" } }] },
                                Status: { select: { name: "New" } }
                            }
                        }
                    ]
                };

                // Run the query with a timeout
                const response = await Promise.race([
                    notionClient.databases.query(queryOptions),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Notion request timed out after 5 seconds')), 
                        NOTION_TIMEOUT_MS + 500)
                    )
                ]);

                console.log("TEST: Notion response received:", response.results.length, "results");

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
                            console.error("Error formatting feature:", err);
                            formattedResponse += `• *Error formatting feature*\n`;
                        }
                    });
                }

                if (!showCompleted) {
                    formattedResponse += "\n_Completed features are hidden. Use '@featurebot status all' to see everything._";
                }

                // Update the loading message with the results
                await client.chat.update({
                    channel: event.channel,
                    ts: loadingMessage.ts,
                    text: formattedResponse,
                    unfurl_links: false
                });

                console.log("TEST: Successfully sent feature statuses");
            } catch (error) {
                console.error("TEST ERROR: Notion query failed:", error);

                // Send a friendly error message
                await client.chat.update({
                    channel: event.channel,
                    ts: loadingMessage.ts,
                    text: "❌ Failed to fetch features: " + error.message,
                    unfurl_links: false
                });
            }
            return;
        }

        // If no specific command is detected, treat it as a feature request creation
        if (!messageText.includes('help') && !messageText.includes('status') && !parseUpdateCommand(messageText)) {
            console.log('Creating new feature request from thread');
            
            try {
                // Get thread info
                console.log('Fetching thread replies');
                const replies = await client.conversations.replies({
                    channel: event.channel,
                    ts: threadTs
                });
                
                console.log(`Fetched ${replies.messages.length} thread messages`);
                
                // Extract all relevant information from thread
                const originalMessage = replies.messages[0];
                const threadMessages = replies.messages.slice(1);
                
                // Get user info for the requester
                console.log('Fetching requester info');
                const requesterInfo = await client.users.info({
                    user: originalMessage.user
                });
                
                // Get channel info
                console.log('Fetching channel info');
                const channelInfo = await client.conversations.info({
                    channel: event.channel
                });
                
                // Format feature request
                let featureTitle = originalMessage.text.split('\n')[0].substring(0, 80);
                if (!featureTitle.toLowerCase().includes('feature')) {
                    featureTitle = "Feature request: " + featureTitle;
                }
                
                console.log(`Feature title: ${featureTitle}`);
                
                // Build rich description from entire thread
                let fullDescription = `*Original request by ${requesterInfo.user.real_name}:*\n${originalMessage.text}\n\n`;
                
                if (threadMessages.length > 0) {
                    console.log('Processing thread messages');
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
                                            content: `Requested in #${channelInfo.channel?.name || event.channel} on ${new Date(parseInt(threadTs) * 1000).toLocaleString()}`
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                });
                
                console.log('Successfully created Notion page');
                
                // Confirm in thread with a simple confirmation message
                await client.chat.postMessage({
                    channel: event.channel,
                    thread_ts: threadTs,
                    text: `✅ Feature request saved to Notion database!`,
                    unfurl_links: false
                });
                
                return;
            } catch (error) {
                console.error('Error creating feature request:', error);
                await client.chat.postMessage({
                    channel: event.channel,
                    thread_ts: threadTs,
                    text: `❌ Failed to save feature request: ${error.message}`,
                    unfurl_links: false
                });
                return;
            }
        }

        // Default response for other commands
        await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: "I received your mention!",
            unfurl_links: false
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