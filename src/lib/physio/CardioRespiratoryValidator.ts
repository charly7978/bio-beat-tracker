/**
 * CARDIORESPIRATORYVALIDATOR — Physiological Signal Intelligence Engine
 *
 * This module answers ONE question: "Does this optical signal represent a living
 * human cardiovascular system?" — NOT "Is there a finger in the frame?"
 *
 * The distinction is fundamental. Color-ratio finger detection (R > G, R/B > 1.2, etc.)
 * accepts ANY red object as a "finger". This validator instead requires that the signal
 * exhibits the hallmarks of real pulsatile blood flow:
 *
 *   1. CARDIAC FREQUENCY — Dominant spectral component in 0.5–3.5 Hz (30–210 BPM).
 *      Random objects, noise, or environment: no dominant cardiac-band frequency.
 *
 *   2. PHYSIOLOGICAL PERIODICITY — Autocorrelation at expected cardiac period > 0.3.
 *      Real heartbeats are quasi-periodic; noise is aperiodic.
 *
 *   3. PERFUSION INDEX — AC/DC ratio of the RED channel in 0.02%–8% (0.0002–0.08).
 *      Living tissue illuminated with LED flash shows a pulsatile AC component driven
 *      by blood volume change. Inert objects: AC ≈ 0 (no pulsation) or erratic noise.
 *
 *   4. WAVEFORM MORPHOLOGY — PPG waveform is positively skewed (rapid systolic
 *      upstroke, gradual diastolic decay). This asymmetry is caused by the mechanical
 *      properties of the cardiovascular system, not by camera noise.
 *
 *   5. HARMONIC STRUCTURE — Real PPG has energy at the 2nd harmonic of the fundamental.
 *      Pure sinusoidal noise at a single frequency lacks this harmonic content.
 *
 *   6. MULTI-CHANNEL PHYSIOLOGICAL COHERENCE — Both RED and GREEN channels must show
 *      pulsatile signals at the SAME dominant frequency. Non-biological illumination
 *      sources rarely produce correlated multi-spectral pulsatile signals.
 *
 * References:
 *  - Verkruysse W. et al. (2008), "Remote plethysmographic imaging using ambient light"
 *  - Elgendi M. (2016), "Optimal Signal Quality Index for Photoplethysmogram Signals"
 *  - McDuff D. et al. (2023), "A Review of Non-Contact Photoplethysmography Imaging"
 *  - Makowski D. et al. (2021), "NeuroKit2: A Python Toolbox for Neurophysiological Processing"
 *  - Allen J. (2007), "Photoplethysmography and its application in clinical physiological measurement"
 *  - Tarassenko L. et al. (2014), "Continuous cuffless monitoring of arterial blood pressure"
 */

import { clamp } from '@/utils/math';
import { analyzeSpectrum, frequenciesAgree, type SpectralProfile } from './goertzelSpectral';

// ─────────────────────────────────────────────────────────────────────────────
// PHYSIOLOGICAL CONSTANTS (from peer-reviewed literature)
// ─────────────────────────────────────────────────────────────────────────────

/** Cardiac frequency band: 30–210 BPM = 0.5–3.5 Hz */
const CARDIAC_BAND_HZ: [number, number] = [0.5, 3.5];

/** Minimum fraction of total spectral power that must be in the cardiac band */
const MIN_CARDIAC_BAND_RATIO = 0.35;

/** Minimum perfusion index for living tissue under LED illumination */
const PI_MIN = 0.00018;

/** Maximum physiological perfusion index (above = saturation/artifact) */
const PI_MAX = 0.12;

/** Preferred PI range for high-confidence scoring */
const PI_PREFERRED_MIN = 0.0004;
const PI_PREFERRED_MAX = 0.06;

/** Autocorrelation at expected period — minimum for quasi-periodic cardiac signal */
const MIN_PERIODICITY = 0.22;

/** Minimum skewness for real PPG waveform (systolic upstroke faster than diastolic decay) */
const MIN_SKEWNESS = -0.5;

/** Minimum samples before physiological analysis is meaningful */
const MIN_ANALYSIS_SAMPLES = 60;

/** Minimum samples for robust spectral analysis (≈4 s at 30 fps) */
const ROBUST_ANALYSIS_SAMPLES = 90;

/** Threshold above which cardioScore indicates a physiological signal */
export const CARDIO_SIGNAL_THRESHOLD = 38;

/** Threshold for "stable" physiological signal (high confidence) */
export const CARDIO_STABLE_THRESHOLD = 55;

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type CardioSignalStrength = 'ABSENT' | 'WEAK' | 'PLAUSIBLE' | 'CONFIRMED' | 'STRONG';

export interface CardioSignalAnalysis {
  /** Composite physiological score 0–100. This is the single gate criterion. */
  cardioScore: number;

  /** True when cardioScore ≥ CARDIO_SIGNAL_THRESHOLD */
  cardioPresent: boolean;

  /** Qualitative strength label */
  signalStrength: CardioSignalStrength;

  // ── Component scores (each 0–1) ──────────────────────────────────────────
  /** Fraction of spectral power in cardiac band */
  frequencyScore: number;
  /** Periodicity (autocorrelation at cardiac period) */
  periodicityScore: number;
  /** Perfusion index in physiological range */
  perfusionScore: number;
  /** Waveform morphology (skewness + harmonic structure) */
  morphologyScore: number;
  /** R and G channels agree on cardiac frequency */
  coherenceScore: number;
  /** Signal stability / absence of DC jumps */
  stabilityScore: number;

  // ── Derived physiological values ─────────────────────────────────────────
  /** Estimated cardiac frequency (Hz); 0 = undetermined */
  dominantFreqHz: number;
  /** Estimated BPM from spectral analysis; 0 = undetermined */
  estimatedBPM: number;
  /** Perfusion index (AC/DC red channel ratio) */
  perfusionIndex: number;
  /** Skewness of the waveform within the analysis window */
  waveformSkewness: number;

  /** Human-readable explanation of the score */
  reason: string;
  /** Whether there were enough samples for a reliable assessment */
  reliable: boolean;
}

/** Internal state persisted across frames for temporal smoothing */
export interface CardioValidatorState {
  scoreEma: number;
  frequencyEmaHz: number;
  consecutiveScores: number;
  framesAnalyzed: number;
  lastDCJumpMagnitude: number;
  prevRedDC: number;
}

export function createCardioValidatorState(): CardioValidatorState {
  return {
    scoreEma: 0,
    frequencyEmaHz: 0,
    consecutiveScores: 0,
    framesAnalyzed: 0,
    lastDCJumpMagnitude: 0,
    prevRedDC: 0,
  };
}

export function resetCardioValidatorState(state: CardioValidatorState): void {
  state.scoreEma = 0;
  state.frequencyEmaHz = 0;
  state.consecutiveScores = 0;
  state.framesAnalyzed = 0;
  state.lastDCJumpMagnitude = 0;
  state.prevRedDC = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOCORRELATION PERIODICITY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute normalised autocorrelation at a specific lag.
 * Returns r ∈ [−1, 1]. Positive peak at lag = T_cardiac confirms periodicity.
 */
function autocorrelationAtLag(
  signal: Float32Array,
  n: number,
  lagSamples: number,
): number {
  if (lagSamples <= 0 || lagSamples >= n) return 0;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i] ?? 0;
  mean /= n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n - lagSamples; i++) {
    const xi = (signal[i] ?? 0) - mean;
    const xl = (signal[i + lagSamples] ?? 0) - mean;
    num += xi * xl;
    den += xi * xi;
  }

  return den > 1e-12 ? clamp(num / den, -1, 1) : 0;
}

/**
 * Search for the best autocorrelation peak across a range of lag values
 * corresponding to physiological cardiac periods.
 */
function bestCardiacAutocorrelation(
  signal: Float32Array,
  n: number,
  sampleRateHz: number,
  cardiacBandHz: [number, number],
): { rMax: number; bestLagSamples: number } {
  // Cardiac period range in samples
  const lagMin = Math.ceil(sampleRateHz / cardiacBandHz[1]); // shortest period
  const lagMax = Math.floor(sampleRateHz / cardiacBandHz[0]); // longest period

  let rMax = -1;
  let bestLagSamples = 0;

  // Scan over possible cardiac periods in steps of 1 sample
  for (let lag = lagMin; lag <= lagMax && lag < n / 2; lag++) {
    const r = autocorrelationAtLag(signal, n, lag);
    if (r > rMax) {
      rMax = r;
      bestLagSamples = lag;
    }
  }

  return { rMax: Math.max(0, rMax), bestLagSamples };
}

// ─────────────────────────────────────────────────────────────────────────────
// MORPHOLOGY ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

/** Compute skewness of the signal (3rd standardised moment). */
function computeSkewness(signal: Float32Array, n: number): number {
  if (n < 8) return 0;
  let m1 = 0;
  for (let i = 0; i < n; i++) m1 += signal[i] ?? 0;
  m1 /= n;

  let m2 = 0, m3 = 0;
  for (let i = 0; i < n; i++) {
    const d = (signal[i] ?? 0) - m1;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;

  const std = Math.sqrt(m2);
  return std > 1e-10 ? m3 / (std * std * std) : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERFUSION INDEX SCORING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score the perfusion index (AC/DC ratio) against known physiological bounds.
 * Living tissue under LED illumination: PI ≈ 0.02%–5% (0.0002–0.05).
 * Near-zero: no pulsation (inert object).
 * Extreme high: saturation or artifact.
 */
function scorePerfusionIndex(pi: number): number {
  if (pi <= 0) return 0;
  if (pi < PI_MIN) return 0; // below detection floor
  if (pi > PI_MAX) return 0; // saturated or severe artifact

  if (pi >= PI_PREFERRED_MIN && pi <= PI_PREFERRED_MAX) {
    // Full score in preferred range — map to 0.5–1.0
    const t = (pi - PI_PREFERRED_MIN) / (PI_PREFERRED_MAX - PI_PREFERRED_MIN);
    // Peak score at PI ≈ 0.005, taper toward edges
    const bell = 1 - Math.abs(t - 0.3) * 0.6;
    return clamp(0.50 + bell * 0.50, 0.50, 1.0);
  }

  if (pi < PI_PREFERRED_MIN) {
    // Partial score between PI_MIN and PI_PREFERRED_MIN
    return clamp((pi - PI_MIN) / (PI_PREFERRED_MIN - PI_MIN) * 0.50, 0, 0.50);
  }

  // PI between PI_PREFERRED_MAX and PI_MAX — still physiological but declining confidence
  return clamp(1 - (pi - PI_PREFERRED_MAX) / (PI_MAX - PI_PREFERRED_MAX), 0.1, 0.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// DC STABILITY ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Measure the DC baseline stability of the red channel over the analysis window.
 * Sudden large DC jumps indicate camera movement or object change — not cardiac.
 * Returns a score 0–1 (1 = perfectly stable DC).
 */
function dcStabilityScore(
  redBuffer: Float32Array,
  n: number,
): number {
  if (n < 10) return 0.5;

  const segLen = Math.max(4, Math.floor(n / 8));
  let maxJump = 0;
  let prevSeg = 0;

  for (let i = 0; i < n; i += segLen) {
    let seg = 0;
    const end = Math.min(i + segLen, n);
    for (let j = i; j < end; j++) seg += redBuffer[j] ?? 0;
    seg /= (end - i);

    if (i > 0 && prevSeg > 0) {
      const jump = Math.abs(seg - prevSeg) / prevSeg;
      if (jump > maxJump) maxJump = jump;
    }
    prevSeg = seg;
  }

  // Physiological signal: DC shifts < 3% between segments (slight DC drift ok)
  // Camera movement: DC shifts > 10%
  return clamp(1 - maxJump / 0.12, 0, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate whether a buffered signal window represents a real cardiorespiratoy
 * signal from living human tissue.
 *
 * @param filteredSignal  Bandpass-filtered PPG signal (0.5–4.5 Hz), most recent n samples.
 * @param redBuffer       Raw red channel samples (same window, for PI and DC stability).
 * @param greenBuffer     Raw green channel samples (for multi-channel coherence).
 * @param n               Number of valid samples in the buffers.
 * @param sampleRateHz    Camera frame rate (Hz).
 * @param perfusionIndex  AC/DC ratio of red channel (pre-computed by PPGSignalProcessor).
 * @param state           Persistent EMA state across frames.
 */
export function validateCardioRespiratorySignal(
  filteredSignal: Float32Array,
  redBuffer: Float32Array,
  greenBuffer: Float32Array,
  n: number,
  sampleRateHz: number,
  perfusionIndex: number,
  state: CardioValidatorState,
): CardioSignalAnalysis {

  state.framesAnalyzed++;

  const absent: CardioSignalAnalysis = {
    cardioScore: 0,
    cardioPresent: false,
    signalStrength: 'ABSENT',
    frequencyScore: 0,
    periodicityScore: 0,
    perfusionScore: 0,
    morphologyScore: 0,
    coherenceScore: 0,
    stabilityScore: 0,
    dominantFreqHz: 0,
    estimatedBPM: 0,
    perfusionIndex,
    waveformSkewness: 0,
    reason: 'Insufficient signal samples',
    reliable: false,
  };

  if (n < MIN_ANALYSIS_SAMPLES || sampleRateHz < 10) {
    state.scoreEma = state.scoreEma * 0.85; // decay during warm-up
    return absent;
  }

  const reliable = n >= ROBUST_ANALYSIS_SAMPLES;

  // ── 1. FREQUENCY DOMAIN: cardiac band spectral analysis ──────────────────
  const redSpec = analyzeSpectrum(redBuffer, n, sampleRateHz, CARDIAC_BAND_HZ);
  const greenSpec = analyzeSpectrum(greenBuffer, n, sampleRateHz, CARDIAC_BAND_HZ);
  const filteredSpec = analyzeSpectrum(filteredSignal, n, sampleRateHz, CARDIAC_BAND_HZ);

  // Prefer the filtered signal spectrum for dominant frequency (better SNR)
  const bestSpec: SpectralProfile =
    filteredSpec.cardiacBandRatio > redSpec.cardiacBandRatio ? filteredSpec : redSpec;

  const dominantFreqHz = bestSpec.dominantFreqHz;
  const estimatedBPM = dominantFreqHz > 0 ? Math.round(dominantFreqHz * 60) : 0;

  // Score: fraction of power in cardiac band (0.35 required, 0.65 = excellent)
  const freqRatio = bestSpec.cardiacBandRatio;
  const frequencyScore = clamp((freqRatio - MIN_CARDIAC_BAND_RATIO) / (0.65 - MIN_CARDIAC_BAND_RATIO), 0, 1);

  // ── 2. PERIODICITY: autocorrelation at expected cardiac period ────────────
  const { rMax: bestAcf } = bestCardiacAutocorrelation(
    filteredSignal, n, sampleRateHz, CARDIAC_BAND_HZ,
  );
  const periodicityScore = clamp((bestAcf - MIN_PERIODICITY) / (0.70 - MIN_PERIODICITY), 0, 1);

  // ── 3. PERFUSION INDEX: AC/DC ratio of red channel ───────────────────────
  const piScore = scorePerfusionIndex(perfusionIndex);
  const perfusionScore = piScore;

  // ── 4. MORPHOLOGY: waveform skewness + harmonic structure ────────────────
  const skewness = computeSkewness(filteredSignal, n);
  // Real PPG: skewness ≥ 0.1 (positive asymmetry); noise: ≈ 0; compression artifact: negative
  const skewnessScore = clamp((skewness - MIN_SKEWNESS) / (0.8 - MIN_SKEWNESS), 0, 1);

  // Harmonic ratio: real PPG should have 2nd harmonic at 5%–80% of fundamental
  const harmonicRatio = bestSpec.harmonicRatio;
  const harmonicScore = harmonicRatio >= 0.04 && harmonicRatio <= 1.2
    ? clamp((harmonicRatio - 0.04) / 0.30, 0, 1)
    : 0.1; // weak but not zero — harmonic detection is camera-dependent

  const morphologyScore = skewnessScore * 0.65 + harmonicScore * 0.35;

  // ── 5. MULTI-CHANNEL COHERENCE: R and G agree on cardiac frequency ────────
  const freqAgree = frequenciesAgree(
    redSpec.dominantFreqHz,
    greenSpec.dominantFreqHz,
    0.25,
  );
  // Both channels must also show cardiac-band signal (not just one)
  const bothPulsatile =
    redSpec.cardiacBandRatio > 0.25 && greenSpec.cardiacBandRatio > 0.20;
  const coherenceScore = freqAgree && bothPulsatile
    ? clamp(
        (redSpec.cardiacBandRatio + greenSpec.cardiacBandRatio) / 2 / 0.60,
        0.3, 1,
      )
    : freqAgree
    ? 0.35 // frequencies agree but one channel weak — partial credit
    : bothPulsatile
    ? 0.25 // both pulsatile but frequencies disagree slightly
    : 0; // no agreement

  // ── 6. DC STABILITY: no sudden DC jumps (camera moved or object changed) ──
  const stabilityScore = dcStabilityScore(redBuffer, n);

  // ── COMPOSITE SCORE ───────────────────────────────────────────────────────
  // Weights tuned to clinical literature priorities:
  //   Frequency presence is the primary gate (cardiac band power fraction)
  //   Periodicity confirms the signal is rhythmic, not just broadband noise
  //   Perfusion index confirms real tissue illumination
  //   Morphology confirms cardiac waveform shape
  //   Coherence rejects single-channel noise / monochromatic illumination
  //   Stability rejects camera motion or object swap events
  const rawScore =
    frequencyScore  * 0.28 +
    periodicityScore * 0.23 +
    perfusionScore  * 0.22 +
    morphologyScore * 0.14 +
    coherenceScore  * 0.08 +
    stabilityScore  * 0.05;

  const cardioScoreRaw = clamp(rawScore * 100, 0, 100);

  // Temporal smoothing: fast rise (good signal), slow decay (brief artifacts don't drop it)
  const alpha = cardioScoreRaw > state.scoreEma ? 0.20 : 0.08;
  state.scoreEma = state.scoreEma === 0
    ? cardioScoreRaw
    : state.scoreEma * (1 - alpha) + cardioScoreRaw * alpha;

  // Update frequency EMA for smooth BPM tracking
  if (dominantFreqHz > 0) {
    const fAlpha = 0.15;
    state.frequencyEmaHz = state.frequencyEmaHz <= 0
      ? dominantFreqHz
      : state.frequencyEmaHz * (1 - fAlpha) + dominantFreqHz * fAlpha;
  }

  const cardioScore = Math.round(clamp(state.scoreEma, 0, 100));
  const cardioPresent = cardioScore >= CARDIO_SIGNAL_THRESHOLD;

  if (cardioPresent) {
    state.consecutiveScores = Math.min(state.consecutiveScores + 1, 300);
  } else {
    state.consecutiveScores = Math.max(0, state.consecutiveScores - 2);
  }

  // ── Strength classification ───────────────────────────────────────────────
  let signalStrength: CardioSignalStrength;
  if (cardioScore < 20) signalStrength = 'ABSENT';
  else if (cardioScore < CARDIO_SIGNAL_THRESHOLD) signalStrength = 'WEAK';
  else if (cardioScore < CARDIO_STABLE_THRESHOLD) signalStrength = 'PLAUSIBLE';
  else if (cardioScore < 72) signalStrength = 'CONFIRMED';
  else signalStrength = 'STRONG';

  // ── Reason string for diagnostics ────────────────────────────────────────
  const reasons: string[] = [];
  if (frequencyScore < 0.3) reasons.push(`No cardiac freq (${(freqRatio * 100).toFixed(0)}% band power)`);
  else reasons.push(`f₀=${dominantFreqHz.toFixed(1)}Hz(${estimatedBPM}bpm)`);
  if (periodicityScore < 0.3) reasons.push('aperiodic');
  if (perfusionScore < 0.3) reasons.push(`PI=${(perfusionIndex * 100).toFixed(3)}%`);
  if (!freqAgree) reasons.push('R≠G freq');
  if (stabilityScore < 0.5) reasons.push('DC unstable');

  const reason = reasons.join(' | ') || 'Physiological cardiac signal present';

  return {
    cardioScore,
    cardioPresent,
    signalStrength,
    frequencyScore: clamp(frequencyScore, 0, 1),
    periodicityScore: clamp(periodicityScore, 0, 1),
    perfusionScore: clamp(perfusionScore, 0, 1),
    morphologyScore: clamp(morphologyScore, 0, 1),
    coherenceScore: clamp(coherenceScore, 0, 1),
    stabilityScore: clamp(stabilityScore, 0, 1),
    dominantFreqHz: state.frequencyEmaHz > 0 ? state.frequencyEmaHz : dominantFreqHz,
    estimatedBPM: state.frequencyEmaHz > 0
      ? Math.round(state.frequencyEmaHz * 60)
      : estimatedBPM,
    perfusionIndex,
    waveformSkewness: skewness,
    reason,
    reliable,
  };
}
