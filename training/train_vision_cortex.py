import torch
import torch.nn as nn
import numpy as np
import os
import sys
from torch.utils.data import Dataset, DataLoader
from tqdm import tqdm

class VisionCortexDataset(Dataset):
    def __init__(self, size: int = 5000, img_size: int = 64, seed: int = 42):
        self.img_size = img_size
        self.data = []
        self.finger_detected = []
        self.roi_centroid = []
        self.signal_rgb = []
        self.latent_vector = []
        
        rng = np.random.default_rng(seed)
        
        for i in range(size):
            # Create a blank 3-channel image (3, 64, 64)
            img = np.zeros((3, img_size, img_size), dtype=np.float32)
            
            # Determine scenario
            scenario = rng.choice(["finger", "dark", "open_flash", "noise"], p=[0.6, 0.15, 0.15, 0.10])
            
            if scenario == "finger":
                # 1. Finger presence
                finger = 1.0
                
                # Random centroid and radius
                cx = rng.uniform(0.2, 0.8) * img_size
                cy = rng.uniform(0.2, 0.8) * img_size
                radius = rng.uniform(0.25, 0.65) * img_size
                
                # Base finger colors (high Red, low Green and Blue)
                r_val = rng.uniform(160, 255) / 255.0
                g_val = rng.uniform(12, 55) / 255.0
                b_val = rng.uniform(5, 30) / 255.0
                
                # Draw circular blob with spatial gradients
                y, x = np.ogrid[:img_size, :img_size]
                dist_from_center = np.sqrt((x - cx)**2 + (y - cy)**2)
                mask = dist_from_center <= radius
                
                # Soft edge anti-aliasing
                edge_mask = np.clip(1.0 - (dist_from_center - (radius - 2.0)) / 3.0, 0, 1)
                
                # Assign values with slight noise
                img[0, :, :] = mask * r_val * edge_mask + (1 - mask) * rng.uniform(0, 10) / 255.0
                img[1, :, :] = mask * g_val * edge_mask + (1 - mask) * rng.uniform(0, 8) / 255.0
                img[2, :, :] = mask * b_val * edge_mask + (1 - mask) * rng.uniform(0, 5) / 255.0
                
                # Add overall spatial illumination gradient (flash spotlight effect)
                fx, fy = rng.uniform(0, img_size), rng.uniform(0, img_size)
                spot_dist = np.sqrt((x - fx)**2 + (y - fy)**2)
                gradient = np.clip(1.2 - spot_dist / (img_size * 1.5), 0.7, 1.3)
                img = img * gradient
                
                # Target average RGB inside the finger ROI
                finger_pixels = img[:, mask]
                if finger_pixels.size > 0:
                    avg_rgb = finger_pixels.mean(axis=1) * 255.0
                else:
                    avg_rgb = np.array([r_val, g_val, b_val], dtype=np.float32) * 255.0
                
                # Centroid target normalized to [0, 1]
                centroid = np.array([cx / img_size, cy / img_size], dtype=np.float32)
                
                # Latent vector: 32-dim, functional projection of finger properties
                latent = np.zeros(32, dtype=np.float32)
                latent[0] = radius / img_size
                latent[1] = r_val
                latent[2] = g_val
                latent[3] = b_val
                latent[4] = avg_rgb.mean() / 255.0
                # Fill the rest with deterministic noise based on centroid
                latent[5:15] = np.sin(np.arange(10) * cx) * 0.1
                latent[15:25] = np.cos(np.arange(10) * cy) * 0.1
                latent[25:32] = rng.uniform(-0.05, 0.05, 7)
                
            elif scenario == "dark":
                # Dark lens (flash off or no tissue close)
                finger = 0.0
                img = rng.uniform(0, 8, (3, img_size, img_size)).astype(np.float32) / 255.0
                avg_rgb = img.mean(axis=(1, 2)) * 255.0
                centroid = np.array([0.5, 0.5], dtype=np.float32)
                latent = np.zeros(32, dtype=np.float32)
                
            elif scenario == "open_flash":
                # Uniform bright background (open camera facing a wall or light)
                finger = 0.0
                # Channels are closer in value (white/gray/yellowish)
                base_color = rng.uniform(150, 240)
                img[0, :, :] = rng.uniform(base_color - 10, base_color + 10, (img_size, img_size)) / 255.0
                img[1, :, :] = rng.uniform(base_color - 15, base_color + 15, (img_size, img_size)) / 255.0
                img[2, :, :] = rng.uniform(base_color - 20, base_color + 20, (img_size, img_size)) / 255.0
                avg_rgb = img.mean(axis=(1, 2)) * 255.0
                centroid = np.array([0.5, 0.5], dtype=np.float32)
                latent = np.zeros(32, dtype=np.float32)
                
            else:  # noise / non-finger random scene
                finger = 0.0
                # Generate random noisy patterns
                img = rng.uniform(0, 255, (3, img_size, img_size)).astype(np.float32) / 255.0
                # Ensure it doesn't look like a finger (R/B ratio should be low or random)
                avg_rgb = img.mean(axis=(1, 2)) * 255.0
                centroid = np.array([0.5, 0.5], dtype=np.float32)
                latent = np.zeros(32, dtype=np.float32)
                
            # Add general Gaussian sensor noise
            img += rng.normal(0, 0.015, img.shape)
            img = np.clip(img, 0.0, 1.0)
            
            self.data.append(img)
            self.finger_detected.append(finger)
            self.roi_centroid.append(centroid)
            self.signal_rgb.append(avg_rgb.astype(np.float32))
            self.latent_vector.append(latent)
            
        self.data = np.array(self.data, dtype=np.float32)
        self.finger_detected = np.array(self.finger_detected, dtype=np.float32)
        self.roi_centroid = np.array(self.roi_centroid, dtype=np.float32)
        self.signal_rgb = np.array(self.signal_rgb, dtype=np.float32)
        self.latent_vector = np.array(self.latent_vector, dtype=np.float32)

    def __len__(self):
        return len(self.finger_detected)

    def __getitem__(self, idx):
        return (
            torch.tensor(self.data[idx]),
            torch.tensor(self.finger_detected[idx]).unsqueeze(0),
            torch.tensor(self.roi_centroid[idx]),
            torch.tensor(self.signal_rgb[idx]),
            torch.tensor(self.latent_vector[idx])
        )

class VisionCortexNet(nn.Module):
    def __init__(self):
        super().__init__()
        # 3 conv layers downsampling from 64x64 to 8x8
        self.conv = nn.Sequential(
            nn.Conv2d(3, 16, kernel_size=3, stride=2, padding=1),  # -> 16x32x32
            nn.BatchNorm2d(16),
            nn.ReLU(),
            nn.Conv2d(16, 32, kernel_size=3, stride=2, padding=1), # -> 32x16x16
            nn.BatchNorm2d(32),
            nn.ReLU(),
            nn.Conv2d(32, 64, kernel_size=3, stride=2, padding=1), # -> 64x8x8
            nn.BatchNorm2d(64),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d(1)                                # -> 64x1x1
        )
        
        # Classification head: Finger present (0 or 1)
        self.fc_finger = nn.Sequential(
            nn.Linear(64, 16),
            nn.ReLU(),
            nn.Linear(16, 1) # Sigmoid applied in forward
        )
        
        # Regressor head: Centroid coordinate prediction [x, y]
        self.fc_centroid = nn.Sequential(
            nn.Linear(64, 16),
            nn.ReLU(),
            nn.Linear(16, 2) # Sigmoid applied in forward to bound to [0, 1]
        )
        
        # Regressor head: Signal RGB average intensity prediction [R, G, B]
        self.fc_signal = nn.Sequential(
            nn.Linear(64, 16),
            nn.ReLU(),
            nn.Linear(16, 3) # Raw predicted intensities
        )
        
        # Embedder head: 32-dim latent embedding
        self.fc_latent = nn.Sequential(
            nn.Linear(64, 32)
        )

    def forward(self, x):
        features = self.conv(x).squeeze(-1).squeeze(-1)
        finger = torch.sigmoid(self.fc_finger(features))
        centroid = torch.sigmoid(self.fc_centroid(features))
        signal = self.fc_signal(features)
        latent = self.fc_latent(features)
        return finger, centroid, signal, latent

def train_vision_cortex(epochs: int = 40, batch_size: int = 64, device: str = "cpu"):
    device = torch.device(device)
    train_ds = VisionCortexDataset(size=4000, seed=42)
    val_ds = VisionCortexDataset(size=800, seed=99)
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size)
    
    model = VisionCortexNet().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    
    # Loss functions
    bce = nn.BCELoss()
    mse = nn.MSELoss()
    
    best_loss = float("inf")
    
    for epoch in range(epochs):
        model.train()
        train_loss = 0.0
        
        for img, finger, centroid, signal, latent in train_loader:
            img, finger, centroid, signal, latent = (
                img.to(device),
                finger.to(device),
                centroid.to(device),
                signal.to(device),
                latent.to(device)
            )
            
            optimizer.zero_grad()
            pred_finger, pred_centroid, pred_signal, pred_latent = model(img)
            
            # Compute loss
            loss_finger = bce(pred_finger, finger)
            
            # Centroid & Signal are masked so we only penalize them when a finger is present
            finger_mask = finger.squeeze(-1) > 0.5
            if finger_mask.sum() > 0:
                loss_centroid = mse(pred_centroid[finger_mask], centroid[finger_mask])
                loss_signal = mse(pred_signal[finger_mask], signal[finger_mask]) * 0.005 # scale down since values in [0, 255]
                loss_latent = mse(pred_latent[finger_mask], latent[finger_mask])
            else:
                loss_centroid = torch.tensor(0.0, device=device)
                loss_signal = torch.tensor(0.0, device=device)
                loss_latent = torch.tensor(0.0, device=device)
                
            loss = loss_finger * 1.5 + loss_centroid * 1.0 + loss_signal * 1.0 + loss_latent * 0.5
            loss.backward()
            optimizer.step()
            train_loss += loss.item()
            
        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for img, finger, centroid, signal, latent in val_loader:
                img, finger, centroid, signal, latent = (
                    img.to(device),
                    finger.to(device),
                    centroid.to(device),
                    signal.to(device),
                    latent.to(device)
                )
                pred_finger, pred_centroid, pred_signal, pred_latent = model(img)
                
                loss_finger = bce(pred_finger, finger)
                
                finger_mask = finger.squeeze(-1) > 0.5
                if finger_mask.sum() > 0:
                    loss_centroid = mse(pred_centroid[finger_mask], centroid[finger_mask])
                    loss_signal = mse(pred_signal[finger_mask], signal[finger_mask]) * 0.005
                    loss_latent = mse(pred_latent[finger_mask], latent[finger_mask])
                else:
                    loss_centroid = torch.tensor(0.0, device=device)
                    loss_signal = torch.tensor(0.0, device=device)
                    loss_latent = torch.tensor(0.0, device=device)
                
                loss = loss_finger * 1.5 + loss_centroid * 1.0 + loss_signal * 1.0 + loss_latent * 0.5
                val_loss += loss.item()
                
        scheduler.step()
        avg_val = val_loss / len(val_loader)
        if (epoch + 1) % 5 == 0 or epoch == epochs - 1:
            print(f"Epoch {epoch + 1}/{epochs} | Train Loss: {train_loss / len(train_loader):.4f} | Val Loss: {avg_val:.4f}")
            
        if avg_val < best_loss:
            best_loss = avg_val
            torch.save(model.state_dict(), os.path.join(os.path.dirname(__file__), "vision_cortex.pt"))
            
    # Load best and export
    model.load_state_dict(torch.load(os.path.join(os.path.dirname(__file__), "vision_cortex.pt")))
    export_to_onnx(model, device)
    print("Vision Cortex training complete.")

def export_to_onnx(model: VisionCortexNet, device: torch.device):
    model.eval()
    dummy = torch.randn(1, 3, 64, 64, device=device)
    out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "models")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "vision_cortex_v1.onnx")
    
    torch.onnx.export(
        model,
        dummy,
        out_path,
        input_names=["frame_pixels"],
        output_names=["finger_detected", "roi_centroid", "signal_rgb", "latent_vector"],
        dynamic_axes={
            "frame_pixels": {0: "batch"},
            "finger_detected": {0: "batch"},
            "roi_centroid": {0: "batch"},
            "signal_rgb": {0: "batch"},
            "latent_vector": {0: "batch"}
        },
        opset_version=17
    )
    print(f"Vision Cortex Model exported to {out_path}")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Train Vision Cortex Model")
    parser.add_argument("--epochs", type=int, default=30, help="Number of training epochs")
    parser.add_argument("--batch-size", type=int, default=64, help="Batch size")
    parser.add_argument("--lr", type=float, default=1e-3, help="Learning rate")
    parser.add_argument("--weight-decay", type=float, default=1e-4, help="Weight decay")
    parser.add_argument("--size", type=int, default=5000, help="Dataset size")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--device", type=str, default="cuda" if torch.cuda.is_available() else "cpu", help="Device (cpu/cuda)")
    
    args = parser.parse_args()
    
    train_vision_cortex(
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        weight_decay=args.weight_decay,
        size=args.size,
        seed=args.seed,
        device=args.device
    )
