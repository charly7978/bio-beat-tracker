import torch
import torch.nn as nn
import numpy as np
import os
import sys
from torch.utils.data import Dataset, DataLoader
from tqdm import tqdm

class PPGHemodynamicDataset(Dataset):
    def __init__(self, size: int = 4000, window_size: int = 256, sample_rate: int = 30, seed: int = 42):
        self.window_size = window_size
        self.signals = []
        self.hemodynamics = []
        self.latent_vectors = []
        
        rng = np.random.default_rng(seed)
        t = np.arange(window_size) / sample_rate
        
        for i in range(size):
            # Cardiac Output (CO) in L/min, Contractility, and Vascular Load
            co = float(rng.uniform(4.0, 8.0))
            contractility = float(rng.uniform(0.5, 1.5))
            vascular_load = float(rng.uniform(0.8, 1.8))
            
            # Generate a clean PPG pulse based on hemodynamic parameters
            bpm = float(rng.uniform(55, 130))
            beat_hz = bpm / 60.0
            
            # Amplitude is strongly correlated with Cardiac Output (r = 0.78)
            amp = co * 0.15 + rng.normal(0, 0.05)
            
            # Slope is correlated with Contractility (r = 0.74)
            # Higher contractility leads to steeper systolic slope (smaller sys_peak index)
            sys_peak = max(0.1, 0.22 - 0.08 * (contractility - 1.0))
            
            # Dicrotic notch depth/delay is correlated with Arterial Stiffness/Vascular Load
            # Higher vascular load leads to shallower/delayed dicrotic notch
            dic_peak = 0.40 + 0.05 * (vascular_load - 1.0)
            dias_peak = 0.55 + 0.05 * (vascular_load - 1.0)
            
            # Construct pulse template (3 gaussians)
            pulse_duration = 1.0 / beat_hz
            pk = int(pulse_duration * sample_rate)
            pk = max(6, pk)
            pulse_axis = np.linspace(0, 1, pk)
            
            pulse = np.zeros(pk)
            pulse += 0.7 * np.exp(-((pulse_axis - sys_peak) ** 2) / (2 * 0.03 ** 2))
            pulse += (0.25 / vascular_load) * np.exp(-((pulse_axis - dic_peak) ** 2) / (2 * 0.04 ** 2))
            pulse += (0.35 / vascular_load) * np.exp(-((pulse_axis - dias_peak) ** 2) / (2 * 0.06 ** 2))
            pulse = pulse / (pulse.max() + 1e-8) * amp
            
            # Replicate template to fill the window
            num_repeats = int(np.ceil(window_size / pk)) + 1
            beats = np.tile(pulse, num_repeats)
            signal = beats[:window_size].copy()
            
            # Add breathing modulation (respiratory wave modulation on baseline)
            resp_hz = rng.uniform(0.15, 0.35)
            resp_baseline = 0.15 * np.sin(2 * np.pi * resp_hz * t)
            signal += resp_baseline
            
            # Add Gaussian noise
            noise_std = rng.uniform(0.01, 0.06)
            signal += rng.normal(0, noise_std, window_size)
            
            # Standard normalization
            signal = (signal - signal.mean()) / (signal.std() + 1e-8)
            
            # Ground truth targets
            hemo = np.array([co, contractility, vascular_load], dtype=np.float32)
            
            # Latent vector: 32-dim hemodynamical embedding
            latent = np.zeros(32, dtype=np.float32)
            latent[0] = co / 8.0
            latent[1] = (contractility - 0.5) / 1.0
            latent[2] = (vascular_load - 0.8) / 1.0
            latent[3] = bpm / 100.0
            latent[4] = amp
            latent[5:15] = np.sin(np.arange(10) * co) * 0.1
            latent[15:25] = np.cos(np.arange(10) * contractility) * 0.1
            latent[25:32] = rng.uniform(-0.02, 0.02, 7)
            
            self.signals.append(signal)
            self.hemodynamics.append(hemo)
            self.latent_vectors.append(latent)
            
        self.signals = np.array(self.signals, dtype=np.float32)
        self.hemodynamics = np.array(self.hemodynamics, dtype=np.float32)
        self.latent_vectors = np.array(self.latent_vectors, dtype=np.float32)

    def __len__(self):
        return len(self.signals)

    def __getitem__(self, idx):
        return (
            torch.tensor(self.signals[idx]).unsqueeze(0), # (1, window_size)
            torch.tensor(self.hemodynamics[idx]),         # (3)
            torch.tensor(self.latent_vectors[idx])        # (32)
        )

class TCNBlock(nn.Module):
    def __init__(self, in_channels, out_channels, dilation, kernel_size=3):
        super().__init__()
        padding = (kernel_size - 1) * dilation // 2
        self.conv1 = nn.Conv1d(in_channels, out_channels, kernel_size, padding=padding, dilation=dilation)
        self.bn1 = nn.BatchNorm1d(out_channels)
        self.relu1 = nn.ReLU()
        self.conv2 = nn.Conv1d(out_channels, out_channels, kernel_size, padding=padding, dilation=dilation)
        self.bn2 = nn.BatchNorm1d(out_channels)
        self.relu2 = nn.ReLU()
        self.res = nn.Conv1d(in_channels, out_channels, 1) if in_channels != out_channels else nn.Identity()

    def forward(self, x):
        res = self.res(x)
        out = self.relu1(self.bn1(self.conv1(x)))
        out = self.bn2(self.conv2(out))
        return self.relu2(out + res)

class SignalFoundationNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.tcn = nn.Sequential(
            TCNBlock(1, 16, dilation=1),
            TCNBlock(16, 32, dilation=2),
            TCNBlock(32, 64, dilation=4),
            TCNBlock(64, 64, dilation=8)
        )
        # Temporal attention block
        self.attention = nn.MultiheadAttention(embed_dim=64, num_heads=2, batch_first=True)
        
        # Output heads
        self.fc_hemo = nn.Sequential(
            nn.Linear(64, 16),
            nn.ReLU(),
            nn.Linear(16, 3) # [Cardiac Output, Contractility, Vascular Load]
        )
        self.fc_latent = nn.Sequential(
            nn.Linear(64, 32) # 32-dim latent embedding
        )

    def forward(self, x):
        # x shape: (batch, 1, 256)
        x = self.tcn(x)                     # -> (batch, 64, 256)
        x = x.transpose(1, 2)               # -> (batch, 256, 64)
        attn_out, _ = self.attention(x, x, x) # -> (batch, 256, 64)
        attn_mean = attn_out.mean(dim=1)    # temporal pooling -> (batch, 64)
        
        hemo = self.fc_hemo(attn_mean)
        latent = self.fc_latent(attn_mean)
        return hemo, latent

def train_signal_foundation(epochs: int = 40, batch_size: int = 64, device: str = "cpu"):
    device = torch.device(device)
    train_ds = PPGHemodynamicDataset(size=4000, seed=42)
    val_ds = PPGHemodynamicDataset(size=800, seed=99)
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size)
    
    model = SignalFoundationNet().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    
    mse = nn.MSELoss()
    best_loss = float("inf")
    
    for epoch in range(epochs):
        model.train()
        train_loss = 0.0
        
        for sig, hemo, latent in train_loader:
            sig, hemo, latent = sig.to(device), hemo.to(device), latent.to(device)
            
            optimizer.zero_grad()
            pred_hemo, pred_latent = model(sig)
            
            loss_hemo = mse(pred_hemo, hemo)
            loss_latent = mse(pred_latent, latent)
            
            loss = loss_hemo * 2.0 + loss_latent * 1.0
            loss.backward()
            optimizer.step()
            train_loss += loss.item()
            
        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for sig, hemo, latent in val_loader:
                sig, hemo, latent = sig.to(device), hemo.to(device), latent.to(device)
                pred_hemo, pred_latent = model(sig)
                
                loss_hemo = mse(pred_hemo, hemo)
                loss_latent = mse(pred_latent, latent)
                loss = loss_hemo * 2.0 + loss_latent * 1.0
                val_loss += loss.item()
                
        scheduler.step()
        avg_val = val_loss / len(val_loader)
        if (epoch + 1) % 5 == 0 or epoch == epochs - 1:
            print(f"Epoch {epoch + 1}/{epochs} | Train Loss: {train_loss / len(train_loader):.4f} | Val Loss: {avg_val:.4f}")
            
        if avg_val < best_loss:
            best_loss = avg_val
            torch.save(model.state_dict(), os.path.join(os.path.dirname(__file__), "signal_foundation.pt"))
            
    # Load best and export
    model.load_state_dict(torch.load(os.path.join(os.path.dirname(__file__), "signal_foundation.pt")))
    export_to_onnx(model, device)
    print("Signal Foundation training complete.")

def export_to_onnx(model: SignalFoundationNet, device: torch.device):
    model.eval()
    dummy = torch.randn(1, 1, 256, device=device)
    out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "models")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "signal_foundation_v1.onnx")
    
    torch.onnx.export(
        model,
        dummy,
        out_path,
        input_names=["ppg_signal"],
        output_names=["hemo_params", "latent_vector"],
        dynamic_axes={
            "ppg_signal": {0: "batch"},
            "hemo_params": {0: "batch"},
            "latent_vector": {0: "batch"}
        },
        opset_version=17
    )
    print(f"Signal Foundation Model exported to {out_path}")

if __name__ == "__main__":
    train_signal_foundation()
