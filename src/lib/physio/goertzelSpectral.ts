/**
 * GOERTZEL SPECTRAL ANALYZER FOR CARDIAC PPG
 *
 * Implements efficient Goertzel DFT at specific cardiac frequencies (0.5–3.5 Hz).
 * Unlike a full FFT, Goertzel targets only the frequency bins we care about,
 * making it O(N·K) where K ≪ N — ideal for real-time embedded DSP on mobile.
 *
 * References:
 *  - Goertzel G. (1958), "An Algorithm for the Evaluation of Finite Trigonometric Series"
 *  - Elgendi M. (2016), "Optimal Signal Quality Index for Photoplethysmogram Signals"
 *  - Makowski D. et al. (2021), "NeuroKit2: A Python Toolbox for Neurophysiological Signal Processing"
 */

import { clamp } from '@/utils/math';

export interface SpectralProfile {
  /** Dominant frequency in the cardiac band (Hz). 0 if undetermined. */
  dominantFreqHz: number;
  /** Power at the dominant frequency (arbitrary units²). */
  dominantPower: number;
  /** Total spectral power across 0.2–5.0 Hz. */
  totalPower: number;
  /** Sum of power in the cardiac band [0.5–3.5 Hz]. */
  cardiacBandPower: number;
  /** Fraction of total power in cardiac band (0–1). Key physiological gate criterion. */
  cardiacBandRatio: number;
  /** Ratio of cardiac-band power to non-cardiac noise power. */
  snr: number;
  /** Second harmonic power (should exist in real PPG — 2× fundamental). */
  harmonicPower: number;
  /** Harmonic-to-fundamental ratio (real PPG: 0.05–0.8). */
  harmonicRatio: number;
}

/**
 * Goertzel DFT at a single target frequency.
 * Returns raw power (not normalised — use for relative comparisons).
 */
export function goertzelPower(
  samples: Float32Array,
  n: number,
  targetFreqHz: number,
  sampleRateHz: number,
): number {
  if (n < 2 || sampleRateHz <= 0) return 0;
  // Nyquist check
  if (targetFreqHz > sampleRateHz / 2) return 0;

  const k = (n * targetFreqHz) / sampleRateHz;
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;

  for (let i = 0; i < n; i++) {
    const s0 = (samples[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  // |X(k)|² = s1² + s2² − s1·s2·coeff
  return s1 * s1 + s2 * s2 - s1 * s2 * coeff;
}

/** Hamming window to reduce spectral leakage. Applied in-place to a scratch buffer. */
function applyHammingWindow(out: Float32Array, src: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) {
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = (src[i] ?? 0) * w;
  }
}

/** Pre-allocated scratch to avoid GC pressure on every analysis call. */
const _windowedScratch = new Float32Array(512);

/**
 * Full spectral profile of a PPG signal window.
 *
 * Scans 0.2–5.0 Hz in 0.1 Hz steps. Finds the dominant frequency inside
 * the cardiac band [cardiacBandHz] and characterises the quality of the
 * spectral peak (bandwidth, harmonics, SNR).
 *
 * @param samples  Float32Array of mean-centered signal values.
 * @param n        Number of samples to use (≤ samples.length).
 * @param sampleRateHz  Estimated camera frame rate (typically 25–33 Hz).
 * @param cardiacBandHz [lo, hi] of the expected cardiac frequency range (Hz).
 */
export function analyzeSpectrum(
  samples: Float32Array,
  n: number,
  sampleRateHz: number,
  cardiacBandHz: [number, number] = [0.5, 3.5],
  freqStepHz = 0.1,
): SpectralProfile {
  const empty: SpectralProfile = {
    dominantFreqHz: 0,
    dominantPower: 0,
    totalPower: 0,
    cardiacBandPower: 0,
    cardiacBandRatio: 0,
    snr: 0,
    harmonicPower: 0,
    harmonicRatio: 0,
  };

  if (n < 30 || sampleRateHz <= 0) return empty;

  // Mean-center: remove DC component
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i] ?? 0;
  mean /= n;

  const sz = Math.min(n, _windowedScratch.length);
  const windowed = _windowedScratch.subarray(0, sz);

  // Copy and window
  const tmp = new Float32Array(sz);
  for (let i = 0; i < sz; i++) tmp[i] = (samples[i] ?? 0) - mean;
  applyHammingWindow(windowed, tmp, sz);

  let totalPower = 0;
  let cardiacBandPower = 0;
  let dominantPower = 0;
  let dominantFreqHz = 0;

  for (let f = 0.2; f <= 5.0 + 1e-9; f += freqStepHz) {
    const fRound = Math.round(f * 10) / 10; // avoid fp drift
    const p = goertzelPower(windowed, sz, fRound, sampleRateHz);
    totalPower += p;

    if (fRound >= cardiacBandHz[0] && fRound <= cardiacBandHz[1]) {
      cardiacBandPower += p;
      if (p > dominantPower) {
        dominantPower = p;
        dominantFreqHz = fRound;
      }
    }
  }

  const cardiacBandRatio = totalPower > 1e-12 ? cardiacBandPower / totalPower : 0;
  const noisePower = Math.max(1e-12, totalPower - cardiacBandPower);
  const snr = cardiacBandPower / noisePower;

  // Harmonic check: real PPG has energy at 2× fundamental (breathing modulation removed)
  let harmonicPower = 0;
  const f2 = dominantFreqHz * 2;
  if (dominantFreqHz > 0 && f2 <= 5.0) {
    harmonicPower = goertzelPower(windowed, sz, Math.min(f2, 5.0), sampleRateHz);
  }
  const harmonicRatio = dominantPower > 1e-12 ? harmonicPower / dominantPower : 0;

  return {
    dominantFreqHz,
    dominantPower,
    totalPower,
    cardiacBandPower,
    cardiacBandRatio: clamp(cardiacBandRatio, 0, 1),
    snr: clamp(snr, 0, 20),
    harmonicPower,
    harmonicRatio: clamp(harmonicRatio, 0, 2),
  };
}

/**
 * Compute power spectral density at the respiratory band (0.1–0.5 Hz).
 * Returns the dominant respiratory frequency and its fractional power.
 */
export function analyzeRespiratoryBand(
  samples: Float32Array,
  n: number,
  sampleRateHz: number,
): { dominantFreqHz: number; bandPower: number; totalPower: number; bandRatio: number } {
  if (n < 60 || sampleRateHz <= 0) {
    return { dominantFreqHz: 0, bandPower: 0, totalPower: 0, bandRatio: 0 };
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i] ?? 0;
  mean /= n;

  const sz = Math.min(n, _windowedScratch.length);
  const windowed = _windowedScratch.subarray(0, sz);
  const tmp = new Float32Array(sz);
  for (let i = 0; i < sz; i++) tmp[i] = (samples[i] ?? 0) - mean;
  applyHammingWindow(windowed, tmp, sz);

  let totalPower = 0;
  let bandPower = 0;
  let dominantPower = 0;
  let dominantFreqHz = 0;

  for (let f = 0.05; f <= 2.0 + 1e-9; f += 0.05) {
    const fRound = Math.round(f * 20) / 20;
    const p = goertzelPower(windowed, sz, fRound, sampleRateHz);
    totalPower += p;
    if (fRound >= 0.1 && fRound <= 0.5) {
      bandPower += p;
      if (p > dominantPower) {
        dominantPower = p;
        dominantFreqHz = fRound;
      }
    }
  }

  const bandRatio = totalPower > 1e-12 ? bandPower / totalPower : 0;
  return { dominantFreqHz, bandPower, totalPower, bandRatio: clamp(bandRatio, 0, 1) };
}

/**
 * Check if two frequency-domain profiles share the same dominant cardiac frequency
 * within ±toleranceHz. Used to validate multi-channel agreement (R and G channels
 * must both pulsate at the same cardiac frequency — non-biological signals rarely do).
 */
export function frequenciesAgree(
  freqA: number,
  freqB: number,
  toleranceHz = 0.2,
): boolean {
  if (freqA <= 0 || freqB <= 0) return false;
  return Math.abs(freqA - freqB) <= toleranceHz;
}
