#!/usr/bin/env python3
"""
Dash MBP Voice Agent
Runs the Dash voice pipeline on MacBook Pro, routing commands to the Mac Mini.
Wake word detection on the built-in mic (or any named input device).
TTS responses are spoken back locally via macOS `say`.

Usage:
  python mbp_agent.py                    # system default input device
  python mbp_agent.py "MacBook Pro Mic"  # match device by name substring
  python mbp_agent.py --list-devices     # show available input devices

Environment (set in config/.env or shell):
  MAC_MINI_HOST   hostname/IP of the Mac Mini (default: macmini.local)
  MBP_TTS_PORT    local TTS server port (default: 3003)
"""

import os
import sys
import json
import socket
import signal
import subprocess
import threading
import time
from pathlib import Path

# ─── Bootstrap: load .env, then override Dash URLs before capture.py loads ───

_env_file = Path(__file__).parent.parent / "config" / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _, _v = _line.partition("=")
            os.environ.setdefault(_k.strip(), _v.strip())

MAC_MINI_HOST = os.environ.get("MAC_MINI_HOST", "macmini.local")
TTS_PORT = int(os.environ.get("MBP_TTS_PORT", "3003"))

# Must be set before capture.py is imported (it reads these at module level)
os.environ["DASH_VOICE_URL"] = f"http://{MAC_MINI_HOST}:3001/phone-voice"
os.environ["DASH_TTS_URL"]   = f"http://127.0.0.1:{TTS_PORT}/tts"

import numpy as np
import pyaudio
import pvporcupine
from http.server import HTTPServer, BaseHTTPRequestHandler

from capture import capture_and_transcribe, preload_model

# ─── Config ──────────────────────────────────────────────────────────────────

PICOVOICE_ACCESS_KEY = "uotFfd/yfcsJpkOVEoTe2NGhhV7+ADLkGetBSCzxAhMgK+qg3dN3xg=="
WAKE_WORD_MODEL = str(Path(__file__).parent / "Hey-Dash_en_mac_v4_0_0.ppn")
COOLDOWN = 2.0
FORMAT = pyaudio.paInt16
ROOM = "macbook"

# ─── Helpers ─────────────────────────────────────────────────────────────────

def get_local_ip() -> str:
    """Get this machine's LAN IP by briefly connecting outward."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def list_devices(pa: pyaudio.PyAudio):
    print("\nAvailable input devices:")
    for i in range(pa.get_device_count()):
        d = pa.get_device_info_by_index(i)
        if d['maxInputChannels'] > 0:
            print(f"  [{i}] {d['name']}  (rate: {int(d['defaultSampleRate'])}, ch: {int(d['maxInputChannels'])})")
    print()


def resolve_device(pa: pyaudio.PyAudio, name_hint: str = None) -> int:
    """Return input device index. Match by name substring or fall back to default."""
    if name_hint:
        for i in range(pa.get_device_count()):
            d = pa.get_device_info_by_index(i)
            if name_hint.lower() in d['name'].lower() and d['maxInputChannels'] > 0:
                return i
        print(f"[mbp] WARNING: no device matching '{name_hint}', falling back to default input")
    return pa.get_default_input_device_info()['index']


# ─── Local TTS server ─────────────────────────────────────────────────────────
# Receives TTS text from the Mac Mini and speaks it through the MBP's speakers.

class _TTSHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/tts":
            self.send_response(404); self.end_headers(); return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        text = body.get("text", "")
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
        if text:
            threading.Thread(
                target=lambda: subprocess.run(["say", "-v", "Daniel", text]),
                daemon=True,
            ).start()

    def log_message(self, *args):
        pass  # suppress request logs


def start_tts_server():
    server = HTTPServer(("0.0.0.0", TTS_PORT), _TTSHandler)
    print(f"[tts] Local TTS server on port {TTS_PORT}")
    threading.Thread(target=server.serve_forever, daemon=True).start()


# ─── Global capture lock ──────────────────────────────────────────────────────

_global_capturing = False
_global_capture_lock = threading.Lock()


# ─── Wake word listener thread ────────────────────────────────────────────────

class MBPListener(threading.Thread):
    def __init__(self, device_index: int, pa: pyaudio.PyAudio, tts_url: str):
        super().__init__(daemon=True)
        self.device_index = device_index
        self.pa = pa
        self.tts_url = tts_url
        self.last_detection = 0.0
        self.running = True
        self._capturing = False

        self.porcupine = pvporcupine.create(
            access_key=PICOVOICE_ACCESS_KEY,
            keyword_paths=[WAKE_WORD_MODEL],
        )
        self.chunk_size = self.porcupine.frame_length
        self.porcupine_rate = self.porcupine.sample_rate  # 16000

        info = pa.get_device_info_by_index(device_index)
        self.device_rate = int(info['defaultSampleRate'])
        self.device_channels = min(int(info['maxInputChannels']), 2)
        self.device_chunk_size = int(self.device_rate * self.chunk_size / self.porcupine_rate)

    def run(self):
        while self.running:
            if self._capturing:
                time.sleep(0.05)
                continue

            stream = None
            try:
                stream = self.pa.open(
                    rate=self.device_rate,
                    channels=self.device_channels,
                    format=FORMAT,
                    input=True,
                    input_device_index=self.device_index,
                    frames_per_buffer=self.device_chunk_size,
                )
                print(f"[mbp] Listening on device {self.device_index} "
                      f"({self.device_rate}Hz, {self.device_channels}ch)...")

                # Flush stale buffered audio
                for _ in range(10):
                    if not self.running or self._capturing:
                        break
                    stream.read(self.device_chunk_size, exception_on_overflow=False)

                pcm_buffer = np.array([], dtype=np.int16)
                while self.running and not self._capturing:
                    raw = stream.read(self.device_chunk_size, exception_on_overflow=False)
                    audio = np.frombuffer(raw, dtype=np.int16)

                    if self.device_channels == 2:
                        audio = audio.reshape(-1, 2).mean(axis=1).astype(np.int16)
                    if self.device_rate != self.porcupine_rate:
                        from scipy.signal import resample_poly
                        audio = resample_poly(audio, self.porcupine_rate, self.device_rate).astype(np.int16)

                    pcm_buffer = np.concatenate([pcm_buffer, audio])
                    while len(pcm_buffer) >= self.chunk_size:
                        frame = pcm_buffer[:self.chunk_size]
                        pcm_buffer = pcm_buffer[self.chunk_size:]
                        result = self.porcupine.process(frame)
                        if result >= 0:
                            now = time.time()
                            if now - self.last_detection >= COOLDOWN:
                                self.last_detection = now
                                self.on_wake_word()

            except Exception as e:
                if self.running and not self._capturing:
                    print(f"[mbp] Stream error: {e}")
                    time.sleep(1)
            finally:
                if stream:
                    try:
                        stream.stop_stream()
                        stream.close()
                    except Exception:
                        pass

    def on_wake_word(self):
        global _global_capturing
        with _global_capture_lock:
            if _global_capturing:
                print("[mbp] Wake word ignored — already capturing")
                return
            _global_capturing = True

        print("\n[mbp] Wake word detected!")
        self._capturing = True

        def on_done():
            global _global_capturing
            self._capturing = False
            _global_capturing = False

        threading.Thread(
            target=capture_and_transcribe,
            kwargs={
                "pa": self.pa,
                "device_index": self.device_index,
                "native_rate": self.device_rate,
                "native_channels": self.device_channels,
                "room": ROOM,
                "on_done": on_done,
                "tts_url": self.tts_url,
            },
            daemon=True,
        ).start()

    def stop(self):
        self.running = False


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    if "--list-devices" in sys.argv:
        pa = pyaudio.PyAudio()
        list_devices(pa)
        pa.terminate()
        return

    name_hint = next((a for a in sys.argv[1:] if not a.startswith("--")), None)

    mbp_ip = get_local_ip()
    tts_url = f"http://{mbp_ip}:{TTS_PORT}/tts"
    print(f"[mbp] MBP IP: {mbp_ip}")
    print(f"[mbp] TTS callback URL: {tts_url}")
    print(f"[mbp] Routing voice to: {os.environ['DASH_VOICE_URL']}")

    start_tts_server()

    pa = pyaudio.PyAudio()
    device_index = resolve_device(pa, name_hint)
    info = pa.get_device_info_by_index(device_index)
    print(f"[mbp] Input device [{device_index}]: {info['name']}")

    preload_model()

    listener = MBPListener(device_index, pa, tts_url)
    listener.start()

    print(f"\nDash MBP is listening for 'Hey Dash'...")
    print("Press Ctrl+C to stop.\n")

    try:
        while True:
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass

    signal.signal(signal.SIGINT, signal.SIG_IGN)
    listener.stop()
    try:
        pa.terminate()
    except Exception:
        pass


if __name__ == "__main__":
    main()
