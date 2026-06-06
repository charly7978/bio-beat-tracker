import torch
import torch.nn as nn
import numpy as np
import os

class BpMlpNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(16, 32)
        self.relu1 = nn.ReLU()
        self.fc2 = nn.Linear(32, 16)
        self.relu2 = nn.ReLU()
        self.fc3 = nn.Linear(16, 2)

    def forward(self, x):
        x = self.relu1(self.fc1(x))
        x = self.relu2(self.fc2(x))
        return self.fc3(x)

def generate_physiological_data(n_samples=5000, seed=42):
    rng = np.random.default_rng(seed)
    
    # Inputs
    sut_ratio = rng.uniform(0.12, 0.38, n_samples)
    dia_phase_ratio = rng.uniform(0.25, 0.75, n_samples)
    pw50_ratio = rng.uniform(0.15, 0.48, n_samples)
    area_ratio = rng.uniform(0.8, 2.2, n_samples)
    dicrotic_depth = rng.uniform(0.08, 0.45, n_samples)
    stiffness_index = rng.uniform(4.0, 18.0, n_samples)
    augmentation_index = rng.uniform(5.0, 35.0, n_samples)
    k_value = rng.uniform(0.28, 0.52, n_samples)
    v_max = rng.uniform(25.0, 95.0, n_samples)
    agi = rng.uniform(-0.6, 1.6, n_samples)
    b_div_a = rng.uniform(-0.9, 0.9, n_samples)
    d_div_a = rng.uniform(-0.7, 0.5, n_samples)
    
    hr = rng.uniform(50.0, 140.0, n_samples)
    age = rng.uniform(18.0, 85.0, n_samples)
    bmi = rng.uniform(17.5, 38.0, n_samples)
    is_male = rng.choice([0.0, 1.0], size=n_samples)
    
    X = np.stack([
        sut_ratio, dia_phase_ratio, pw50_ratio, area_ratio, dicrotic_depth,
        stiffness_index, augmentation_index, k_value, v_max, agi,
        b_div_a, d_div_a, hr, age, bmi, is_male
    ], axis=1)
    
    # SBP/DBP targets (physiological formulas)
    sbp_base = (
        112.0 + 
        0.32 * (age - 38.0) + 
        0.45 * (bmi - 23.0) + 
        0.15 * (hr - 72.0) + 
        1.15 * stiffness_index + 
        0.22 * augmentation_index - 
        45.0 * (sut_ratio - 0.22) + 
        6.5 * (area_ratio - 1.2)
    )
    dbp_base = (
        72.0 + 
        0.19 * (age - 38.0) + 
        0.32 * (bmi - 23.0) + 
        0.08 * (hr - 72.0) + 
        0.28 * stiffness_index - 
        22.0 * (dia_phase_ratio - 0.48) + 
        14.0 * (pw50_ratio - 0.28)
    )
    
    # Gender adjustment
    sbp_base += (is_male * 5.0 - 2.5)
    dbp_base += (is_male * 2.5 - 1.2)
    
    # Interactions
    sbp = sbp_base + 0.016 * age * stiffness_index + 0.05 * hr * (1.0 - sut_ratio)
    dbp = dbp_base + 0.007 * age * stiffness_index - 0.03 * hr * dia_phase_ratio
    
    # Add noise
    sbp += rng.normal(0, 1.8, n_samples)
    dbp += rng.normal(0, 1.4, n_samples)
    
    # Guardrails
    sbp = np.clip(sbp, 75, 195)
    dbp = np.clip(dbp, 45, 115)
    
    return X.astype(np.float32), np.stack([sbp, dbp], axis=1).astype(np.float32)

def train():
    X_train, y_train = generate_physiological_data(6000, seed=42)
    X_val, y_val = generate_physiological_data(1000, seed=99)
    
    # Normalize inputs
    # We will use hard-coded normalizers in TypeScript, so we do same here
    # Normalization factors:
    # SI/10, AIx/20, Vmax/50, HR/100, Age/50, BMI/25
    norm_X_train = X_train.copy()
    norm_X_val = X_val.copy()
    
    for mat in [norm_X_train, norm_X_val]:
        mat[:, 5] /= 10.0  # stiffness_index
        mat[:, 6] /= 20.0  # augmentation_index
        mat[:, 8] /= 50.0  # v_max
        mat[:, 12] /= 100.0 # hr
        mat[:, 13] /= 50.0  # age
        mat[:, 14] /= 25.0  # bmi
        
    model = BpMlpNet()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.005, weight_decay=1e-4)
    criterion = nn.MSELoss()
    
    X_t = torch.tensor(norm_X_train)
    y_t = torch.tensor(y_train)
    X_v = torch.tensor(norm_X_val)
    y_v = torch.tensor(y_val)
    
    epochs = 120
    best_loss = float('inf')
    best_weights = None
    
    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()
        pred = model(X_t)
        loss = criterion(pred, y_t)
        loss.backward()
        optimizer.step()
        
        model.eval()
        with torch.no_grad():
            v_pred = model(X_v)
            val_loss = criterion(v_pred, y_v).item()
            
        if val_loss < best_loss:
            best_loss = val_loss
            best_weights = {k: v.cpu().numpy() for k, v in model.state_dict().items()}
            
        if (epoch + 1) % 20 == 0:
            print(f"Epoch {epoch+1:03d} | Train MSE: {loss.item():.4f} | Val MSE: {val_loss:.4f}")
            
    print(f"Training finished. Best Val MSE: {best_loss:.4f}")
    
    # Generate TypeScript file
    w1 = best_weights['fc1.weight']
    b1 = best_weights['fc1.bias']
    w2 = best_weights['fc2.weight']
    b2 = best_weights['fc2.bias']
    w3 = best_weights['fc3.weight']
    b3 = best_weights['fc3.bias']
    
    ts_content = f"""/**
 * Pre-trained Multi-Layer Perceptron (MLP) weights for Blood Pressure estimation.
 * Generated automatically by training/train_bp_mlp.py.
 * Do not edit manually.
 */

export const MLP_WEIGHTS = {{
  fc1: {{
    weights: {w1.tolist()},
    bias: {b1.tolist()}
  }},
  fc2: {{
    weights: {w2.tolist()},
    bias: {b2.tolist()}
  }},
  fc3: {{
    weights: {w3.tolist()},
    bias: {b3.tolist()}
  }}
}};
"""
    out_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src", "lib", "vitals", "mlpWeights.ts"))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        f.write(ts_content)
        
    print(f"Exported TS weights to: {out_path}")

if __name__ == "__main__":
    train()
