import torch
import torch.nn as nn
import numpy as np
from torch.utils.data import Dataset, DataLoader
from tqdm import tqdm
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from generate_synthetic_ppg import synthetic_ppg_waveform, extract_windows


class SqiRefinerDataset(Dataset):
    def __init__(self, n_samples: int = 2000, seed: int = 42):
        rng = np.random.default_rng(seed)
        self.signal_embeds = []
        self.metadata = []
        self.target_sqis = []
        self.target_reliabilities = []

        for i in range(n_samples):
            bpm = float(rng.uniform(45, 180))
            noise = float(rng.uniform(0.01, 0.2))
            motion = bool(rng.random() < 0.3)
            ppg = synthetic_ppg_waveform(10.0, 30, bpm, noise, motion, seed + i)

            windows = extract_windows(ppg, 128, stride=64)

            for w in windows:
                w = w.astype(np.float32)
                self.signal_embeds.append(w)

                raw_sqi = float(rng.uniform(10, 90))
                rr_cv = float(rng.beta(2, 5))  # skewed toward stable (low CV)
                periodicity = float(rng.uniform(0.3, 0.98))
                pi = float(rng.uniform(0.001, 0.015))

                if motion:
                    true_sqi = raw_sqi * rng.uniform(0.3, 0.7)
                    reliability = rng.uniform(0.2, 0.5)
                else:
                    true_sqi = raw_sqi * rng.uniform(0.85, 1.15)
                    reliability = rng.uniform(0.6, 0.95)

                self.metadata.append([raw_sqi, rr_cv, periodicity, pi])
                self.target_sqis.append(float(np.clip(true_sqi, 0, 100)))
                self.target_reliabilities.append(float(np.clip(reliability, 0, 1)))

        self.signal_embeds = np.array(self.signal_embeds, dtype=np.float32)
        self.metadata = np.array(self.metadata, dtype=np.float32)
        self.target_sqis = np.array(self.target_sqis, dtype=np.float32)
        self.target_reliabilities = np.array(self.target_reliabilities, dtype=np.float32)

    def __len__(self):
        return len(self.target_sqis)

    def __getitem__(self, idx):
        return (
            torch.tensor(self.signal_embeds[idx]).unsqueeze(0),
            torch.tensor(self.metadata[idx]),
            torch.tensor(self.target_sqis[idx]),
            torch.tensor(self.target_reliabilities[idx]),
        )


class SqiRefinerNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.signal_enc = nn.Sequential(
            nn.Conv1d(1, 16, kernel_size=7, padding=3),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(16, 8, kernel_size=5, padding=2),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),
        )
        self.fc = nn.Sequential(
            nn.Linear(8 + 4, 32),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(32, 16),
            nn.ReLU(),
            nn.Linear(16, 2),
        )

    def forward(self, signal, metadata):
        x = self.signal_enc(signal).squeeze(-1)
        x = torch.cat([x, metadata], dim=1)
        x = self.fc(x)
        sqi = torch.sigmoid(x[:, 0]) * 100
        reliability = torch.sigmoid(x[:, 1])
        return sqi, reliability


def train_sqi_refiner(epochs: int = 50, batch_size: int = 64, device: str = "cpu"):
    device = torch.device(device)
    train_ds = SqiRefinerDataset(n_samples=3000, seed=42)
    val_ds = SqiRefinerDataset(n_samples=500, seed=99)
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size)

    model = SqiRefinerNet().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    mse = nn.MSELoss()

    best_loss = float("inf")
    for epoch in range(epochs):
        model.train()
        train_loss = 0.0
        for sig, meta, t_sqi, t_rel in tqdm(train_loader, desc=f"Epoch {epoch + 1}/{epochs}"):
            sig, meta, t_sqi, t_rel = (
                sig.to(device),
                meta.to(device),
                t_sqi.to(device),
                t_rel.to(device),
            )
            optimizer.zero_grad()
            sqi_pred, rel_pred = model(sig, meta)
            loss = mse(sqi_pred, t_sqi) + 0.3 * mse(rel_pred, t_rel)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            train_loss += loss.item()

        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for sig, meta, t_sqi, t_rel in val_loader:
                sig, meta, t_sqi, t_rel = (
                    sig.to(device),
                    meta.to(device),
                    t_sqi.to(device),
                    t_rel.to(device),
                )
                sqi_pred, rel_pred = model(sig, meta)
                loss = mse(sqi_pred, t_sqi) + 0.3 * mse(rel_pred, t_rel)
                val_loss += loss.item()

        scheduler.step()
        avg_val = val_loss / len(val_loader)
        print(f"  Train: {train_loss / len(train_loader):.4f}  Val: {avg_val:.4f}")

        if avg_val < best_loss:
            best_loss = avg_val
            torch.save(
                model.state_dict(),
                os.path.join(os.path.dirname(__file__), "sqi_refiner.pt"),
            )

    model.load_state_dict(
        torch.load(os.path.join(os.path.dirname(__file__), "sqi_refiner.pt"))
    )
    export_to_onnx(model, device)
    print("SQI Refiner training complete.")


def export_to_onnx(model: SqiRefinerNet, device: torch.device):
    model.eval()
    dummy_sig = torch.randn(1, 1, 128, device=device)
    dummy_meta = torch.randn(1, 4, device=device)
    out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "models")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "sqi_refiner_v1.onnx")

    torch.onnx.export(
        model,
        (dummy_sig, dummy_meta),
        out_path,
        input_names=["signal_embed", "metadata"],
        output_names=["refined_sqi", "reliability"],
        dynamic_axes={
            "signal_embed": {0: "batch"},
            "metadata": {0: "batch"},
            "refined_sqi": {0: "batch"},
            "reliability": {0: "batch"},
        },
        opset_version=17,
    )
    print(f"Exported to {out_path}")


if __name__ == "__main__":
    train_sqi_refiner()
