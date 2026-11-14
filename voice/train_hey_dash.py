#!/usr/bin/env python3
"""
Train a custom "Hey Dash" wake word model for openWakeWord.
Uses macOS `say` TTS to generate positive samples, then trains a small DNN.
Outputs: voice/models/hey_dash.onnx

Input shape matches existing openWakeWord models: (1, 16, 96)
"""

import os
import subprocess
import numpy as np
import torch
import torch.nn as nn
from torch import optim
from torch.utils.data import DataLoader, TensorDataset
from pathlib import Path
import soundfile as sf
from scipy.signal import resample_poly
import sys

SCRIPT_DIR = Path(__file__).parent
SAMPLES_DIR = SCRIPT_DIR / "training_data" / "positive"
MODEL_DIR = SCRIPT_DIR / "models"

SAMPLE_RATE = 16000
PHRASE = "Hey Dash"

# N_FRAMES must match the existing model input: (1, 16, 96)
N_FRAMES = 16
EMBED_DIM = 96

# macOS voices to use
VOICES = [
    "Alex", "Daniel", "Fred", "Karen", "Moira", "Samantha",
    "Victoria", "Tom", "Ava", "Susan", "Nicky",
    "Grandpa (English (US))", "Grandma (English (US))",
    "Reed (English (US))", "Eddy (English (US))", "Flo (English (US))",
    "Albert", "Kathy", "Ralph",
]
RATES = [140, 160, 180, 200, 220, 250]

# Similar-sounding phrases used as hard negatives
NEGATIVE_PHRASES = [
    "Hey Dave", "Hey Dan", "Hey Jack", "Hey App", "Hey Ask",
    "Okay Dash", "Hey Cache", "Hey Flash", "Hey Slash",
]


def generate_samples(phrase: str, out_dir: Path, label: str):
    out_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for voice in VOICES:
        for rate in RATES:
            name = voice.split()[0].lower()
            slug = phrase.lower().replace(" ", "_")
            out_path = out_dir / f"{slug}_{name}_{rate}.wav"
            if out_path.exists():
                count += 1
                continue
            result = subprocess.run(
                ["say", "-v", voice, "-r", str(rate), "-o", str(out_path),
                 "--data-format=LEF32@22050", phrase],
                capture_output=True
            )
            if result.returncode == 0 and out_path.exists():
                count += 1
    print(f"  {label}: {count} samples")


def generate_positive_samples():
    print(f"Generating samples...")
    generate_samples(PHRASE, SAMPLES_DIR, f"'{PHRASE}' (positive)")

    neg_dir = SCRIPT_DIR / "training_data" / "negative_phrases"
    for phrase in NEGATIVE_PHRASES:
        generate_samples(phrase, neg_dir, f"'{phrase}' (hard negative)")
    print()


def load_wav_16k(path: Path) -> np.ndarray:
    data, sr = sf.read(str(path), dtype='float32')
    if data.ndim > 1:
        data = data.mean(axis=1)
    data = (data * 32767).astype(np.float32)
    if sr != SAMPLE_RATE:
        data = resample_poly(data, SAMPLE_RATE, sr).astype(np.float32)
    # Pad to next multiple of 160 (mel hop size) to avoid shape mismatches
    remainder = len(data) % 160
    if remainder != 0:
        data = np.concatenate([data, np.zeros(160 - remainder, dtype=np.float32)])
    return data


def audio_to_windows(audio: np.ndarray, oww_features) -> np.ndarray:
    """
    Convert audio to a sequence of (16, 96) embedding windows.
    Returns array of shape (n_windows, 16, 96).
    """
    audio_int16 = np.clip(audio, -32768, 32767).astype(np.int16)
    # Pad to multiple of 160
    remainder = len(audio_int16) % 160
    if remainder != 0:
        audio_int16 = np.concatenate([audio_int16, np.zeros(160 - remainder, dtype=np.int16)])
    embeddings = oww_features.embed_clips(audio_int16.reshape(1, -1))  # (1, n_frames, 96)
    embeddings = embeddings[0]  # (n_frames, 96)

    n_frames = len(embeddings)
    if n_frames < N_FRAMES:
        # Pad with zeros at start
        pad = np.zeros((N_FRAMES - n_frames, EMBED_DIM), dtype=np.float32)
        embeddings = np.vstack([pad, embeddings])
        n_frames = N_FRAMES

    windows = []
    for i in range(n_frames - N_FRAMES + 1):
        windows.append(embeddings[i:i + N_FRAMES])
    return np.array(windows, dtype=np.float32)  # (n_windows, 16, 96)


def build_dataset(oww_features):
    print("Extracting features...")
    X_pos, X_neg = [], []

    # ── Positive: "Hey Dash" audio padded with leading silence ──
    pos_files = list(SAMPLES_DIR.glob("*.wav"))
    for p in pos_files:
        try:
            phrase_audio = load_wav_16k(p)
            # Pad with 3s of silence before the phrase — simulates real streaming context
            silence = np.zeros(SAMPLE_RATE * 3, dtype=np.float32)
            audio = np.concatenate([silence, phrase_audio])
            windows = audio_to_windows(audio, oww_features)
            # Only the last window contains the completed wake word
            if len(windows) > 0:
                X_pos.append(windows[-1])
        except Exception as e:
            print(f"  Warning: {p.name}: {e}")

    print(f"  Positive examples: {len(X_pos)}")

    # ── Real voice negatives (most important) ──
    real_neg_dir = SCRIPT_DIR / "training_data" / "negative_real"
    for p in real_neg_dir.glob("*.wav"):
        try:
            phrase_audio = load_wav_16k(p)
            silence = np.zeros(SAMPLE_RATE * 3, dtype=np.float32)
            audio = np.concatenate([silence, phrase_audio])
            windows = audio_to_windows(audio, oww_features)
            if len(windows) > 0:
                X_neg.append(windows[-1])
        except Exception as e:
            print(f"  Warning: {p.name}: {e}")

    # ── Hard negatives: similar TTS phrases ──
    neg_phrase_dir = SCRIPT_DIR / "training_data" / "negative_phrases"
    for p in neg_phrase_dir.glob("*.wav"):
        try:
            phrase_audio = load_wav_16k(p)
            silence = np.zeros(SAMPLE_RATE * 3, dtype=np.float32)
            audio = np.concatenate([silence, phrase_audio])
            windows = audio_to_windows(audio, oww_features)
            if len(windows) > 0:
                X_neg.append(windows[-1])
        except Exception as e:
            print(f"  Warning: {p.name}: {e}")

    # ── Soft negatives: noise/silence ──
    n_noise = max(len(X_pos) * 2, 60)
    for _ in range(n_noise):
        noise = np.random.randn(SAMPLE_RATE * 5).astype(np.float32) * 300
        windows = audio_to_windows(noise, oww_features)
        if len(windows) > 0:
            X_neg.append(windows[np.random.randint(len(windows))])

    print(f"  Negative examples: {len(X_neg)}")

    X = np.array(X_pos + X_neg, dtype=np.float32)
    y = np.array([1.0] * len(X_pos) + [0.0] * len(X_neg), dtype=np.float32)

    # Shuffle
    idx = np.random.permutation(len(X))
    return X[idx], y[idx]


class WakeWordModel(nn.Module):
    """Matches openWakeWord model input: (batch, 16, 96)"""
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Flatten(),           # (batch, 16*96=1536)
            nn.Linear(1536, 128),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(64, 1),
            nn.Sigmoid(),
        )

    def forward(self, x):
        return self.net(x)  # shape: (batch, 1) — matches openWakeWord expectation


def train_model(X, y):
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    print(f"\nTraining on {device} with {len(X)} examples...")

    split = int(len(X) * 0.85)
    X_train, X_val = torch.tensor(X[:split]).to(device), torch.tensor(X[split:]).to(device)
    # Unsqueeze y to (batch, 1) to match model output shape
    y_train = torch.tensor(y[:split]).unsqueeze(1).to(device)
    y_val = torch.tensor(y[split:]).unsqueeze(1).to(device)

    model = WakeWordModel().to(device)
    optimizer = optim.Adam(model.parameters(), lr=1e-3, weight_decay=1e-4)
    criterion = nn.BCELoss()

    loader = DataLoader(TensorDataset(X_train, y_train), batch_size=32, shuffle=True)
    best_val_loss, best_state = float("inf"), None

    for epoch in range(80):
        model.train()
        for xb, yb in loader:
            optimizer.zero_grad()
            criterion(model(xb), yb).backward()
            optimizer.step()

        model.eval()
        with torch.no_grad():
            val_loss = criterion(model(X_val), y_val).item()
            preds = (model(X_val) > 0.5).float()
            acc = (preds == y_val).float().mean().item()
            recall = (preds[y_val == 1] == 1).float().mean().item() if (y_val == 1).any() else 0

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

        if (epoch + 1) % 20 == 0:
            print(f"  Epoch {epoch+1:3d}/80 — loss={val_loss:.4f} acc={acc:.3f} recall={recall:.3f}")

    model.load_state_dict(best_state)
    return model.cpu()


def export_onnx(model):
    MODEL_DIR.mkdir(exist_ok=True)
    out_path = MODEL_DIR / "hey_dash.onnx"
    dummy = torch.randn(1, N_FRAMES, EMBED_DIM)
    torch.onnx.export(
        model, dummy, str(out_path),
        input_names=["input"], output_names=["output"],
        dynamic_axes={"input": {0: "batch"}},
        opset_version=12,
    )
    print(f"\nSaved: {out_path}")
    return out_path


def main():
    from openwakeword.utils import AudioFeatures
    oww_features = AudioFeatures()

    generate_positive_samples()
    X, y = build_dataset(oww_features)

    if len(X) == 0:
        print("No training data. Exiting.")
        return

    model = train_model(X, y)
    out_path = export_onnx(model)

    print(f"""
Done! To use the model, update listener.py:
  WAKE_WORD_MODEL = "{out_path}"
""")


if __name__ == "__main__":
    main()
