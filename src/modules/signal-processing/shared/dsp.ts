/**
 * Utilidades DSP puras compartidas (sin estado).
 * Filtros IIR en streaming viven en `BandpassFilter`.
 */
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { clamp } from '../../../utils/math';
import { median } from '../../../utils/stats';
import { BandpassFilter } from '../BandpassFilter';

const TWO_PI_DSP = Math.PI * 2;

export function detrendLinear(y: number[]): number[] {
  const n = y.length;
  if (n < 2) return [...y];
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += y[i];
    sxx += i * i;
    sxy += i * y[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return [...y];
  const a = (n * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / n;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = y[i] - (a * i + b);
  return out;
}

export function robustPercentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp(Math.floor((sorted.length - 1) * q), 0, sorted.length - 1);
  return sorted[idx] ?? 0;
}

export function robustNormalizeZeroCenter(y: number[]): number[] {
  if (y.length === 0) return [];
  const s = [...y].sort((a, b) => a - b);
  const low = robustPercentile(s, 0.1);
  const high = robustPercentile(s, 0.9);
  const range = Math.max(1e-9, high - low);
  return y.map((v) => (clamp(v, low, high) - low) / range - 0.5);
}

/**
 * Media móvil O(n) con suma acumulativa. Reemplaza movingAverage O(n*w).
 * Tamaño de ventana efectivo = 2*half+1 ≈ win.
 */
export function slidingMean(x: number[], win: number): number[] {
  const n = x.length;
  if (n === 0 || win < 1) return [];
  const half = Math.floor(win / 2);
  const out = new Array<number>(n);
  let sum = 0;
  let c = 0;
  for (let i = -half; i <= half; i++) {
    if (i >= 0 && i < n) { sum += x[i]; c++; }
  }
  out[0] = sum / c;
  for (let i = 1; i < n; i++) {
    const removeIdx = i - half - 1;
    if (removeIdx >= 0) { sum -= x[removeIdx]; c--; }
    const addIdx = i + half;
    if (addIdx < n) { sum += x[addIdx]; c++; }
    out[i] = c > 0 ? sum / c : x[i];
  }
  return out;
}

export function movingAverage(x: number[], win: number): number[] {
  const n = x.length;
  if (n === 0 || win < 1) return [];
  const half = Math.floor(win / 2);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < n) { sum += x[j]; c++; }
    }
    out[i] = c > 0 ? sum / c : x[i];
  }
  return out;
}

export function resampleToUniformTimeline(
  values: number[],
  timestampsMs: number[],
  targetCount: number,
): { y: number[]; fs: number; t0: number; t1: number } {
  const n = Math.min(values.length, timestampsMs.length);
  if (n < 2 || targetCount < 4) {
    return { y: values.slice(), fs: 30, t0: timestampsMs[0] ?? 0, t1: timestampsMs[n - 1] ?? 0 };
  }
  const t0 = timestampsMs[0];
  const t1 = timestampsMs[n - 1];
  const duration = Math.max(1, t1 - t0);
  const fs = ((targetCount - 1) / duration) * 1000;
  const y = new Array<number>(targetCount);
  for (let k = 0; k < targetCount; k++) {
    const t = t0 + (duration * k) / (targetCount - 1);
    let j = 0;
    while (j < n - 2 && timestampsMs[j + 1] < t) j++;
    const tA = timestampsMs[j];
    const tB = timestampsMs[j + 1];
    const vA = values[j];
    const vB = values[j + 1];
    const u = tB > tA ? (t - tA) / (tB - tA) : 0;
    y[k] = vA + u * (vB - vA);
  }
  return { y, fs, t0, t1 };
}

export function hampel1D(y: number[], window: number, nSigma = 3): number[] {
  const n = y.length;
  const out = [...y];
  const half = Math.floor(window / 2);
  for (let i = 0; i < n; i++) {
    const slice: number[] = [];
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < n) slice.push(y[j]);
    }
    if (slice.length < 3) continue;
    const med = median(slice);
    const mad = [...slice].reduce((s, v) => s + Math.abs(v - med), 0) / slice.length || 1e-9;
    if (Math.abs(y[i] - med) > nSigma * 1.4826 * mad) out[i] = med;
  }
  return out;
}

/** Re-muestreo lineal a timeline uniforme si los Δt son irregulares. */
export function prepareUniformPpgWindow(
  signal: number[],
  timestampsMs: number[],
  samplingRateHz: number,
): { signal: number[]; timestampsMs: number[]; samplingRateHz: number; resampled: boolean } {
  if (signal.length !== timestampsMs.length || signal.length < 2) {
    return { signal, timestampsMs, samplingRateHz, resampled: false };
  }
  const cfg = PEAK_DETECTION_DEFAULTS;
  const gaps: number[] = [];
  for (let i = 1; i < timestampsMs.length; i++) gaps.push(timestampsMs[i]! - timestampsMs[i - 1]!);
  const sortedG = [...gaps].sort((a, b) => a - b);
  const med = sortedG[Math.floor(sortedG.length / 2)] ?? 1000 / samplingRateHz;
  const jitterP95 = sortedG[Math.floor(sortedG.length * 0.95)] ?? med;
  const needsResample =
    jitterP95 > med * cfg.RESAMPLE_JITTER_FACTOR ||
    med < cfg.RESAMPLE_DT_MIN_MS ||
    med > cfg.RESAMPLE_DT_MAX_MS;
  if (!needsResample) {
    return { signal, timestampsMs, samplingRateHz, resampled: false };
  }
  const t0 = timestampsMs[0];
  const t1 = timestampsMs[timestampsMs.length - 1];
  const duration = Math.max(1, t1 - t0);
  const targetN = clamp(
    Math.round((duration / 1000) * samplingRateHz),
    cfg.RESAMPLE_TARGET_MIN,
    cfg.RESAMPLE_TARGET_MAX,
  );
  if (targetN < 4) return { signal, timestampsMs, samplingRateHz, resampled: false };
  const outSig = new Array<number>(targetN);
  const outTs = new Array<number>(targetN);
  for (let k = 0; k < targetN; k++) {
    const t = t0 + (duration * k) / Math.max(1, targetN - 1);
    outTs[k] = t;
    let j = 0;
    while (j < timestampsMs.length - 2 && timestampsMs[j + 1] < t) j++;
    const tA = timestampsMs[j];
    const tB = timestampsMs[j + 1];
    const vA = signal[j];
    const vB = signal[j + 1];
    const u = tB > tA ? (t - tA) / (tB - tA) : 0;
    outSig[k] = vA + u * (vB - vA);
  }
  return { signal: outSig, timestampsMs: outTs, samplingRateHz: ((targetN - 1) / duration) * 1000, resampled: true };
}

export function autocorrDominantLag(
  centered: number[],
  minLag: number,
  maxLag: number,
): { lag: number; score: number } {
  let bestLag = 0;
  let best = 0;
  const n = centered.length;
  for (let lag = minLag; lag <= maxLag && lag < n - 2; lag++) {
    let cross = 0;
    let eA = 0;
    let eB = 0;
    for (let i = lag; i < n; i++) {
      cross += centered[i] * centered[i - lag];
      eA += centered[i] * centered[i];
      eB += centered[i - lag] * centered[i - lag];
    }
    if (eA <= 0 || eB <= 0) continue;
    const c = cross / Math.sqrt(eA * eB);
    if (c > best) { best = c; bestLag = lag; }
  }
  return { lag: bestLag, score: best };
}

export function bpmFromAutocorr(signal: number[], fs: number): { bpm: number; score: number } {
  if (signal.length < 40 || fs < 8) return { bpm: 0, score: 0 };
  const det = detrendLinear(signal);
  const mean = det.reduce((a, b) => a + b, 0) / det.length;
  const centered = det.map((v) => v - mean);
  const minLag = Math.max(3, Math.round((fs * 60) / 200));
  const maxLag = Math.min(centered.length - 3, Math.round((fs * 60) / 38));
  const { lag, score } = autocorrDominantLag(centered, minLag, maxLag);
  if (lag <= 0 || score < 0.12) return { bpm: 0, score };
  return { bpm: (60 * fs) / lag, score };
}

export function bandLimitedDominantFreq(
  series: number[],
  fsHz: number,
  fMinHz: number,
  fMaxHz: number,
): { freqHz: number; quality: number } {
  const n = series.length;
  const fMax = Math.min(fMaxHz, fsHz * 0.5 - 1e-6);
  if (n < 8 || fsHz <= 0 || fMax <= fMinHz) return { freqHz: 0, quality: 0 };

  let mean = 0;
  for (let i = 0; i < n; i++) mean += series[i];
  mean /= n;
  const centered = new Array<number>(n);
  let totalPower = 0;
  for (let i = 0; i < n; i++) {
    const c = series[i] - mean;
    centered[i] = c;
    totalPower += c * c;
  }
  if (totalPower < 1e-12) return { freqHz: 0, quality: 0 };

  const steps = clamp(Math.round((fMax - fMinHz) / 0.004), 64, 2048);
  let bestMag = 0;
  let bestF = 0;
  for (let s = 0; s <= steps; s++) {
    const f = fMinHz + ((fMax - fMinHz) * s) / steps;
    const w = (TWO_PI_DSP * f) / fsHz;
    const cosW = Math.cos(w);
    const sinW = Math.sin(w);
    let cw = 1;
    let sw = 0;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += centered[i] * cw;
      im += centered[i] * sw;
      const nextCw = cw * cosW - sw * sinW;
      sw = sw * cosW + cw * sinW;
      cw = nextCw;
    }
    const mag = re * re + im * im;
    if (mag > bestMag) { bestMag = mag; bestF = f; }
  }

  const quality = clamp((2 * bestMag) / (n * totalPower), 0, 1);
  return { freqHz: bestF, quality };
}

let _sharedBpf: BandpassFilter | null = null;

export function bandpassOffline(signal: number[], fs: number): number[] {
  if (!_sharedBpf || _sharedBpf.sampleRate !== fs) {
    _sharedBpf = new BandpassFilter(fs, 8);
  } else {
    _sharedBpf.reset();
  }
  return signal.map((s) => _sharedBpf!.filter(s));
}
