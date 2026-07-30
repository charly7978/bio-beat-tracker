/**
 * Detector de picos PPG inspirado en Hamilton & Tompkins (2002),
 * adaptado para señal PPG (no ECG). Usa derivada + energía + umbrales
 * adaptativos con search-back para latidos perdidos.
 *
 * Complementa Elgendi: donde Elgendi usa energía cuadrada + bloques de
 * interés, Hamilton usa pendiente (derivada) + tracking de nivel señal/ruido.
 */
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { clamp } from '../../../utils/math';
import {
  bandpassOffline,
  detrendLinear,
  hampel1D,
  prepareUniformPpgWindow,
  robustNormalizeZeroCenter,
} from '../shared/dsp';

export interface HamiltonPPGInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  sqi?: number;
  minBpm?: number;
  maxBpm?: number;
}

export interface HamiltonPPGOutput {
  peaks: number[];
  peakTimes: number[];
  confidence: number;
  diagnostics: Record<string, unknown>;
}

/**
 * Media móvil deslizante O(n) con suma acumulativa.
 */
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
    if (addIdx < n) { sum += addIdx < n ? x[addIdx] : 0; c++; }
    out[i] = c > 0 ? sum / c : x[i];
  }
}

export class HamiltonPPG {
  static detect(input: HamiltonPPGInput): HamiltonPPGOutput {
    const minBpm = input.minBpm ?? PEAK_DETECTION_DEFAULTS.minBpm;
    const maxBpm = input.maxBpm ?? PEAK_DETECTION_DEFAULTS.maxBpm;
    const nSig = input.signal.length;

    if (nSig !== input.timestampsMs.length || nSig < PEAK_DETECTION_DEFAULTS.minSamplesEnsemble) {
      return { peaks: [], peakTimes: [], confidence: 0, diagnostics: { reason: 'INSUFFICIENT_WINDOW' } };
    }

    const uniform = prepareUniformPpgWindow(input.signal, input.timestampsMs, input.samplingRateHz);
    const sig = uniform.signal;
    const ts = uniform.timestampsMs;
    const fs = uniform.samplingRateHz;
    const n = sig.length;

    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(sig[i])) {
        return { peaks: [], peakTimes: [], confidence: 0, diagnostics: { nonFinite: true } };
      }
    }

    // 1. Pre-processing: Hampel + detrend + bandpass + normalize
    const hampelWin = Math.max(5, Math.round(fs * 0.25) | 1);
    const cleaned = hampel1D(sig, hampelWin, 3);
    let x = bandpassOffline(detrendLinear(cleaned), fs);
    x = robustNormalizeZeroCenter(x);

    // 2. Derivative (slope information) — detects sharp systolic peaks
    const deriv = new Array<number>(n);
    for (let i = 1; i < n - 1; i++) {
      deriv[i] = (x[i + 1] - x[i - 1]) * 0.5;
    }
    deriv[0] = 0;
    deriv[n - 1] = 0;

    // 3. Squared derivative (energy of slope)
    const derivSq = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      derivSq[i] = deriv[i] * deriv[i];
    }

    // 4. Moving window integration (~150ms = QRS-like duration for PPG systolic peak)
    const integrationWin = Math.max(3, Math.round(fs * 0.15));
    const integrated = new Array<number>(n);
    slidingMA(derivSq, integrationWin, integrated);

    // 5. Adaptive threshold (Hamilton-style)
    const minDist = Math.max(1, Math.round((60000 / maxBpm / 1000) * fs));
    const maxDist = Math.max(minDist + 1, Math.round((60000 / minBpm / 1000) * fs));

    // Initialize signal/noise levels from first 2 seconds
    const initLen = Math.min(n, Math.round(fs * 2));
    let initMax = 0;
    for (let i = 0; i < initLen; i++) {
      if (integrated[i] > initMax) initMax = integrated[i];
    }
    let signalLevel = initMax * 0.25;
    let noiseLevel = initMax * 0.1;

    // Threshold: THR = noiseLevel + 0.25 * (signalLevel - noiseLevel)
    const getThreshold = () => noiseLevel + 0.25 * (signalLevel - noiseLevel);

    // 6. Find peaks in integrated signal with adaptive threshold
    const peaks: number[] = [];
    const peakTimes: number[] = [];
    let lastPeakIdx = -maxDist;

    // Search-back parameters
    const rrHistory: number[] = [];
    let lastPeakForSearchBack = -1;

    for (let i = Math.round(fs * 0.5); i < n; i++) {
      // Check if this is a local maximum
      if (i > 0 && i < n - 1 && integrated[i] <= integrated[i - 1]) continue;
      if (i < n - 1 && integrated[i] <= integrated[i + 1]) continue;

      const thr = getThreshold();

      if (integrated[i] >= thr) {
        // Distance check
        const distFromLast = i - lastPeakIdx;
        if (distFromLast < minDist) {
          // Keep the larger peak
          if (peaks.length > 0 && integrated[i] > integrated[peaks[peaks.length - 1]!]) {
            peaks[peaks.length - 1] = i;
            peakTimes[peakTimes.length - 1] = ts[i] ?? ts[ts.length - 1];
          }
          continue;
        }
        if (distFromLast > maxDist) {
          // Too far — check search-back
          if (lastPeakForSearchBack >= 0) {
            // Find max in [lastPeak + minDist, i]
            let searchMax = 0;
            let searchIdx = lastPeakForSearchBack;
            for (let j = lastPeakForSearchBack + minDist; j <= i; j++) {
              if (integrated[j] > searchMax) {
                searchMax = integrated[j];
                searchIdx = j;
              }
            }
            if (searchMax >= thr * 0.5) {
              peaks.push(searchIdx);
              peakTimes.push(ts[searchIdx] ?? ts[ts.length - 1]);
              lastPeakIdx = searchIdx;
              rrHistory.push((ts[i] ?? 0) - (ts[searchIdx] ?? 0));
              signalLevel = 0.125 * searchMax + 0.875 * signalLevel;
            }
          }
        }

        // Accept peak
        peaks.push(i);
        peakTimes.push(ts[i] ?? ts[ts.length - 1]);
        rrHistory.push(distFromLast * (1000 / fs));
        signalLevel = 0.125 * integrated[i] + 0.875 * signalLevel;
        lastPeakIdx = i;
        lastPeakForSearchBack = i;
      } else {
        // Noise peak
        noiseLevel = 0.125 * integrated[i] + 0.875 * noiseLevel;
      }
    }

    // 7. Compute confidence
    let confidence = 0;
    if (peaks.length >= 2) {
      const meanRR = rrHistory.reduce((a, b) => a + b, 0) / rrHistory.length;
      let varRR = 0;
      for (const rr of rrHistory) varRR += (rr - meanRR) * (rr - meanRR);
      const cv = Math.sqrt(varRR / rrHistory.length) / Math.max(1, meanRR);
      const regularity = clamp(1 - cv / 0.35, 0, 1);
      confidence = clamp(
        peaks.length / 8 * 0.3 +
        regularity * 0.4 +
        clamp(signalLevel / Math.max(1, signalLevel + noiseLevel), 0, 1) * 0.3,
        0, 1
      );
    }

    if (typeof input.sqi === 'number' && input.sqi < PEAK_DETECTION_DEFAULTS.minSQI) {
      confidence *= 0.5;
    }

    return {
      peaks,
      peakTimes,
      confidence,
      diagnostics: {
        fs,
        nPeaks: peaks.length,
        signalLevel,
        noiseLevel,
        snr: signalLevel / Math.max(1e-9, noiseLevel),
        resampled: uniform.resampled,
      },
    };
  }
}
