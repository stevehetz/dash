#!/usr/bin/env python3
"""
Dash Wake Word Listener
Listens on all configured USB microphones simultaneously.
Detects wake word and triggers the voice pipeline.
"""

import pyaudio
import numpy as np
import pvporcupine
import subprocess
import tempfile
import sounddevice as sd
import soundfile as sf
import threading
import time
import sys
import os
import signal
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from capture import capture_and_transcribe, preload_model

# ─── Config ──────────────────────────────────────────────────────────────────

PICOVOICE_ACCESS_KEY = "uotFfd/yfcsJpkOVEoTe2NGhhV7+ADLkGetBSCzxAhMgK+qg3dN3xg=="
WAKE_WORD_MODEL = str(Path(__file__).parent / "Hey-Dash_en_mac_v4_0_0.ppn")
COOLDOWN = 2.0
FORMAT = pyaudio.paInt16
TTS_PORT = 3002

# Maps room name → device name substring (matched at startup)
ROOM_DEVICE_NAMES = {
    "kitchen": "PowerConf S3 Kitchen",
    "office":  "PowerConf S3 Office",
}

# Per-room TTS output volume (0.0 = silent, 1.0 = full, >1.0 = boost)
ROOM_VOLUME = {
    "kitchen": 1.0,
    "office":  0.5,
}

# Resolved at startup: room → input device index, room → output device index
ROOM_MAP = {}        # room → input device index
TTS_OUTPUT_MAP = {}  # room → output device index


def resolve_device_indices(pa: pyaudio.PyAudio):
    """Resolve room → device index mappings by matching device names."""
    for room, name in ROOM_DEVICE_NAMES.items():
        input_idx = output_idx = None
        for i in range(pa.get_device_count()):
            d = pa.get_device_info_by_index(i)
            if name.lower() in d['name'].lower():
                if d['maxInputChannels'] > 0 and input_idx is None:
                    input_idx = i
                if d['maxOutputChannels'] > 0 and output_idx is None:
                    output_idx = i
        if input_idx is not None:
            ROOM_MAP[input_idx] = room
            print(f"[audio] {room} input  → device {input_idx} ({pa.get_device_info_by_index(input_idx)['name']})")
        if output_idx is not None:
            TTS_OUTPUT_MAP[room] = output_idx
            print(f"[audio] {room} output → device {output_idx} ({pa.get_device_info_by_index(output_idx)['name']})")

# ─── Helpers ─────────────────────────────────────────────────────────────────

def _suppress_stderr():
    """Context manager to suppress C-level stderr (PortAudio noise)."""
    from contextlib import contextmanager
    @contextmanager
    def ctx():
        devnull = os.open(os.devnull, os.O_WRONLY)
        old_stderr = os.dup(2)
        os.dup2(devnull, 2)
        try:
            yield
        finally:
            os.dup2(old_stderr, 2)
            os.close(devnull)
            os.close(old_stderr)
    return ctx()

def set_input_volume(level: int = 85):
    import subprocess
    subprocess.run(["osascript", "-e", f"set volume input volume {level}"], check=False)

def list_devices():
    import sounddevice as sd
    print("\nAvailable input devices:")
    for i, d in enumerate(sd.query_devices()):
        if d['max_input_channels'] > 0:
            print(f"  [{i}] {d['name']} (channels: {d['max_input_channels']})")
    print()

# ─── Global capture lock ─────────────────────────────────────────────────────
# Prevents multiple rooms from responding to the same utterance simultaneously.

_global_capturing = False
_global_capture_lock = threading.Lock()

# ─── Per-device listener thread ──────────────────────────────────────────────

class DeviceListener(threading.Thread):
    MAX_CONSECUTIVE_ERRORS = 3

    def __init__(self, device_index: int, room: str, pa: pyaudio.PyAudio):
        super().__init__(daemon=True)
        self.device_index = device_index
        self.room = room
        self.pa = pa
        self.last_detection = 0.0
        self.running = True
        self.failed = False  # True when device is gone (too many errors)
        self._capturing = False  # True while capture thread holds the mic
        self.last_read = time.time()  # watchdog: last successful stream.read()
        self._stream = None  # current stream, for external force-close

        self.porcupine = pvporcupine.create(
            access_key=PICOVOICE_ACCESS_KEY,
            keyword_paths=[WAKE_WORD_MODEL],
        )
        self.chunk_size = self.porcupine.frame_length

        info = pa.get_device_info_by_index(device_index)
        self.device_rate = int(info['defaultSampleRate'])
        self.device_channels = min(int(info['maxInputChannels']), 2)
        self.porcupine_rate = self.porcupine.sample_rate  # 16000
        self.device_chunk_size = int(self.device_rate * self.chunk_size / self.porcupine_rate)

        # capture_and_transcribe needs the actual device rate/channels
        self.native_rate = self.device_rate
        self.native_channels = self.device_channels

    def run(self):
        consecutive_errors = 0
        while self.running:
            if self._capturing:
                time.sleep(0.05)
                continue

            stream = None
            try:
                self._stream = None
                with _suppress_stderr():
                    stream = self.pa.open(
                        rate=self.device_rate,
                        channels=self.device_channels,
                        format=FORMAT,
                        input=True,
                        input_device_index=self.device_index,
                        frames_per_buffer=self.device_chunk_size,
                    )
                self._stream = stream
                print(f"[{self.room}] Listening on device {self.device_index} "
                      f"({self.device_rate}Hz, {self.device_channels}ch)...")
                consecutive_errors = 0

                # Flush stale buffered audio before listening
                for _ in range(10):
                    if not self.running or self._capturing:
                        break
                    stream.read(self.device_chunk_size, exception_on_overflow=False)

                pcm_buffer = np.array([], dtype=np.int16)
                self.last_read = time.time()
                while self.running and not self._capturing:
                    raw = stream.read(self.device_chunk_size, exception_on_overflow=False)
                    self.last_read = time.time()
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
                                self.on_wake_word(self.room)

            except Exception as e:
                if self.running and not self._capturing:
                    consecutive_errors += 1
                    if consecutive_errors >= self.MAX_CONSECUTIVE_ERRORS:
                        print(f"[{self.room}] Device disconnected after {consecutive_errors} errors")
                        self.failed = True
                        return
                    time.sleep(2)
            finally:
                if stream:
                    try:
                        stream.stop_stream()
                        stream.close()
                    except Exception:
                        pass

    def on_wake_word(self, room: str):
        global _global_capturing
        with _global_capture_lock:
            if _global_capturing:
                print(f"[{room}] Wake word ignored — another room is already capturing")
                return
            _global_capturing = True

        print(f"\n[{room}] Wake word detected!")
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
                "native_rate": self.native_rate,
                "native_channels": self.native_channels,
                "room": room,
                "on_done": on_done,
            },
            daemon=True,
        ).start()

    def force_close_stream(self):
        """Close the stream from outside to unblock a stuck read()."""
        s = self._stream
        if s:
            try:
                s.close()
            except Exception:
                pass

    def stop(self):
        self.running = False

# ─── TTS HTTP server ─────────────────────────────────────────────────────────

def _speak_on_device(text: str, device_index: int):
    """Generate speech with macOS say and play through a specific output device."""
    with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as f:
        tmp = f.name
    try:
        subprocess.run(["say", "-v", "Daniel", "-o", tmp, text], check=True)
        data, rate = sf.read(tmp)
        device_info = sd.query_devices(device_index)
        target_rate = int(device_info['default_samplerate'])
        print(f"[tts] Speaking on device {device_index} ({device_info['name']}): {text!r}")
        if rate != target_rate:
            from scipy.signal import resample_poly
            data = resample_poly(data, target_rate, rate).astype(data.dtype)
        room = next((r for r, idx in TTS_OUTPUT_MAP.items() if idx == device_index), None)
        volume = ROOM_VOLUME.get(room, 1.0)
        sd.play(data * volume, samplerate=target_rate, device=device_index)
        sd.wait()
    except Exception as e:
        print(f"[tts] Error: {e}")
    finally:
        Path(tmp).unlink(missing_ok=True)


class TTSHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/tts":
            self.send_response(404); self.end_headers(); return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        text = body.get("text", "")
        room = body.get("room", "")
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
        device_index = TTS_OUTPUT_MAP.get(room)
        if text and device_index is not None:
            threading.Thread(target=_speak_on_device, args=(text, device_index), daemon=True).start()

    def log_message(self, *args):
        pass  # suppress request logs


def start_tts_server():
    server = HTTPServer(("127.0.0.1", TTS_PORT), TTSHandler)
    print(f"[tts] TTS endpoint listening on localhost:{TTS_PORT}")
    threading.Thread(target=server.serve_forever, daemon=True).start()


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    if "--list-devices" in sys.argv:
        list_devices()
        return

    pa = pyaudio.PyAudio()
    resolve_device_indices(pa)

    # Ensure audio is unmuted (individual room TTS handles its own output device)
    subprocess.run(["osascript", "-e", "set volume output muted false"], check=False)
    start_tts_server()
    preload_model()

    if not ROOM_MAP:
        print("No input devices found — will retry every 10s when devices are plugged in.")

    listeners = []

    def start_listeners():
        for idx, room in ROOM_MAP.items():
            if not any(l.device_index == idx for l in listeners):
                l = DeviceListener(idx, room, pa)
                l.start()
                listeners.append(l)

    start_listeners()

    if listeners:
        set_input_volume(85)
        print("Dash is listening for 'Hey Dash'...")
    print("Press Ctrl+C to stop.\n")

    try:
        while True:
            time.sleep(10)
            # Remove failed or stuck listeners (device was unplugged or stream hung)
            now = time.time()
            failed = [l for l in listeners if l.failed]
            stuck = [l for l in listeners if not l.failed and not l._capturing
                     and now - l.last_read > 30]
            for l in stuck:
                print(f"[{l.room}] Stream stuck for {now - l.last_read:.0f}s — forcing restart")
                l.running = False
                l.force_close_stream()
                l.failed = True
            failed.extend(stuck)
            for l in failed:
                listeners.remove(l)

            if not listeners:
                # No active listeners — re-enumerate to find newly plugged devices
                pa.terminate()
                with _suppress_stderr():
                    pa = pyaudio.PyAudio()
                ROOM_MAP.clear()
                TTS_OUTPUT_MAP.clear()
                resolve_device_indices(pa)
                if ROOM_MAP:
                    # Bluetooth devices report stale sample rates right after
                    # reconnecting. Wait a moment for CoreAudio to stabilize,
                    # then re-enumerate to get the correct rates.
                    print("[audio] Device found — waiting 5s for Bluetooth to stabilize...")
                    time.sleep(5)
                    pa.terminate()
                    with _suppress_stderr():
                        pa = pyaudio.PyAudio()
                    ROOM_MAP.clear()
                    TTS_OUTPUT_MAP.clear()
                    resolve_device_indices(pa)
                start_listeners()
                if listeners:
                    set_input_volume(85)
    except KeyboardInterrupt:
        pass

    signal.signal(signal.SIGINT, signal.SIG_IGN)
    for l in listeners:
        l.stop()
    try:
        pa.terminate()
    except Exception:
        pass

if __name__ == "__main__":
    main()
