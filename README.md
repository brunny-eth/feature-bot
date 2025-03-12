# FeatureBot

A Slack bot that captures feature requests from threads and syncs them to Notion. No more lost feature ideas.

## What it does

- Saves Slack threads as structured feature requests in Notion
- Updates feature status directly from Slack
- Lists feature statuses with simple commands
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
NOTION_DATABASE_ID=your_database_id
```

### Quick Deploy

```bash
# Clone the repo
git clone https://github.com/brunny-eth/feature-bot.git
cd feature-bot

# Install dependencies
npm install

# Deploy to Vercel
vercel --prod
```

## Usage

### Commands

```
@featurebot help                         # Show available commands
@featurebot status                       # List active feature requests
@featurebot status all                   # Include completed features
@featurebot update [feature] to [status] # Update feature status
```

### Creating a Feature Request

1. Start a thread in any channel where FeatureBot is present
2. Mention `@featurebot` in the thread
3. The bot will save the entire thread context to Notion
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
