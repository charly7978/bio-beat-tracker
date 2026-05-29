/**
 * Detector de picos sistólicos PPG inspirado en Elgendi et al. (TMA + bloques de interés).
 * Entrada: señal PPG (idealmente filtrada); salida: índices/tiempos con diagnóstico auditable.
 *
 * Optimizado: sliding MA O(n) con suma acumulativa, arrays pre-asignados.
 */
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { clamp } from '../../../utils/math';
import {
  bandpassOffline,
  detrendLinear,
  hampel1D,
  prepareUniformPpgWindow,
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

/** MA deslizante O(n) con suma acumulativa, escribe en `out` pre-asignado. */
function slidingMA(x: number[], win: number, out: number[]): void {
  const n = x.length;
  if (n === 0 || win < 1) return;
  const half = Math.floor(win / 2);
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
}

export class ElgendiPeakDetector {
  static detect(input: ElgendiPeakDetectorInput): ElgendiPeakDetectorOutput {
    const minBpm = input.minBpm ?? PEAK_DETECTION_DEFAULTS.minBpm;
    const maxBpm = input.maxBpm ?? PEAK_DETECTION_DEFAULTS.maxBpm;
    const peakMs = input.peakWindowMs ?? PEAK_DETECTION_DEFAULTS.peakWindowMs;
    const beatMs = input.beatWindowMs ?? PEAK_DETECTION_DEFAULTS.beatWindowMs;
    const offsetW = input.offsetWeight ?? PEAK_DETECTION_DEFAULTS.offsetWeight;
    const minProm = input.minProminence ?? PEAK_DETECTION_DEFAULTS.minProminence;
    const nSig = input.signal.length;

    if (nSig !== input.timestampsMs.length || nSig < PEAK_DETECTION_DEFAULTS.minSamplesEnsemble) {
      return {
        peaks: [], peakTimes: [], peakValues: [],
        confidence: 0, rejectedCandidates: [],
        diagnostics: { stage: 'insufficient_input' },
        reason: 'INSUFFICIENT_WINDOW',
        parametersUsed: { minBpm, maxBpm, peakMs, beatMs, offsetW, minProm, fs: input.samplingRateHz },
      };
    }

    const uniform = prepareUniformPpgWindow(input.signal, input.timestampsMs, input.samplingRateHz);
    const sig = uniform.signal;
    const ts = uniform.timestampsMs;
    const fs = uniform.samplingRateHz;
    const n = sig.length;

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(sig[i])) {
        return {
          peaks: [], peakTimes: [], peakValues: [],
          confidence: 0, rejectedCandidates: [],
          diagnostics: { nonFinite: true },
          reason: 'NO_VALID_SIGNAL',
          parametersUsed: { minBpm, maxBpm, peakMs, beatMs, offsetW, minProm, fs },
        };
      }
    }

    const hampelWin = Math.max(5, Math.round(fs * 0.25) | 1);
    const cleaned = hampel1D(sig, hampelWin, 3);
    let x = bandpassOffline(detrendLinear(cleaned), fs);
    x = robustNormalizeZeroCenter(x);

    const w1 = Math.max(3, Math.round((peakMs / 1000) * fs));
    const w2 = Math.max(w1 + 2, Math.round((beatMs / 1000) * fs));

    // Energy signal + MA pre-alloc
    const energy = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const p = x[i] > 0 ? x[i] : 0;
      energy[i] = p * p;
    }

    const maPeak = new Array<number>(n);
    const maBeat = new Array<number>(n);
    slidingMA(energy, w1, maPeak);
    slidingMA(energy, w2, maBeat);

    // Umbral Elgendi canónico (Elgendi 2013 / NeuroKit2):
    //   THR1[n] = MA_beat[n] + β · media(energía)
    // con β = beatOffset · (offsetW / offsetWeight_ref). La calibración por
    // SQI/PI ajusta offsetW (β sube en señal pobre, baja en señal buena).
    let meanEnergy = 0;
    for (let i = 0; i < n; i++) meanEnergy += energy[i];
    meanEnergy /= n;
    const beta =
      PEAK_DETECTION_DEFAULTS.beatOffset * (offsetW / PEAK_DETECTION_DEFAULTS.offsetWeight);
    const thrOffset = beta * meanEnergy;

    const minDist = Math.max(1, Math.round((60000 / maxBpm / 1000) * fs));
    const maxDist = Math.max(minDist + 1, Math.round((60000 / minBpm / 1000) * fs));
    // Ancho mínimo del bloque de interés = W1 (peakwindow) — criterio canónico.
    const minBlock = Math.max(2, w1);
    const maxBlock = Math.ceil(maxDist * 1.25);
    const maxPeaks = Math.ceil(n / minDist) + 2;

    const thr = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      thr[i] = maBeat[i] + thrOffset;
    }

    // Pre-alloc block detection
    const blocks: Array<{ start: number; end: number }> = [];
    let i = 0;
    while (i < n) {
      if (maPeak[i] <= thr[i]) { i++; continue; }
      const start = i;
      while (i < n && maPeak[i] > thr[i]) i++;
      const end = i - 1;
      const len = end - start + 1;
      if (len < minBlock || len > maxBlock) continue;
      blocks.push({ start, end });
    }

    // Pre-alloc result arrays
    const rejectedCandidates: Array<{ index: number; reason: string }> = [];
    const peaks = new Array<number>(maxPeaks);
    const peakTimes = new Array<number>(maxPeaks);
    const peakValues = new Array<number>(maxPeaks);
    const peakProms = new Array<number>(maxPeaks);
    let pk = 0;

    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      let best = b.start;
      let bestV = x[b.start];
      for (let j = b.start + 1; j <= b.end; j++) {
        if (x[j] > bestV) { bestV = x[j]; best = j; }
      }

      const left = Math.max(0, best - minDist);
      const right = Math.min(n - 1, best + minDist);
      let localMin = x[best];
      for (let j = left; j <= right; j++) if (x[j] < localMin) localMin = x[j];
      const prom = bestV - localMin;
      if (prom < minProm) continue;

      if (pk > 0) {
        const prev = peaks[pk - 1];
        const dist = best - prev;
        if (dist < minDist) {
          if (x[best] > x[prev]) { pk--; }
          else { continue; }
        } else if (dist > maxDist) {
          continue;
        }
      }

      peaks[pk] = best;
      peakTimes[pk] = ts[best] ?? ts[ts.length - 1];
      peakValues[pk] = sig[best] ?? 0;
      peakProms[pk] = prom;
      pk++;
    }

    // Rechazo relativo de amplitud: la muesca dícrota y el ruido tienen menor
    // prominencia que el pico sistólico. Se descartan los picos por debajo de
    // una fracción de la prominencia mediana (validado para reducir falsos
    // positivos sin perder latidos reales con modulación respiratoria).
    if (pk >= 3) {
      const promsSorted = peakProms.slice(0, pk).sort((a, b) => a - b);
      const medProm = promsSorted[Math.floor(promsSorted.length / 2)] ?? 0;
      const promFloor = medProm * PEAK_DETECTION_DEFAULTS.peakAmplitudeRejectFraction;
      if (medProm > 0) {
        let w = 0;
        for (let r = 0; r < pk; r++) {
          if (peakProms[r] >= promFloor) {
            peaks[w] = peaks[r];
            peakTimes[w] = peakTimes[r];
            peakValues[w] = peakValues[r];
            w++;
          } else {
            rejectedCandidates.push({ index: peaks[r], reason: 'LOW_REL_AMPLITUDE' });
          }
        }
        pk = w;
      }
    }

    // Trim to actual count
    const outPeaks = peaks.slice(0, pk);
    const outPeakTimes = peakTimes.slice(0, pk);
    const outPeakValues = peakValues.slice(0, pk);

    // RR intervals
    const maxRR = pk > 0 ? pk - 1 : 0;
    const rr = new Array<number>(maxRR);
    let rrCount = 0;
    for (let k = 1; k < pk; k++) {
      const d = outPeakTimes[k] - outPeakTimes[k - 1];
      if (d >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS && d <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS) {
        rr[rrCount++] = d;
      }
    }
    const rrTrim = rr.slice(0, rrCount);

    let rrRegularity = 0;
    if (rrCount >= 3) {
      let m = 0;
      for (let i = 0; i < rrCount; i++) m += rrTrim[i];
      m /= rrCount;
      let v = 0;
      for (let i = 0; i < rrCount; i++) v += (rrTrim[i] - m) ** 2;
      v /= rrCount;
      const cv = Math.sqrt(v) / Math.max(1, m);
      rrRegularity = clamp(1 - cv / 0.35, 0, 1);
    }

    let confidence = rrCount > 0
      ? clamp(rrCount / 6, 0, 1) * 0.4 +
        clamp(pk / 8, 0, 1) * 0.3 +
        rrRegularity * 0.3
      : 0;
    if (typeof input.sqi === 'number' && input.sqi < PEAK_DETECTION_DEFAULTS.minSQI) {
      confidence *= 0.5;
    }

    return {
      peaks: outPeaks,
      peakTimes: outPeakTimes,
      peakValues: outPeakValues,
      confidence,
      rejectedCandidates,
      diagnostics: {
        blocks: blocks.length,
        resampled: uniform.resampled,
        fsEffective: fs,
        rrCount,
        meanEnergy,
        thrOffset,
      },
      reason: pk > 0 ? 'OK' : 'NO_PEAKS',
      parametersUsed: { minBpm, maxBpm, peakMs, beatMs, offsetW, beta, minProm, fs, w1, w2 },
    };
  }
}
