# Steve's Assistant

A personal Telegram bot powered by Claude that manages Dropbox files, Google Drive/Docs/Sheets/Calendar/Tasks, Apple Notes, and web browsing — all from Telegram or your Apple Watch via Siri.

## How it works

```
You (Telegram / Apple Watch via Siri → Apple Notes)
  → This Node.js app (runs on your Mac via pm2)
    → Claude API (interprets your request, calls tools)
      → Dropbox, Google APIs, Apple Notes, Web
```

## Setup (10 minutes)

### 1. Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts (name it whatever you want)
3. Copy the **bot token** it gives you

### 2. Get your Telegram User ID

1. Search for **@userinfobot** on Telegram
2. Send it `/start`
3. Copy your **numeric user ID** (this locks the bot to only respond to you)

### 3. Get an Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an account and add a payment method
3. Generate an API key

### 4. Configure the bot

```bash
cd dash
cp config/.env.example config/.env
```

Edit `config/.env` with your values:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
TELEGRAM_BOT_TOKEN=your-bot-token-here
ALLOWED_USER_ID=your-numeric-id
DROPBOX_PATH=/Users/yourname/Dropbox
CODEX_MODEL=<optional-codex-model-id>
```

### 5. Install and run

```bash
npm install
pm2 start index.js --name steves-assistant
pm2 save
```

That's it. Open Telegram, find your bot, and start chatting.

## Capabilities

| Feature | Examples |
|---|---|
| **Dropbox files** | "Create a todo list", "Read my grocery list", "Add salmon to the food log" |
| **Google Drive/Docs/Sheets** | "Create a spreadsheet with banana nutrition facts", "Make a Google Doc" |
| **Google Calendar** | "What's on my calendar today?", "Create an event for Friday at 3pm" |
| **Google Tasks** | "Show my tasks", "Add a task to pick up groceries" |
| **Apple Notes** | "Check my apple notes", "Read my apple note about the trip" |
| **Web browsing** | "Search for V60 brew ratios", "What's the weather in Macedonia?" |
| **Apple Watch (via Siri)** | Dictate an Apple Note → auto-processed and sent to Telegram |

## Commands

- `/start` — Show help
- `/clear` — Reset conversation history
- `/folders` — Show your Dropbox folder structure
- `/haiku` — Switch to Haiku
- `/sonnet` — Switch to Sonnet (default)
- `/opus` — Switch to Opus

## Google Integration (optional)

Adds Google Drive, Docs, Sheets, Calendar, and Tasks access to the bot. Uses OAuth2 so the bot acts as your Google account directly.

### 1. Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click **Select a project** > **New Project**, name it (e.g., `steves-assistant`), and create it

### 2. Enable APIs

Go to **APIs & Services > Library** and enable all five:

- Google Drive API
- Google Docs API
- Google Sheets API
- Google Calendar API
- Google Tasks API

### 3. Set up OAuth consent screen

1. Go to **Google Auth Platform > Branding** and fill in the app name and your email
2. Go to **Google Auth Platform > Audience** and add your Gmail address as a test user

### 4. Create OAuth credentials

1. Go to **Google Auth Platform > Clients**
2. Click **Create OAuth client**
3. Application type: **Desktop app**
4. Name it (e.g., `steves-assistant`)
5. Click **Create**
6. Download the JSON and save it as `google-credentials.json` in this project's root directory (already gitignored)

### 5. Configure environment variables

Add to your `.env`:

```
GOOGLE_CREDENTIALS_PATH=./google-credentials.json
GOOGLE_DRIVE_ROOT_FOLDER_ID=your-folder-id-here
```

To get the folder ID, open the folder in Google Drive — the URL looks like `https://drive.google.com/drive/folders/FOLDER_ID_HERE`.

### 6. Authorize on first run

Start the bot with `node index.js`. It will print a URL — open it in your browser, sign in with your Google account, and approve access. The token is saved to `google-token.json` and refreshes automatically. You only need to do this once.

### What you get

| Service | Tools |
|---------|-------|
| Drive | List files, search, get file info, create folders |
| Docs | Read, create, append to documents |
| Sheets | Read, create, append rows to spreadsheets |
| Calendar | List/search events, create events, delete events |
| Tasks | List task lists, list/create/complete/delete tasks |

## Managing with pm2

The bot runs as a background service via pm2 and auto-starts on boot.

| Command | What it does |
|---|---|
| `pm2 logs` | Tail logs in real-time |
| `pm2 logs --lines 100` | Show last 100 log lines |
| `pm2 restart steves-assistant` | Restart the bot |
| `pm2 stop steves-assistant` | Stop the bot |
| `pm2 start steves-assistant` | Start the bot |
| `pm2 status` | Quick health check |
| `pm2 monit` | Full dashboard (CPU/memory/logs) |

### First-time setup

```bash
npm install -g pm2
pm2 start index.js --name steves-assistant
pm2 startup   # prints a sudo command — run it to enable boot persistence
pm2 save      # saves the process list so it survives reboots
```

### Auto-start on boot

`pm2 startup` installs a macOS launchd service at `~/Library/LaunchAgents/pm2.stevehetz.plist` that launches pm2 when you log in. `pm2 save` snapshots your running processes so pm2 knows to restart `steves-assistant` automatically. If you ever need to redo this:

```bash
pm2 unstartup    # remove the old launchd service
pm2 startup      # run the printed sudo command
pm2 save         # re-save the process list
```

### After code changes

```bash
pm2 restart steves-assistant
```

## Apple Watch Integration

The bot polls Apple Notes every 10 seconds. Create a note (via Siri: "Create an Apple Note that says...") and the bot will:
1. Read the note content
2. Process it as a prompt (create calendar events, save files, etc.)
3. Send the result to your Telegram chat
4. Delete the note

## Security Notes

- The bot **only responds to your Telegram user ID** — all other messages are silently ignored.
- File access is **sandboxed to your Dropbox folder** — Claude cannot read or write anywhere else on your system.
- Conversation history is kept in memory (last 20 messages) and resets when the process restarts.
- Secrets live in `config/.env` (gitignored) and never leave your machine.
- The HTTP server (port 3001) trusts loopback only; any other caller must send `X-Dash-Token` matching `DASH_HTTP_TOKEN`.

## Customization

- **System prompt**: Edit `BASE_SYSTEM_PROMPT` in `agent.js`
- **File shortcuts and conventions**: Edit `AGENTS.MD` in your Dropbox
- **Codex model**: Optionally set `CODEX_MODEL` in `config/.env`; otherwise Codex uses its configured default
