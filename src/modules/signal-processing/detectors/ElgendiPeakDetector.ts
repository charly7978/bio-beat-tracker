/**
 * Detector de picos sistólicos PPG inspirado en Elgendi et al. (TMA + bloques de interés).
 * Entrada: señal PPG (idealmente filtrada); salida: índices/tiempos con diagnóstico auditable.
 */
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { clamp } from '../../../utils/math';
import {
  bandpassOffline,
  detrendLinear,
  hampel1D,
  movingAverage,
  resampleToUniformTimeline,
  robustNormalizeZeroCenter,
} from '../shared/dsp';

export interface ElgendiPeakDetectorInput {
  signal: number[];
  timestampsMs: number[];
  /** Fs efectivo (Hz); si no coincide con timestamps se re-muestrea de forma conservadora */
  samplingRateHz: number;
  sqi?: number;
  peakWindowMs?: number;
  beatWindowMs?: number;
  offsetWeight?: number;
  minBpm?: number;
  maxBpm?: number;
  minProminence?: number;
}

export interface ElgendiPeakDetectorOutput {
  peaks: number[];
  peakTimes: number[];
  peakValues: number[];
  confidence: number;
  rejectedCandidates: Array<{ index: number; reason: string }>;
  diagnostics: Record<string, unknown>;
  reason: string;
  parametersUsed: Record<string, number>;
}

function stdSample(x: number[]): number {
  if (x.length < 2) return 0;
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  const v = x.reduce((s, val) => s + (val - m) ** 2, 0) / (x.length - 1);
  return Math.sqrt(Math.max(0, v));
}

export class ElgendiPeakDetector {
  static detect(input: ElgendiPeakDetectorInput): ElgendiPeakDetectorOutput {
    const rejectedCandidates: Array<{ index: number; reason: string }> = [];

    const minBpm = input.minBpm ?? PEAK_DETECTION_DEFAULTS.minBpm;
    const maxBpm = input.maxBpm ?? PEAK_DETECTION_DEFAULTS.maxBpm;
    const peakMs = input.peakWindowMs ?? PEAK_DETECTION_DEFAULTS.peakWindowMs;
    const beatMs = input.beatWindowMs ?? PEAK_DETECTION_DEFAULTS.beatWindowMs;
    const offsetW = input.offsetWeight ?? PEAK_DETECTION_DEFAULTS.offsetWeight;
    const minProm = input.minProminence ?? PEAK_DETECTION_DEFAULTS.minProminence;

    let sig = [...input.signal];
    let ts = [...input.timestampsMs];
    let fs = input.samplingRateHz;

    if (sig.length !== ts.length || sig.length < PEAK_DETECTION_DEFAULTS.minSamplesEnsemble) {
      return {
        peaks: [],
        peakTimes: [],
        peakValues: [],
        confidence: 0,
        rejectedCandidates,
        diagnostics: { stage: 'insufficient_input' },
        reason: 'INSUFFICIENT_WINDOW',
        parametersUsed: { minBpm, maxBpm, peakMs, beatMs, offsetW, minProm, fs },
      };
    }

    // Jitter alto → re-muestreo uniforme
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    const sortedG = [...gaps].sort((a, b) => a - b);
    const med = sortedG[Math.floor(sortedG.length / 2)] ?? 1000 / fs;
    const jitterP95 = sortedG[Math.floor(sortedG.length * 0.95)] ?? med;
    const resample = jitterP95 > med * 1.45 || med < 5 || med > 120;
    if (resample) {
      const targetN = clamp(Math.round(((ts[ts.length - 1] - ts[0]) / 1000) * fs), 64, 512);
      const r = resampleToUniformTimeline(sig, ts, targetN);
      sig = r.y;
      fs = r.fs;
      ts = new Array(sig.length);
      for (let i = 0; i < sig.length; i++) ts[i] = r.t0 + (i * (r.t1 - r.t0)) / Math.max(1, sig.length - 1);
    }

    const finite = sig.every((v) => Number.isFinite(v));
    if (!finite) {
      return {
        peaks: [],
        peakTimes: [],
        peakValues: [],
        confidence: 0,
        rejectedCandidates,
        diagnostics: { nonFinite: true },
        reason: 'NO_VALID_SIGNAL',
        parametersUsed: { minBpm, maxBpm, peakMs, beatMs, offsetW, minProm, fs },
      };
    }

    let x = bandpassOffline(detrendLinear(sig), fs);
    x = robustNormalizeZeroCenter(x);

    const w1 = Math.max(3, Math.round((peakMs / 1000) * fs));
    const w2 = Math.max(w1 + 2, Math.round((beatMs / 1000) * fs));

    const energy = x.map((v) => {
      const p = v > 0 ? v : 0;
      return p * p;
    });

    const maPeak = movingAverage(energy, w1);
    const maBeat = movingAverage(energy, w2);

    const warm = Math.min(maPeak.length, Math.max(8, Math.floor(fs * 1.5)));
    const offset = offsetW * stdSample(maPeak.slice(0, warm));

    const minDist = Math.max(1, Math.round((60000 / maxBpm / 1000) * fs));
    const maxDist = Math.max(minDist + 1, Math.round((60000 / minBpm / 1000) * fs));
    const minBlock = Math.max(2, Math.floor(minDist * 0.35));
    const maxBlock = Math.ceil(maxDist * 1.25);

    const thr = maBeat.map((b, i) => b + offset * (0.85 + 0.15 * (maPeak[i] / (Math.abs(b) + 1e-6))));

    const blocks: { start: number; end: number }[] = [];
    let i = 0;
    while (i < maPeak.length) {
      if (maPeak[i] <= thr[i]) {
        i++;
        continue;
      }
      const start = i;
      while (i < maPeak.length && maPeak[i] > thr[i]) i++;
      const end = i - 1;
      const len = end - start + 1;
      if (len < minBlock) {
        for (let j = start; j <= end; j++) rejectedCandidates.push({ index: j, reason: 'SHORT_BLOCK' });
        continue;
      }
      if (len > maxBlock) {
        rejectedCandidates.push({ index: start, reason: 'LONG_BLOCK' });
        continue;
      }
      blocks.push({ start, end });
    }

    const peaks: number[] = [];
    const peakTimes: number[] = [];
    const peakValues: number[] = [];

    for (const b of blocks) {
      let best = b.start;
      let bestV = x[b.start];
      for (let j = b.start; j <= b.end; j++) {
        if (x[j] > bestV) {
          bestV = x[j];
          best = j;
        }
      }

      const left = Math.max(0, best - minDist);
      const right = Math.min(x.length - 1, best + minDist);
      let localMin = x[best];
      for (let j = left; j <= right; j++) localMin = Math.min(localMin, x[j]);
      const prom = bestV - localMin;
      if (prom < minProm) {
        rejectedCandidates.push({ index: best, reason: 'LOW_PROMINENCE' });
        continue;
      }

      if (peaks.length > 0) {
        const prev = peaks[peaks.length - 1];
        const dist = best - prev;
        if (dist < minDist) {
          if (x[best] > x[prev]) {
            rejectedCandidates.push({ index: prev, reason: 'SUPERSEDED' });
            peaks.pop();
            peakTimes.pop();
            peakValues.pop();
          } else {
            rejectedCandidates.push({ index: best, reason: 'MIN_DISTANCE' });
            continue;
          }
        } else if (dist > maxDist) {
          rejectedCandidates.push({ index: best, reason: 'RR_TOO_LONG' });
          continue;
        }
      }

      peaks.push(best);
      peakTimes.push(ts[best] ?? ts[ts.length - 1]);
      peakValues.push(sig[best] ?? 0);
    }

    const rr: number[] = [];
    for (let k = 1; k < peakTimes.length; k++) {
      const d = peakTimes[k] - peakTimes[k - 1];
      if (d >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS && d <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS) {
        rr.push(d);
      }
    }

    let confidence = rr.length > 0 ? clamp(rr.length / 6, 0, 1) * 0.55 + clamp(peaks.length / 8, 0, 1) * 0.45 : 0;
    if (typeof input.sqi === 'number' && input.sqi < PEAK_DETECTION_DEFAULTS.minSQI) {
      confidence *= 0.5;
    }

    return {
      peaks,
      peakTimes,
      peakValues,
      confidence,
      rejectedCandidates,
      diagnostics: {
        blocks: blocks.length,
        resampled: resample,
        fsEffective: fs,
        rrCount: rr.length,
      },
      reason: peaks.length ? 'OK' : 'NO_PEAKS',
      parametersUsed: { minBpm, maxBpm, peakMs, beatMs, offsetW, minProm, fs, w1, w2 },
    };
  }
}
