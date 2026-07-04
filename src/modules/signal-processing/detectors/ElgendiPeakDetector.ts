/**
 * Detector de picos sistólicos PPG — Implementación ELGENDI et al. (2013)
 * Exactamente como en NeuroKit2 y el paper original:
 *
 *   Elgendi M, Norton I, Brearley M, Abbott D, Schuurmans D (2013)
 *   "Systolic Peak Detection in Acceleration Photoplethysmograms Measured
 *   from Emergency Responders in Tropical Conditions"
 *   PLoS ONE 8(10): e76585. doi:10.1371/journal.pone.0076585
 *
 * Pipeline:
 *   1. Señal PPG debe venir filtrada pasa-banda 0.5–8 Hz (Elgendi estándar)
 *   2. Amplitudes negativas → 0; elevar al cuadrado (energía)
 *   3. MA_peak (ventana ~111 ms) y MA_beat (ventana ~667 ms)
 *   4. THR1 = MA_beat + beatoffset × mean(energía)
 *   5. Bloques donde MA_peak > THR1
 *   6. Dentro de cada bloque: pico de máxima prominencia
 *   7. Refractario mínimo (mindelay = 300 ms) entre picos
 */
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { clamp } from '../../../utils/math';
import { skewness } from '../../../utils/stats';
import {
  bandpassOffline,
  detrendLinear,
  hampel1D,
  prepareUniformPpgWindow,
  robustNormalizeZeroCenter,
  slidingMean,
} from '../shared/dsp';

export interface ElgendiPeakDetectorInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  sqi?: number;
  peakWindowMs?: number;
  beatWindowMs?: number;
  beatOffset?: number;
  minDelayMs?: number;
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

export class ElgendiPeakDetector {
  static detect(input: ElgendiPeakDetectorInput): ElgendiPeakDetectorOutput {
    const minBpm = input.minBpm ?? PEAK_DETECTION_DEFAULTS.minBpm;
    const maxBpm = input.maxBpm ?? PEAK_DETECTION_DEFAULTS.maxBpm;
    const peakMs = input.peakWindowMs ?? PEAK_DETECTION_DEFAULTS.peakWindowMs;
    const beatMs = input.beatWindowMs ?? PEAK_DETECTION_DEFAULTS.beatWindowMs;
    const beatOffset = input.beatOffset ?? PEAK_DETECTION_DEFAULTS.beatOffset;
    const minDelayMs = input.minDelayMs ?? PEAK_DETECTION_DEFAULTS.minDelayMs;
    const minProm = input.minProminence ?? PEAK_DETECTION_DEFAULTS.minProminence;
    const nSig = input.signal.length;

    if (nSig !== input.timestampsMs.length || nSig < PEAK_DETECTION_DEFAULTS.minSamplesEnsemble) {
      return {
        peaks: [], peakTimes: [], peakValues: [],
        confidence: 0, rejectedCandidates: [],
        diagnostics: { stage: 'insufficient_input' },
        reason: 'INSUFFICIENT_WINDOW',
        parametersUsed: { minBpm, maxBpm, peakMs, beatMs, beatOffset, minProm, fs: input.samplingRateHz },
      };
    }

    // 1) Remuestreo uniforme si hay jitter en timestamps
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
          parametersUsed: { minBpm, maxBpm, peakMs, beatMs, beatOffset, minProm, fs },
        };
      }
    }

    // 2) Hampel + detrend + bandpass 0.5–8Hz (Elgendi/NeuroKit2 estándar)
    const hampelWin = Math.max(5, Math.round(fs * 0.25) | 1);
    const cleaned = hampel1D(sig, hampelWin, 3);
    let x = bandpassOffline(detrendLinear(cleaned), fs);
    x = robustNormalizeZeroCenter(x);

    // SQI por skewness (Elgendi 2016)
    const signalSkewness = skewness(x);

    // 3) Energía al cuadrado (NeuroKit2: signal_abs[signal_abs<0]=0; sqrd = signal_abs**2)
    const sqrd = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      sqrd[i] = x[i] > 0 ? x[i] * x[i] : 0;
    }

    // 4) Moving averages (slidingMean O(n) con suma acumulativa)
    const w1 = Math.max(3, Math.round((peakMs / 1000) * fs));
    const w2 = Math.max(w1 + 2, Math.round((beatMs / 1000) * fs));
    const maPeak = slidingMean(sqrd, w1);
    const maBeat = slidingMean(sqrd, w2);

    // 5) THR1 = MA_beat + beatoffset * mean(sqrd)   [Elgendi threshold 1]
    let meanEnergy = 0;
    for (let i = 0; i < n; i++) meanEnergy += sqrd[i];
    meanEnergy /= n;
    const thr1 = maBeat.map((v) => v + beatOffset * meanEnergy);

    // 6) Bloques de interés (NeuroKit2: waves = ma_peak > thr1)
    const begWaves: number[] = [];
    const endWaves: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      if (maPeak[i] <= thr1[i] && maPeak[i + 1] > thr1[i + 1]) begWaves.push(i + 1);
      if (maPeak[i] > thr1[i] && maPeak[i + 1] <= thr1[i + 1]) endWaves.push(i);
    }
    // Si la señal termina en un bloque activo, cerrarlo
    if (maPeak[n - 1] > thr1[n - 1]) endWaves.push(n - 1);
    // Filtrar endWaves que preceden al primer begWave
    while (endWaves.length > 0 && begWaves.length > 0 && endWaves[0] < begWaves[0]) endWaves.shift();

    const numWaves = Math.min(begWaves.length, endWaves.length);
    const minLen = w1; // threshold 2 del paper: bloque más corto que peakwindow se descarta
    const minDelay = Math.round((minDelayMs / 1000) * fs);

    // 7) Picos dentro de cada bloque (máxima prominencia → NeuroKit2 scipy.signal.find_peaks)
    const rejectedCandidates: Array<{ index: number; reason: string }> = [];
    const peaks: number[] = [];
    const peakTimes: number[] = [];
    const peakValues: number[] = [];

    for (let i = 0; i < numWaves; i++) {
      const beg = begWaves[i];
      const end = endWaves[i];
      const lenWave = end - beg;

      if (lenWave < minLen) continue;

      // Encontrar el pico de máxima prominencia dentro del bloque
      // (equivalente a scipy.signal.find_peaks(data, prominence=(None, None)))
      const data = x.slice(beg, end + 1);
      const best = findMostProminentPeak(data);
      if (best < 0) continue;

      const peakIdx = beg + best;

      // Refractario mínimo entre picos (mindelay = 300 ms)
      if (peaks.length > 0 && peakIdx - peaks[peaks.length - 1] < minDelay) continue;

      // Prominencia mínima (gate de seguridad adicional)
      const prom = computeProminence(x, peakIdx, minDelay);
      if (prom < minProm) {
        rejectedCandidates.push({ index: peakIdx, reason: 'LOW_PROMINENCE' });
        continue;
      }

      peaks.push(peakIdx);
      peakTimes.push(ts[peakIdx] ?? ts[ts.length - 1]);
      peakValues.push(sig[peakIdx] ?? 0);
    }

    // 8) Rechazo relativo de amplitud (Elgendi no lo hace en NK2, pero es útil para cámara)
    const pk = peaks.length;
    if (pk >= 3) {
      const proms = new Array<number>(pk);
      for (let i = 0; i < pk; i++) proms[i] = computeProminence(x, peaks[i], Math.round((60000 / maxBpm / 1000) * fs));
      const sortedProms = [...proms].sort((a, b) => a - b);
      const medProm = sortedProms[Math.floor(sortedProms.length / 2)] ?? 0;
      if (medProm > 0) {
        const floor = medProm * PEAK_DETECTION_DEFAULTS.peakAmplitudeRejectFraction;
        const ceil = medProm * PEAK_DETECTION_DEFAULTS.peakAmplitudeRejectUpper;
        let w = 0;
        for (let r = 0; r < pk; r++) {
          if (proms[r] >= floor && proms[r] <= ceil) {
            peaks[w] = peaks[r];
            peakTimes[w] = peakTimes[r];
            peakValues[w] = peakValues[r];
            w++;
          } else {
            rejectedCandidates.push({
              index: peaks[r],
              reason: proms[r] > ceil ? 'HIGH_REL_AMPLITUDE' : 'LOW_REL_AMPLITUDE',
            });
          }
        }
        peaks.length = w;
        peakTimes.length = w;
        peakValues.length = w;
      }
    }

    // 9) RR intervals + confidence
    const rr: number[] = [];
    for (let k = 1; k < peaks.length; k++) {
      const d = peakTimes[k] - peakTimes[k - 1];
      if (d >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS && d <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS) {
        rr.push(d);
      }
    }

    let rrRegularity = 0;
    if (rr.length >= 3) {
      const m = rr.reduce((a, b) => a + b, 0) / rr.length;
      const v = rr.reduce((a, b) => a + (b - m) ** 2, 0) / rr.length;
      const cv = Math.sqrt(v) / Math.max(1, m);
      rrRegularity = clamp(1 - cv / 0.35, 0, 1);
    }

    let confidence = rr.length > 0
      ? clamp(rr.length / 6, 0, 1) * 0.4 +
        clamp(peaks.length / 8, 0, 1) * 0.3 +
        rrRegularity * 0.3
      : 0;
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
        blocks: numWaves,
        resampled: uniform.resampled,
        fsEffective: fs,
        rrCount: rr.length,
        meanEnergy,
        signalSkewness,
      },
      reason: peaks.length > 0 ? 'OK' : 'NO_PEAKS',
      parametersUsed: { minBpm, maxBpm, peakMs, beatMs, beatOffset, minProm, minDelayMs, fs, w1, w2 },
    };
  }
}

function findMostProminentPeak(data: number[]): number {
  let bestIdx = -1;
  let bestProm = -1;
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) continue;
    let leftMin = data[i];
    for (let j = i - 1; j >= 0; j--) {
      if (data[j] < leftMin) leftMin = data[j];
      if (data[j] > data[i]) break;
    }
    let rightMin = data[i];
    for (let j = i + 1; j < data.length; j++) {
      if (data[j] < rightMin) rightMin = data[j];
      if (data[j] > data[i]) break;
    }
    const prom = data[i] - Math.max(leftMin, rightMin);
    if (prom > bestProm) {
      bestProm = prom;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function computeProminence(signal: number[], idx: number, halfWindow: number): number {
  const left = Math.max(0, idx - halfWindow);
  const right = Math.min(signal.length - 1, idx + halfWindow);
  let localMin = signal[idx];
  for (let j = left; j <= right; j++) {
    if (signal[j] < localMin) localMin = signal[j];
  }
  return signal[idx] - localMin;
}
