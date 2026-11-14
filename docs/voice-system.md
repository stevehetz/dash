# Dash Voice System

## Audio device setup

Each Anker PowerConf S3 must have its own **Aggregate Device** in Audio MIDI Setup with a unique name:
- Office Anker → Aggregate Device named `"PowerConf S3 Office"`
- Kitchen Anker → Aggregate Device named `"PowerConf S3 Kitchen"`

These names must exactly match the `ROOM_DEVICE_NAMES` dict in `voice/listener.py`.

**Why:** macOS exposes both the physical device and the aggregate in the PyAudio device list. Without unique aggregate names, the physical `"PowerConf S3"` device matches multiple rooms and both listeners fire on the same mic.

## Adding a new room/Anker

1. Plug in the Anker
2. Open **Audio MIDI Setup** → click `+` → **Create Aggregate Device**
3. Name it `"PowerConf S3 <Room>"` (e.g. `"PowerConf S3 Kitchen"`)
4. Check the Anker's checkbox in the aggregate
5. Add the room entry to `ROOM_DEVICE_NAMES` in `voice/listener.py`
6. Run `npm run pm2:restart` from the Mac mini's local Terminal (not SSH) to pick up the new device

## Mic permissions after reboot

macOS TCC grants mic access to the app bundle context. pm2 started via SSH does **not** have this context.

**Fix:** After every reboot, run `npm run pm2:boot` from the **Mac mini's local Terminal** (not SSH). This kills and restarts pm2 in the login session, triggering the mic permission grant.

## Double-trigger prevention

A global lock in `listener.py` (`_global_capturing`) prevents two rooms from both responding to the same utterance. If one room starts capturing, all others are blocked until it finishes.

## Architecture overview

- `voice/listener.py` — Wake word detection (Picovoice Porcupine), one `DeviceListener` thread per room, TTS HTTP server on port 3002
- `voice/capture.py` — Records after wake word, transcribes with Whisper medium, POSTs to bot voice endpoint on port 3001
- `bot.js` — Receives voice command, runs Claude agent, summarizes response via Haiku, POSTs spoken text back to TTS server
- TTS: `say -v Fred` generates AIFF → resampled if needed → played via `sounddevice` to the correct room's output device index
- Wake word model: `voice/Hey-Dash_en_mac_v4_0_0.ppn` (Picovoice custom model)
