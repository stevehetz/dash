#!/usr/bin/env python3
"""
Record training samples for "Hey Dash" wake word model.
Run with: python3 record_samples.py positive   (say "Hey Dash" each time)
       or: python3 record_samples.py negative   (say anything EXCEPT "Hey Dash")
"""

import pyaudio
import numpy as np
import soundfile as sf
from pathlib import Path
from scipy.signal import resample_poly
import time
import sys

DEVICE_INDEX = 3
NATIVE_RATE = 48000
TARGET_RATE = 16000
CHANNELS = 2
CHUNK = 1024
RECORD_SECONDS = 2.0

POSITIVE_DIR = Path(__file__).parent / "training_data" / "positive"
NEGATIVE_DIR = Path(__file__).parent / "training_data" / "negative_real"

NEGATIVE_PROMPTS = [
    "Say: 'What time is it'",
    "Say: 'Hey Dave'",
    "Say: 'Hey Dan'",
    "Say: 'Okay Google'",
    "Say: 'Hey Siri'",
    "Say: 'Alexa'",
    "Say: 'Hello'",
    "Say: 'Play some music'",
    "Say: 'Turn off the lights'",
    "Say: 'Good morning'",
    "Say: 'Chicken' (or any random word)",
    "Just cough or clear your throat",
    "Say: 'Set a timer for 5 minutes'",
    "Say: 'Hey Jack'",
    "Say: 'Hey Flash'",
    "Say: 'What's the weather'",
    "Say: 'Call mom'",
    "Say: 'Hey App'",
    "Say: 'Okay Dash' (wrong trigger word)",
    "Say anything in a different tone/volume",
]

def record_one(pa, label: str) -> np.ndarray:
    stream = pa.open(rate=NATIVE_RATE, channels=CHANNELS, format=pyaudio.paInt16,
                     input=True, input_device_index=DEVICE_INDEX, frames_per_buffer=CHUNK)
    frames = []
    n_chunks = int(NATIVE_RATE / CHUNK * RECORD_SECONDS)
    for _ in range(n_chunks):
        frames.append(stream.read(CHUNK, exception_on_overflow=False))
    stream.stop_stream()
    stream.close()

    audio = np.frombuffer(b"".join(frames), dtype=np.int16)
    audio = audio.reshape(-1, 2).mean(axis=1).astype(np.float32)
    audio = resample_poly(audio, TARGET_RATE, NATIVE_RATE).astype(np.float32)
    return audio / 32768.0


def record_set(mode: str):
    if mode == "positive":
        out_dir = POSITIVE_DIR
        n = 30
        prompt = "Say: 'HEY DASH'"
        prefix = "steve_real"
        # Find next available index
        existing = list(out_dir.glob(f"{prefix}_*.wav"))
        start = len(existing) + 1
    else:
        out_dir = NEGATIVE_DIR
        n = len(NEGATIVE_PROMPTS)
        prefix = "steve_neg"
        existing = list(out_dir.glob(f"{prefix}_*.wav"))
        start = len(existing) + 1

    out_dir.mkdir(parents=True, exist_ok=True)
    pa = pyaudio.PyAudio()

    print(f"\nRecording {n} {mode} samples.")
    if mode == "positive":
        print("Say 'Hey Dash' clearly each time when prompted.\n")
    else:
        print("Say the prompted phrase each time. Do NOT say 'Hey Dash'.\n")

    input("Press Enter when ready...")

    for i in range(n):
        idx = start + i
        if mode == "positive":
            print(f"\n[{i+1}/{n}] Get ready... ", end="", flush=True)
            time.sleep(0.8)
            print(f"{prompt} — NOW", flush=True)
        else:
            p = NEGATIVE_PROMPTS[i % len(NEGATIVE_PROMPTS)]
            print(f"\n[{i+1}/{n}] Get ready... ", end="", flush=True)
            time.sleep(0.8)
            print(f"{p} — NOW", flush=True)

        audio = record_one(pa, mode)
        out_path = out_dir / f"{prefix}_{idx:03d}.wav"
        sf.write(str(out_path), audio, TARGET_RATE)
        print(f"  Saved: {out_path.name}")

    pa.terminate()
    print(f"\nDone! Re-run train_hey_dash.py to retrain.")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "positive"
    if mode not in ("positive", "negative"):
        print("Usage: python3 record_samples.py [positive|negative]")
        sys.exit(1)
    record_set(mode)
