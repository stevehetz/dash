# MBP Voice Agent Setup

## What this is

Steve uses two Anker PowerConf S3 speakers (office + kitchen) connected to a Mac Mini to talk to Dash — his personal Claude-powered assistant. The Mac Mini runs wake word detection, captures audio, transcribes with Whisper, sends commands to the Claude agent, and speaks responses back through the Ankers.

This setup extends that system so the MacBook Pro can also act as a voice room. Say "Hey Dash" on the MBP (built-in mic or AirPods), and it routes the command to the Mac Mini's Claude agent. Responses are spoken back through the MBP's own speakers/AirPods. Everything else (Dropbox file writes, transcription mode, Telegram forwarding) works identically.

---

## Architecture overview

```
MBP (mbp_agent.py)                        Mac Mini (bot.js + listener.py)
─────────────────                          ────────────────────────────────
Wake word (Porcupine)                      Claude agent (port 3001)
  → capture audio                    ←──  ← voice POST { text, room, tts_url }
  → Whisper transcription            ──→  → run Claude → get response text
  → POST to macmini.local:3001            → _speak(text, room, tts_url)
                                          → POST to MBP's tts_url
Local TTS server (port 3003)        ←──
  → say -v Daniel "..."
  → MBP speakers / AirPods
```

Transcription mode (`"Hey Dash, start transcription"`) works too — audio is captured and transcribed in segments directly to a Dropbox markdown file on the MBP (since Dropbox is mounted locally), and the summary request is routed back through the Mac Mini's Claude agent.

---

## What was changed on the Mac Mini

These changes are already committed to the repo. After pulling on the MBP, you'll have them locally too.

### `voice/capture.py`
- `DASH_VOICE_URL` and `DASH_TTS_URL` are now read from environment variables (with the same localhost defaults), so `mbp_agent.py` can override them before import.
- `tts_url` parameter added to `send_to_dash()`, `capture_and_transcribe()`, `run_transcription()`, and `_request_summary()` — threads the MBP's TTS callback URL through the whole pipeline so the Mac Mini knows where to speak responses.

### `bot.js`
- Voice HTTP endpoint now listens on `0.0.0.0` instead of `127.0.0.1` — makes it reachable from the MBP over the local network.
- `_speak(text, room, ttsUrl)` — if a `tts_url` was included in the voice POST, it sends TTS there instead of to the local Anker TTS server. This is how responses get routed back to MBP speakers rather than playing through an Anker.

### `voice/mbp_agent.py` (new file)
The MBP-side agent. Mirrors the structure of `listener.py` but:
- Uses the MBP's system default input device (or a named device passed as an argument)
- Runs a local TTS HTTP server on port 3003 that receives response text from the Mac Mini and runs `say -v Daniel`
- Discovers the MBP's LAN IP at startup and passes it as `tts_url` in every voice POST
- Sets `DASH_VOICE_URL=http://macmini.local:3001/voice` and `DASH_TTS_URL=http://127.0.0.1:3003/tts` before importing `capture.py`

---

## What still needs to be done on the MBP

### 1. Pull the latest changes

```bash
cd ~/dev/dash
git pull
```

### 2. Install Python dependencies

The Mac Mini already has these. The MBP needs them too:

```bash
pip install openai-whisper pvporcupine pyaudio sounddevice soundfile scipy requests numpy
```

`pyaudio` sometimes needs PortAudio first:
```bash
brew install portaudio
pip install pyaudio
```

### 3. Restart Dash on the Mac Mini

The `0.0.0.0` binding change requires a restart. Do this from the Mac Mini's local Terminal (not SSH, because of mic permission requirements):

```bash
pm2 restart dash-bot
```

### 4. Run the MBP agent

From the dash repo on the MBP:

```bash
cd ~/dev/dash
python voice/mbp_agent.py
```

To use AirPods when connected:
```bash
python voice/mbp_agent.py "AirPods"
```

To see available input devices:
```bash
python voice/mbp_agent.py --list-devices
```

---

## Environment variables

These can be set in `config/.env` or your shell. Defaults shown:

| Variable | Default | Description |
|---|---|---|
| `MAC_MINI_HOST` | `macmini.local` | Hostname or IP of the Mac Mini |
| `MBP_TTS_PORT` | `3003` | Local TTS server port on MBP |
| `DASH_HTTP_TOKEN` | — | **Required.** Must match the Mac Mini's value; sent as `X-Dash-Token`. Requests from the LAN without it get a 401. |

---

## Troubleshooting

**401 Unauthorized when POSTing to Mac Mini**
- `DASH_HTTP_TOKEN` is missing or differs between the MBP and the Mac Mini `config/.env`

**"Connection refused" when POSTing to Mac Mini**
- Confirm `pm2 restart dash-bot` was run after the `0.0.0.0` change
- Check `pm2 logs` on the Mac Mini for errors
- Try `curl http://macmini.local:3001/voice` from the MBP to verify reachability

**Wake word not triggering**
- Run `python voice/mbp_agent.py --list-devices` to confirm the right mic is listed
- Make sure macOS has granted Terminal (or whatever app you're running from) microphone access: System Settings → Privacy & Security → Microphone

**No TTS response**
- Check that port 3003 is not blocked by macOS firewall
- Confirm the MBP's LAN IP printed at startup is correct (not 127.0.0.1)
- Check Mac Mini `pm2 logs` to see if the TTS POST to the MBP is erroring

**AirPods: mic switches mid-session**
- macOS sometimes reassigns the default input device when AirPods connect. Pass the device name explicitly: `python voice/mbp_agent.py "AirPods"` so the agent locks to it at startup.

**Transcription not writing to Dropbox**
- `DROPBOX_PATH` must be set in `config/.env` on the MBP. It should point to the local Dropbox folder, e.g. `/Users/stevemini/Library/CloudStorage/Dropbox/steve`
