# iPhone Voice Setup

## How it works

An iOS Shortcut handles the voice pipeline on iPhone:

1. Tap the Shortcut (home screen icon, widget, or back-tap)
2. iPhone dictates your speech using Apple's built-in speech-to-text
3. The transcribed text is POSTed to the Mac Mini's `/voice/sync` endpoint over Tailscale HTTPS
4. The Mac Mini runs the Claude agent and returns a short spoken response
5. The Shortcut speaks the response through your iPhone speaker or AirPods

Unlike `/voice` (fire-and-forget), `/voice/sync` waits for Claude's response and returns the TTS text directly — so the Shortcut can speak it back immediately.

## What was changed on the Mac Mini

### `bot.js`
- Added `/voice/sync` route alongside the existing `/voice` route
- `/voice/sync` processes the command synchronously and returns the TTS response text as plain text in the HTTP response body
- If you say "send to Telegram" / "message me" / etc., it sends to Telegram and responds "Sent to Telegram."
- Errors return a 500 with a plain text message (and always ping Telegram)
- Voice endpoint listens on `0.0.0.0` (LAN/Tailscale accessible)

### `ecosystem.config.cjs`
- Added `dash-tailscale` pm2 process that runs `tailscale serve http://localhost:3001`
- This keeps Tailscale Serve running as a managed process, exposing the bot over HTTPS at the Mac Mini's Tailscale hostname

## Prerequisites

- Tailscale running on both iPhone and Mac Mini
- Tailscale Serve enabled on your tailnet (login.tailscale.com → DNS → Enable HTTPS Certificates)
- HTTPS certificate provisioned on Mac Mini (one-time setup, see below)

## One-time Mac Mini setup

### 1. Enable HTTPS certificates on your tailnet
Go to [login.tailscale.com](https://login.tailscale.com) → **DNS** → enable **HTTPS Certificates**.

### 2. Provision the certificate
```bash
tailscale cert steves-mac-mini.tail018e6b.ts.net
```

### 3. Start all pm2 processes
```bash
npm run pm2:boot
```

This starts `dash-bot`, `dash-voice`, and `dash-tailscale`. Tailscale Serve will be available at:
```
https://steves-mac-mini.tail018e6b.ts.net
```

### 4. Verify
```bash
pm2 status          # all three should be online
tailscale serve status  # should show HTTPS proxy to localhost:3001
```

## Building the Shortcut

Open the **Shortcuts** app on iPhone and create a new Shortcut with these actions in order:

### 1. Dictate Text
- Action: **Dictate Text**
- Language: English
- Stop Listening: After Pause

### 2. Get Contents of URL
- Action: **Get Contents of URL**
- URL: `https://steves-mac-mini.tail018e6b.ts.net/voice/sync`
- Method: **POST**
- Headers: `Content-Type` = `application/json`
- Request Body: **JSON**
  - Key `text` → value: **Dictated Text** (variable — do NOT type this, select from variable picker)
  - Key `room` → value: `iphone` (plain text)

> **Important:** The Dictated Text variable must only appear in the Request Body `text` field. If it accidentally ends up in the URL field, you'll get an "unsupported URL" error.

### 3. Speak Text
- Action: **Speak Text**
- Input: **Contents of URL** (the variable from step 2)
- Voice: your preference
- Wait until finished: **On**

### Final Shortcut setup
- Name it **Dash**
- Add it to your Home Screen (tap the share icon → Add to Home Screen)
- Optional: set it as a **Back Tap** (Settings → Accessibility → Touch → Back Tap → Double/Triple Tap → Dash)

## Troubleshooting

**"Unsupported URL" error**
- Check that the Dictated Text variable hasn't accidentally been prepended to the URL field — clear the URL field and retype it manually
- Confirm Tailscale is connected on the iPhone

**Certificate error ("certificate for this server is invalid")**
- Run `tailscale cert steves-mac-mini.tail018e6b.ts.net` on the Mac Mini
- Then `pm2 restart dash-tailscale`

**No response / timeout**
- Check `pm2 status` — all three processes should be online
- Check `pm2 logs` for errors
- Confirm Tailscale is connected on both devices

## Tips

- **AirPods**: if AirPods are connected, "Speak Text" routes through them automatically
- **"Send to Telegram"**: say it in your command and the full response goes to Telegram; the Shortcut hears "Sent to Telegram" spoken back
- **Tailscale must be active**: the Shortcut won't work if Tailscale is disconnected on either device
