import numpy as np
from scipy import signal as scipy_signal
from typing import Tuple, Optional


def synthetic_ppg_waveform(
    duration_sec: float = 10.0,
    sample_rate: int = 30,
    bpm: float = 72.0,
    noise_level: float = 0.05,
    motion_artifact: bool = False,
    seed: Optional[int] = None,
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(duration_sec * sample_rate)
    t = np.arange(n) / sample_rate

    beat_hz = bpm / 60.0
    # PPG pulse shape: sum of 3 gaussians (systolic peak, dicrotic notch, diastolic)
    pulse_duration = 1.0 / beat_hz
    pulse = np.zeros(int(pulse_duration * sample_rate))
    pk = len(pulse)
    pulse_axis = np.linspace(0, 1, pk)

    sys_peak = 0.18
    dic_peak = 0.42
    dias_peak = 0.56

    pulse += 0.7 * np.exp(-((pulse_axis - sys_peak) ** 2) / (2 * 0.03 ** 2))
    pulse += 0.25 * np.exp(-((pulse_axis - dic_peak) ** 2) / (2 * 0.04 ** 2))
    pulse += 0.3 * np.exp(-((pulse_axis - dias_peak) ** 2) / (2 * 0.06 ** 2))
    pulse = pulse / pulse.max() * 0.8 + 0.2  # normalize with DC offset

    beats = np.tile(pulse, int(np.ceil(duration_sec * beat_hz)) + 1)
    ppg = beats[:n]

    # Add realistic HRV jitter
    for i in range(1, int(duration_sec * beat_hz)):
        jitter = rng.normal(0, 0.02 / beat_hz)  # ~2% RR jitter
        shift_s = int(jitter * sample_rate)
        start = int(i * pulse_duration * sample_rate)
        if 0 <= start + shift_s < n and start < n:
            seg_len = min(pulse_duration * sample_rate, n - start - shift_s)
            seg_len = max(0, int(seg_len))
            if seg_len > 0 and start + shift_s + seg_len <= n:
                ppg[start + shift_s : start + shift_s + seg_len] += beat_scale(
                    rng, pulse, seg_len
                )

    # Filter to PPG band
    sos = scipy_signal.butter(4, [0.5, 8], btype="band", fs=sample_rate, output="sos")
    ppg = scipy_signal.sosfilt(sos, ppg)

    # Normalize
    ppg = (ppg - ppg.min()) / (ppg.max() - ppg.min() + 1e-8)
    ppg = ppg * 2 - 1  # scale to [-1, 1]

    # Noise
    ppg += rng.normal(0, noise_level, n)

    if motion_artifact:
        # Burst noise (simulate movement)
        burst_starts = rng.integers(0, n - sample_rate, int(duration_sec * beat_hz * 0.1))
        for bs in burst_starts:
            burst_len = min(sample_rate // 3, n - bs)
            ppg[bs : bs + burst_len] += rng.uniform(-0.5, 0.5, burst_len)

    return ppg.astype(np.float32)


def beat_scale(rng, pulse, seg_len):
    amp = 0.8 + rng.random() * 0.4
    return pulse[:seg_len] * amp


def extract_windows(
    signal: np.ndarray, window_size: int = 256, stride: int = 30
) -> np.ndarray:
    n = len(signal)
    windows = []
    for start in range(0, n - window_size + 1, stride):
        w = signal[start : start + window_size]
        windows.append(w)
    return np.stack(windows) if windows else np.zeros((0, window_size), dtype=np.float32)


def add_gaussian_noise(signal: np.ndarray, snr_db: float = 20.0) -> np.ndarray:
    power = np.mean(signal ** 2)
    noise_power = power / (10 ** (snr_db / 10))
    noise = np.random.normal(0, np.sqrt(noise_power), signal.shape)
    return signal + noise


def generate_batch(
    n_samples: int,
    duration_sec: float = 10.0,
    sample_rate: int = 30,
    window_size: int = 256,
    seed: int = 42,
) -> Tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    signals = []
    labels = []
    for i in range(n_samples):
        bpm = rng.uniform(45, 180)
        noise = rng.uniform(0.01, 0.15)
        motion = rng.random() < 0.3
        ppg = synthetic_ppg_waveform(duration_sec, sample_rate, bpm, noise, motion, seed + i)
        windows = extract_windows(ppg, window_size)
        for w in windows:
            signals.append(w)
            labels.append(1.0 if not motion else 0.5 + rng.random() * 0.5)
    return np.array(signals, dtype=np.float32), np.array(labels, dtype=np.float32)
