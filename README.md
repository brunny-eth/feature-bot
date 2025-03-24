# HelperBot

A Slack bot that captures feature and business development requests from threads and syncs them to Notion. No more lost ideas.

## What it does

- Saves Slack threads as structured requests in Notion
- Supports two types of requests: feature requests and BD (business development) requests
- Updates request status directly from Slack
- Lists request statuses with simple commands
- Preserves thread context and attribution

## Setup

### Prerequisites

- Slack workspace with admin access
- Notion account with API access
- Vercel account (free tier works fine)

### Environment Variables

```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-signing-secret
NOTION_API_KEY=secret_your_notion_key
NOTION_FEATURE_DATABASE_ID=your_feature_database_id
NOTION_BD_DATABASE_ID=your_bd_database_id
```

### Quick Deploy

```bash
# Clone the repo
git clone https://github.com/your-username/helperbot.git
cd helperbot

# Install dependencies
npm install

# Deploy to Vercel
vercel --prod
```

## Usage

### Commands

```
@helperbot help                         # Show available commands
@helperbot status                       # List active feature requests
@helperbot status bd                    # List active BD requests
@helperbot status all                   # Include completed features
@helperbot status bd all                # Include completed BD requests
@helperbot update [request] to [status] # Update feature status
@helperbot update bd [request] to [status] # Update BD status
```

### Creating Requests

1. Start a thread in any channel where HelperBot is present
2. Mention `@helperbot` in the thread
   - For feature requests: No special keyword needed
   - For BD requests: Include "bd" in your message
3. The bot will save the entire thread context to the appropriate Notion database
4. A confirmation message will be posted

### Valid Statuses

- New
- In Progress
- Pending Review
- Completed
- Rejected

## Development

```bash
# Run locally
npm run dev

# For local testing, use ngrok
ngrok http 3000
```

## License

MIT