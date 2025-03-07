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

// Listen for bot mentions
app.event('app_mention', async ({ event, context, client }) => {
  try {
    console.log('Received app_mention event:', event);
    
    // Get thread info
    const threadTs = event.thread_ts || event.ts;
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
    
    // Confirm in thread with a link to the created item
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: "✅ Feature request saved to Notion database!"
    });
  } catch (error) {
    console.error(error);
    // Error handling in thread
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: "❌ Failed to save feature request: " + error.message
    });
  }
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