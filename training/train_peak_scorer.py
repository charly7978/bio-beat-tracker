import torch
import torch.nn as nn
import numpy as np
from torch.utils.data import Dataset, DataLoader
from tqdm import tqdm
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from generate_synthetic_ppg import synthetic_ppg_waveform, extract_windows


class PeakScorerDataset(Dataset):
    def __init__(self, n_samples: int = 2000, window_size: int = 256, seed: int = 42):
        self.window_size = window_size
        rng = np.random.default_rng(seed)
        self.signal_windows = []
        self.features = []
        self.scores = []

        for i in range(n_samples):
            bpm = float(rng.uniform(45, 180))
            noise = float(rng.uniform(0.01, 0.15))
            motion = bool(rng.random() < 0.3)
            ppg = synthetic_ppg_waveform(10.0, 30, bpm, noise, motion, seed + i)
            windows = extract_windows(ppg, window_size, stride=window_size // 2)

            for w in windows:
                self.signal_windows.append(w.astype(np.float32))
                sqi = float(rng.uniform(20, 95) if not motion else rng.uniform(5, 40))
                pi = float(rng.uniform(0.002, 0.015) if not motion else rng.uniform(0.0, 0.004))
                peak_idx = int(rng.integers(w.shape[0] // 4, w.shape[0] * 3 // 4))

                is_valid_peak = float(
                    not motion and rng.random() > 0.2
                )
                self.features.append([float(peak_idx), sqi, pi, 0.0])
                self.scores.append(float(is_valid_peak))

        self.signal_windows = np.array(self.signal_windows)
        self.features = np.array(self.features, dtype=np.float32)
        self.scores = np.array(self.scores, dtype=np.float32)

    def __len__(self):
        return len(self.scores)

    def __getitem__(self, idx):
        return (
            torch.tensor(self.signal_windows[idx]).unsqueeze(0),
            torch.tensor(self.features[idx]),
            torch.tensor(self.scores[idx]),
        )


class PeakScorerNet(nn.Module):
    def __init__(self, signal_len: int = 256):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv1d(1, 16, kernel_size=7, padding=3),
            nn.BatchNorm1d(16),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(16, 32, kernel_size=5, padding=2),
            nn.BatchNorm1d(32),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(32, 64, kernel_size=3, padding=1),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),
        )
        self.fc = nn.Sequential(
            nn.Linear(64 + 4, 32),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(32, 16),
            nn.ReLU(),
            nn.Linear(16, 2),
            nn.Sigmoid(),
        )

    def forward(self, signal, features):
        x = self.conv(signal).squeeze(-1)
        x = torch.cat([x, features], dim=1)
        x = self.fc(x)
        return x[:, 0], x[:, 1]  # score, confidence


def train_peak_scorer(epochs: int = 50, batch_size: int = 64, device: str = "cpu"):
    device = torch.device(device)

    train_ds = PeakScorerDataset(n_samples=3000, seed=42)
    val_ds = PeakScorerDataset(n_samples=500, seed=99)
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size)

    model = PeakScorerNet().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    bce = nn.BCELoss()

    best_loss = float("inf")
    for epoch in range(epochs):
        model.train()
        train_loss = 0.0
        for sig, feat, score in tqdm(train_loader, desc=f"Epoch {epoch + 1}/{epochs}"):
            sig, feat, score = sig.to(device), feat.to(device), score.to(device)
            optimizer.zero_grad()
            score_pred, conf_pred = model(sig, feat)
            loss = bce(score_pred, score) + 0.2 * bce(conf_pred, score)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            train_loss += loss.item()

        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for sig, feat, score in val_loader:
                sig, feat, score = sig.to(device), feat.to(device), score.to(device)
                score_pred, conf_pred = model(sig, feat)
                loss = bce(score_pred, score) + 0.2 * bce(conf_pred, score)
                val_loss += loss.item()

        scheduler.step()
        avg_val = val_loss / len(val_loader)
        print(f"  Train: {train_loss / len(train_loader):.4f}  Val: {avg_val:.4f}")

        if avg_val < best_loss:
            best_loss = avg_val
            torch.save(model.state_dict(), os.path.join(os.path.dirname(__file__), "peak_scorer.pt"))

    model.load_state_dict(
        torch.load(os.path.join(os.path.dirname(__file__), "peak_scorer.pt"))
    )
    export_to_onnx(model, device)
    print("Peak Scorer training complete.")


def export_to_onnx(model: PeakScorerNet, device: torch.device):
    model.eval()
    dummy_sig = torch.randn(1, 1, 256, device=device)
    dummy_feat = torch.randn(1, 4, device=device)
    out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "models")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "peak_scorer_v1.onnx")

    torch.onnx.export(
        model,
        (dummy_sig, dummy_feat),
        out_path,
        input_names=["signal", "features"],
        output_names=["score", "confidence"],
        dynamic_axes={
            "signal": {0: "batch"},
            "features": {0: "batch"},
            "score": {0: "batch"},
            "confidence": {0: "batch"},
        },
        opset_version=17,
    )
    print(f"Exported to {out_path}")


if __name__ == "__main__":
    train_peak_scorer()
