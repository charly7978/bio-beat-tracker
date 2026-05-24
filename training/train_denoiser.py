import torch
import torch.nn as nn
import numpy as np
from torch.utils.data import Dataset, DataLoader
from tqdm import tqdm
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from generate_synthetic_ppg import synthetic_ppg_waveform, extract_windows, add_gaussian_noise


class DenoiserDataset(Dataset):
    def __init__(self, n_samples: int = 3000, window_size: int = 512, seed: int = 42):
        self.noisy = []
        self.clean = []
        rng = np.random.default_rng(seed)

        for i in range(n_samples):
            bpm = float(rng.uniform(45, 180))
            noise = float(rng.uniform(0.02, 0.25))
            motion = bool(rng.random() < 0.2)
            ppg = synthetic_ppg_waveform(10.0, 30, bpm, noise, motion, seed + i)
            windows = extract_windows(ppg, window_size, stride=window_size // 2)

            for w in windows:
                clean = w.copy().astype(np.float32)
                snr = float(rng.uniform(5, 25))
                noised = add_gaussian_noise(clean, snr)
                self.noisy.append(noised)
                self.clean.append(clean)

        self.noisy = np.array(self.noisy, dtype=np.float32)
        self.clean = np.array(self.clean, dtype=np.float32)

    def __len__(self):
        return len(self.clean)

    def __getitem__(self, idx):
        return (
            torch.tensor(self.noisy[idx]).unsqueeze(0),
            torch.tensor(self.clean[idx]).unsqueeze(0),
        )


class DenoiserNet(nn.Module):
    def __init__(self):
        super().__init__()
        # Simple 1D autoencoder
        self.encoder = nn.Sequential(
            nn.Conv1d(1, 16, kernel_size=7, stride=2, padding=3),
            nn.ReLU(),
            nn.Conv1d(16, 32, kernel_size=5, stride=2, padding=2),
            nn.ReLU(),
            nn.Conv1d(32, 64, kernel_size=3, stride=2, padding=1),
            nn.ReLU(),
        )
        self.decoder = nn.Sequential(
            nn.ConvTranspose1d(64, 32, kernel_size=3, stride=2, padding=1, output_padding=1),
            nn.ReLU(),
            nn.ConvTranspose1d(32, 16, kernel_size=5, stride=2, padding=2, output_padding=1),
            nn.ReLU(),
            nn.ConvTranspose1d(16, 1, kernel_size=7, stride=2, padding=3, output_padding=1),
        )

    def forward(self, x):
        x = self.encoder(x)
        x = self.decoder(x)
        return x


def train_denoiser(epochs: int = 50, batch_size: int = 32, device: str = "cpu"):
    device = torch.device(device)
    train_ds = DenoiserDataset(n_samples=3000, seed=42)
    val_ds = DenoiserDataset(n_samples=500, seed=99)
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size)

    model = DenoiserNet().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-5)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    mse = nn.MSELoss()

    best_loss = float("inf")
    for epoch in range(epochs):
        model.train()
        train_loss = 0.0
        for noisy, clean in tqdm(train_loader, desc=f"Epoch {epoch + 1}/{epochs}"):
            noisy, clean = noisy.to(device), clean.to(device)
            optimizer.zero_grad()
            out = model(noisy)
            loss = mse(out, clean)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            train_loss += loss.item()

        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for noisy, clean in val_loader:
                noisy, clean = noisy.to(device), clean.to(device)
                out = model(noisy)
                loss = mse(out, clean)
                val_loss += loss.item()

        scheduler.step()
        avg_val = val_loss / len(val_loader)
        print(f"  Train: {train_loss / len(train_loader):.4f}  Val: {avg_val:.4f}")

        if avg_val < best_loss:
            best_loss = avg_val
            torch.save(
                model.state_dict(),
                os.path.join(os.path.dirname(__file__), "denoiser.pt"),
            )

    model.load_state_dict(
        torch.load(os.path.join(os.path.dirname(__file__), "denoiser.pt"))
    )
    export_to_onnx(model, device)
    print("Denoiser training complete.")


def export_to_onnx(model: DenoiserNet, device: torch.device):
    model.eval()
    dummy = torch.randn(1, 1, 512, device=device)
    out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "models")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "denoiser_v1.onnx")

    torch.onnx.export(
        model,
        dummy,
        out_path,
        input_names=["noisy_signal"],
        output_names=["denoised_signal"],
        dynamic_axes={
            "noisy_signal": {0: "batch"},
            "denoised_signal": {0: "batch"},
        },
        opset_version=17,
    )
    print(f"Exported to {out_path}")


if __name__ == "__main__":
    train_denoiser()
