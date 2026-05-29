/**
 * Utilidades DSP puras compartidas (sin estado).
 * Los filtros IIR en streaming siguen viviendo en `BandpassFilter`.
 */
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { clamp } from '../../../utils/math';
import { median } from '../../../utils/stats';
import { BandpassFilter } from '../BandpassFilter';
import { RESPIRATION_DEFAULTS } from '../../../config/signalProcessing';

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

export function movingAverage(x: number[], win: number): number[] {
  const n = x.length;
  if (n === 0 || win < 1) return [];
  const half = Math.floor(win / 2);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let c = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < n) {
        sum += x[j];
        c++;
      }
    }
    out[i] = c > 0 ? sum / c : x[i];
  }
  return out;
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
    const mad =
      [...slice].reduce((s, v) => s + Math.abs(v - med), 0) / slice.length || 1e-9;
    if (Math.abs(y[i] - med) > nSigma * 1.4826 * mad) {
      out[i] = med;
    }
  }
  return out;
}

/** Re-muestreo lineal a timestamps uniformes en [0, durationMs] */
export function resampleToUniformTimeline(
  values: number[],
  timestampsMs: number[],
  targetCount: number
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

/** Re-muestrea a timeline uniforme si los Δt son irregulares (cámara / backpressure). */
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
  const targetN = clamp(
    Math.round(((timestampsMs[timestampsMs.length - 1]! - timestampsMs[0]!) / 1000) * samplingRateHz),
    cfg.RESAMPLE_TARGET_MIN,
    cfg.RESAMPLE_TARGET_MAX,
  );
  const r = resampleToUniformTimeline(signal, timestampsMs, targetN);
  const ts = new Array<number>(r.y.length);
  for (let i = 0; i < r.y.length; i++) {
    ts[i] = r.t0 + (i * (r.t1 - r.t0)) / Math.max(1, r.y.length - 1);
  }
  return { signal: r.y, timestampsMs: ts, samplingRateHz: r.fs, resampled: true };
}

export function autocorrDominantLag(
  centered: number[],
  minLag: number,
  maxLag: number
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
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  return { lag: bestLag, score: best };
}

export function bandpassOffline(signal: number[], fs: number): number[] {
  const f = new BandpassFilter(fs);
  f.reset();
  return signal.map((s) => f.filter(s));
}

/**
 * Skewness (Fisher–Pearson) de una ventana. SQI más fuerte según Elgendi 2016
 * (F1 ≈ 86% en excelente vs aceptable/no-apto). PPG limpia tiene skew > 0
 * (sístole rápida ascendente, diástole lenta); la corrupción por micro-movimiento
 * tiende a simetría (skew ≈ 0 o negativa). O(n), sin alocación.
 */
export function quickSkewness(values: number[], offset = 0, length?: number): number {
  const start = offset;
  const end = length != null ? Math.min(values.length, start + length) : values.length;
  const n = end - start;
  if (n < 8) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += values[i];
  const mean = sum / n;
  let m2 = 0;
  let m3 = 0;
  for (let i = start; i < end; i++) {
    const d = values[i] - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
  }
  const variance = m2 / n;
  if (variance < 1e-9) return 0;
  const std = Math.sqrt(variance);
  return (m3 / n) / (std * std * std);
}

/**
 * Estima frecuencia respiratoria (rpm) desde modulación de amplitud / baseline del PPG.
 * Fs debe reflejar la cadencia real de muestras del buffer (p.ej. ~10 Hz si se alimenta cada ~100 ms).
 */
export function estimateRespiratoryModulationRpm(
  samples: number[],
  fsHz: number
): { rpm: number; score: number } | null {
  const n = samples.length;
  if (n < RESPIRATION_DEFAULTS.minBuffer * 0.5 || fsHz < 4) return null;
  const det = detrendLinear(samples);
  const w = Math.max(3, Math.round(fsHz * 0.35));
  const ma = movingAverage(det.map((v) => Math.abs(v)), w);
  const env = det.map((v, i) => Math.abs(v) - (ma[i] ?? 0));
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  const centered = env.map((v) => v - mean);
  const minLag = Math.max(6, Math.round((60 / RESPIRATION_DEFAULTS.maxRpm) * fsHz));
  const maxLag = Math.min(centered.length - 3, Math.max(minLag + 2, Math.round((60 / RESPIRATION_DEFAULTS.minRpm) * fsHz)));
  const { lag, score } = autocorrDominantLag(centered, minLag, maxLag);
  if (lag <= 0 || score < 0.12) return null;
  const rpm = (60 * fsHz) / lag;
  if (rpm < RESPIRATION_DEFAULTS.minRpm || rpm > RESPIRATION_DEFAULTS.maxRpm) return null;
  return { rpm, score };
}
