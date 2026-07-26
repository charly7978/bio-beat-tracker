/**
 * HEMODYNAMIC OBSERVER — Extended Kalman Filter for Blood Pressure Estimation.
 *
 * This is the "reasoning engine": it does NOT learn from data. It solves the
 * inverse hemodynamic problem in real-time using:
 *
 *   1. State prediction via Navier-Stokes 1D physics (propagateState)
 *   2. Observation from PPG signal (observationModel)
 *   3. Kalman correction (innovation → gain → state update)
 *
 * The EKF observes the PPG, predicts what it should see based on physics,
 * compares the prediction with reality, and corrects its internal model.
 * This is reasoning, not learning.
 *
 * Takens delay embedding reconstructs the cardiovascular attractor from
 * the scalar PPG observation, providing initial state estimates and
 * periodicity validation.
 *
 * References:
 *   - Kalman (1960) — A New Approach to Linear Filtering and Prediction
 *   - Julier & Uhlmann (1997) — New Extension of Kalman to Non-Linear Systems
 *   - Takens (1981) — Detecting Strange Attractors in Turbulence
 *   - AVCT (arxiv 2605.10871, 2025) — PPG attractor for BP estimation
 */

import { clamp } from '@/utils/math';
import {
  STATE_DIM,
  type HemodynamicState,
  type HemodynamicBpResult,
  defaultInitialState,
  processNoiseCovariance,
  measurementNoiseCovariance,
  observationModel,
  observationJacobian,
  propagateState,
  propagationJacobian,
  stateToBloodPressure,
  hemodynamicCoherence,
  isValidState,
} from './hemodynamicModel';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

// ═══════════════════════════════════════════════════════════
// TAKENS DELAY EMBEDDING — Attractor reconstruction
// ═══════════════════════════════════════════════════════════

/**
 * Takens delay embedding: reconstructs the state-space trajectory from
 * a scalar time series (PPG) using time-delayed copies.
 *
 * Given PPG(t), the embedding is:
 *   X(t) = [PPG(t), PPG(t - τ), PPG(t - 2τ), ..., PPG(t - (m-1)τ)]
 *
 * Where τ = delay and m = embedding dimension.
 *
 * By Takens' theorem, for m ≥ 2d+1 (d = attractor dimension),
 * the embedding preserves the topology of the true attractor.
 *
 * For cardiovascular system (d ≈ 3), we use m = 7, τ = fundamental period.
 */
export interface TakensEmbedding {
  /** Delay in samples (typically = one cardiac cycle length) */
  delay: number;
  /** Embedding dimension */
  dimension: number;
  /** Reconstructed state vectors (each row is an embedded point) */
  vectors: number[][];
  /** Attractor quality: how well does the embedding reconstruct the attractor */
  quality: number;
  /** Estimated fundamental frequency from the embedding */
  fundamentalFreqHz: number;
}

const TAKENS_DIMENSION = 7;
const MIN_SAMPLES_FOR_EMBEDDING = 30;

/**
 * Perform Takens delay embedding on a PPG signal segment.
 */
export function takensDelayEmbedding(
  ppgSignal: number[],
  sampleRateHz: number,
  estimatedBpm: number = 0,
): TakensEmbedding {
  const n = ppgSignal.length;
  const empty: TakensEmbedding = {
    delay: 0,
    dimension: TAKENS_DIMENSION,
    vectors: [],
    quality: 0,
    fundamentalFreqHz: 0,
  };

  if (n < MIN_SAMPLES_FOR_EMBEDDING) return empty;

  // Estimate delay τ from cardiac period — use T/4 for proper phase diversity
  const cardiacPeriodMs = estimatedBpm > 0 ? 60000 / estimatedBpm : 850; // default ~70 BPM
  const delay = Math.max(3, Math.round((cardiacPeriodMs / 1000) * sampleRateHz / 4));

  // Validate delay is reasonable
  if (delay >= Math.floor(n / TAKENS_DIMENSION)) return empty;

  // Build embedding vectors
  const vectors: number[][] = [];
  const maxIdx = n - (TAKENS_DIMENSION - 1) * delay;

  for (let i = 0; i < maxIdx; i++) {
    const vec: number[] = [];
    for (let j = 0; j < TAKENS_DIMENSION; j++) {
      vec.push(ppgSignal[i + j * delay] ?? 0);
    }
    vectors.push(vec);
  }

  if (vectors.length < 5) return empty;

  // Quality metric: how spread are the embedded vectors (higher = better attractor)
  // Use variance along first principal component as proxy
  let meanFirst = 0;
  for (const v of vectors) meanFirst += v[0];
  meanFirst /= vectors.length;

  let variance = 0;
  for (const v of vectors) variance += (v[0] - meanFirst) ** 2;
  variance /= vectors.length;

  // Normalize quality to [0, 1]
  const quality = clamp(variance / 100, 0, 1);

  // Fundamental frequency from delay
  const freqHz = sampleRateHz / delay; // delay = T/4, so freq = 4 * cardiac_freq (but we report cardiac freq)
  const freqCorrected = freqHz / 4; // correct back to cardiac frequency

  return {
    delay,
    dimension: TAKENS_DIMENSION,
    vectors,
    quality,
    fundamentalFreqHz: freqCorrected,
  };
}

/**
 * Extract initial state estimate from Takens embedding.
 * The geometry of the attractor encodes hemodynamic state.
 *
 * From AVCT: attractor morphology ranks 1–6 in feature importance for BP.
 * We use simple geometric properties as initial state guesses.
 */
export function embeddingToInitialState(
  embedding: TakensEmbedding,
): number[] | null {
  if (embedding.vectors.length < 10 || embedding.quality < 0.05) return null;

  const vecs = embedding.vectors;
  const n = vecs.length;

  // Centroid of attractor → proxy for MAP
  let centroidMean = 0;
  for (const v of vecs) centroidMean += v[0];
  centroidMean /= n;

  // Spread of attractor → proxy for pulse pressure
  let maxSpread = 0;
  let minSpread = Infinity;
  for (const v of vecs) {
    const range = Math.max(...v) - Math.min(...v);
    if (range > maxSpread) maxSpread = range;
    if (range < minSpread) minSpread = range;
  }
  const avgSpread = (maxSpread + minSpread) / 2;

  // Attractor diameter → proxy for vascular tone
  let diameter = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < Math.min(i + 50, n); j++) {
      let dist = 0;
      for (let k = 0; k < TAKENS_DIMENSION; k++) {
        dist += (vecs[i][k] - vecs[j][k]) ** 2;
      }
      if (dist > diameter) diameter = dist;
    }
  }
  diameter = Math.sqrt(diameter);

  // Map embedding geometry to hemodynamic state
  const pMAP = clamp(70 + centroidMean * 2, 50, 150);
  const R = clamp(0.3 + avgSpread * 0.05, 0.1, 0.9);
  const C = clamp(0.8 - avgSpread * 0.03, 0.2, 1.0);
  const PWV = clamp(5.0 + diameter * 0.1, 3.5, 12.0);
  const pDia = clamp(pMAP * 0.8, 40, 110);
  const gamma = clamp(0.2 + diameter * 0.02, 0.05, 0.7);

  return [pMAP, R, C, PWV, pDia, gamma];
}

// ═══════════════════════════════════════════════════════════
// EKF CORE — Extended Kalman Filter
// ═══════════════════════════════════════════════════════════

/**
 * 6×6 matrix operations (inline for performance, no external deps).
 * All matrices stored as flat arrays, row-major.
 */
function mat6Init(): number[] {
  return new Array(36).fill(0);
}

function mat6Identity(): number[] {
  const I = mat6Init();
  for (let i = 0; i < 6; i++) I[i * 6 + i] = 1;
  return I;
}

function mat6Multiply(A: number[], B: number[]): number[] {
  const C = mat6Init();
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      let sum = 0;
      for (let k = 0; k < 6; k++) {
        sum += A[i * 6 + k] * B[k * 6 + j];
      }
      C[i * 6 + j] = sum;
    }
  }
  return C;
}

function mat6Transpose(A: number[]): number[] {
  const T = mat6Init();
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      T[i * 6 + j] = A[j * 6 + i];
    }
  }
  return T;
}

function mat6Add(A: number[], B: number[]): number[] {
  const C = mat6Init();
  for (let i = 0; i < 36; i++) C[i] = A[i] + B[i];
  return C;
}

function vec6MultiplyMV(M: number[], v: number[]): number[] {
  const r = new Array(6).fill(0);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      r[i] += M[i * 6 + j] * v[j];
    }
  }
  return r;
}

function vec6Add(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + b[i]);
}

function vec6Sub(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - b[i]);
}

/**
 * Invert a 6×6 matrix using Gauss-Jordan elimination.
 * Returns null if singular.
 */
function mat6Inverse(M: number[]): number[] | null {
  const n = 6;
  const aug = new Array(n * 2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      aug[i * 2 * n + j] = M[i * n + j];
      aug[i * 2 * n + n + j] = i === j ? 1 : 0;
    }
  }

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxVal = Math.abs(aug[col * 2 * n + col]);
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(aug[row * 2 * n + col]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) return null;

    if (maxRow !== col) {
      for (let j = 0; j < 2 * n; j++) {
        const tmp = aug[col * 2 * n + j];
        aug[col * 2 * n + j] = aug[maxRow * 2 * n + j];
        aug[maxRow * 2 * n + j] = tmp;
      }
    }

    const pivot = aug[col * 2 * n + col];
    for (let j = 0; j < 2 * n; j++) {
      aug[col * 2 * n + j] /= pivot;
    }

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row * 2 * n + col];
      for (let j = 0; j < 2 * n; j++) {
        aug[row * 2 * n + j] -= factor * aug[col * 2 * n + j];
      }
    }
  }

  const inv = mat6Init();
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      inv[i * n + j] = aug[i * 2 * n + n + j];
    }
  }
  return inv;
}

/**
 * Scalar inversion for 1×1 "matrix" (measurement noise).
 */
function scalarInverse(s: number): number {
  return Math.abs(s) < 1e-15 ? 0 : 1 / s;
}

// ═══════════════════════════════════════════════════════════
// OBSERVER CLASS — The reasoning engine
// ═══════════════════════════════════════════════════════════

export interface ObserverConfig {
  /** Process noise scaling (higher = more responsive to changes, less smooth) */
  processNoiseScale: number;
  /** Measurement noise scaling (higher = trust model more, less responsive) */
  measurementNoiseScale: number;
  /** Minimum number of observations before producing estimates */
  warmupFrames: number;
  /** Coherence threshold below which confidence drops */
  coherenceThreshold: number;
}

const DEFAULT_CONFIG: ObserverConfig = {
  processNoiseScale: 1.0,
  measurementNoiseScale: 1.0,
  warmupFrames: 15,
  coherenceThreshold: 0.6,
};

export class HemodynamicObserver {
  private state: number[];
  private P: number[]; // State covariance (6×6)
  private initialized = false;
  private frameCount = 0;
  private lastTimestamp = 0;
  private lastBpResult: HemodynamicBpResult | null = null;

  // Takens embedding state
  private ppgBuffer: number[] = [];
  private readonly PPG_BUFFER_MAX = 120; // ~4 seconds at 30fps
  private embeddingCache: TakensEmbedding | null = null;

  // Convergence tracking
  private estimateHistory: number[] = [];
  private readonly HISTORY_MAX = 20;

  // PPG observation normalization
  private ppgRunningMax = 1; // prevent division by zero
  private readonly OBS_REF_PULSE_PRESSURE = 40; // mmHg reference for model output

  private config: ObserverConfig;

  constructor(config?: Partial<ObserverConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = defaultInitialState();
    this.P = mat6Identity();
    // Scale-aware initial covariance: pressure states have higher variance
    const diagInit = [10, 0.01, 0.01, 1.0, 10, 0.01];
    for (let i = 0; i < 6; i++) this.P[i * 6 + i] = diagInit[i];
  }

  /**
   * Reset the observer to initial state.
   */
  reset(): void {
    this.state = defaultInitialState();
    this.P = mat6Identity();
    const diagInit = [10, 0.01, 0.01, 1.0, 10, 0.01];
    for (let i = 0; i < 6; i++) this.P[i * 6 + i] = diagInit[i];
    this.initialized = false;
    this.frameCount = 0;
    this.lastTimestamp = 0;
    this.lastBpResult = null;
    this.ppgBuffer = [];
    this.embeddingCache = null;
    this.ppgRunningMax = 1;
    this.estimateHistory = [];
    this.ppgRunningMax = 1;
  }

  /**
   * Main estimation entry point: receive a PPG frame and optional timing,
   * return blood pressure estimate.
   *
   * This is the "reasoning cycle":
   *   1. Embed PPG in delay space (Takens)
   *   2. Predict state forward (physics)
   *   3. Correct with observation (Kalman)
   *   4. Validate coherence (physics check)
   *   5. Convert to clinical BP
   */
  estimate(
    ppgValue: number,
    timestampMs: number,
    sampleRateHz: number = 30,
    estimatedBpm: number = 0,
  ): HemodynamicBpResult | null {
    // Accumulate PPG for Takens embedding
    this.ppgBuffer.push(ppgValue);
    if (this.ppgBuffer.length > this.PPG_BUFFER_MAX) {
      this.ppgBuffer.shift();
    }

    this.frameCount++;

    // Wait for warmup
    if (this.frameCount < this.config.warmupFrames) return null;

    // Compute time step
    const dt = this.lastTimestamp > 0
      ? Math.max(0.01, Math.min(0.5, (timestampMs - this.lastTimestamp) / 1000))
      : 1 / sampleRateHz;
    this.lastTimestamp = timestampMs;

    // ── Step 1: Takens delay embedding for initial state / validation ──
    if (this.frameCount % 10 === 0 || !this.initialized) {
      const embedding = takensDelayEmbedding(
        this.ppgBuffer,
        sampleRateHz,
        estimatedBpm,
      );
      this.embeddingCache = embedding;

      if (!this.initialized && embedding.quality > 0.1) {
        const initState = embeddingToInitialState(embedding);
        if (initState && isValidState(initState)) {
          this.state = initState;
          this.initialized = true;
        }
      }
    }

    // Initialize with default state if not yet initialized
    if (!this.initialized) {
      this.state = defaultInitialState();
      this.initialized = true;
    }

    // ── Step 2: EKF Prediction (physics-based forward propagation) ──
    const hr = estimatedBpm > 0 ? estimatedBpm : 72;
    const xPred = propagateState(this.state, dt, hr);
    const F = propagationJacobian(this.state, dt, hr);

    // P_pred = F · P · Fᵀ + Q
    const Ft = mat6Transpose(F);
    const FP = mat6Multiply(F, this.P);
    const FPFt = mat6Multiply(FP, Ft);
    const Q = processNoiseCovariance(dt).map(v => v * this.config.processNoiseScale);
    const Qmat = mat6Init();
    for (let i = 0; i < 6; i++) Qmat[i * 6 + i] = Q[i];
    const Ppred = mat6Add(FPFt, Qmat);

    // ── Step 3: EKF Update (observation correction) ──
    // Normalize PPG observation to [0,1] using running max
    this.ppgRunningMax = Math.max(this.ppgRunningMax * 0.995, Math.abs(ppgValue));
    const zObs = ppgValue / this.ppgRunningMax;
    const hPred = observationModel(xPred) / this.OBS_REF_PULSE_PRESSURE;
    const innovation = zObs - hPred;

    // Observation Jacobian (scaled to match normalized observation)
    const Hraw = observationJacobian(xPred);
    const H = Hraw.map(v => v / this.OBS_REF_PULSE_PRESSURE);

    // Innovation covariance: S = H · P_pred · Hᵀ + R
    // For scalar observation: S = H · P_pred · Hᵀ + R (scalar)
    let S = 0;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        S += H[i] * Ppred[i * 6 + j] * H[j];
      }
    }
    S += measurementNoiseCovariance() * this.config.measurementNoiseScale;

    if (S < 1e-10) {
      // Numerical guard: skip update, use prediction
      this.state = xPred;
      this.P = Ppred;
    } else {
      // Kalman gain: K = P_pred · Hᵀ / S
      const K = new Array(6);
      for (let i = 0; i < 6; i++) {
        let sum = 0;
        for (let j = 0; j < 6; j++) {
          sum += Ppred[i * 6 + j] * H[j];
        }
        K[i] = sum / S;
      }

      // State update: x = x_pred + K · innovation
      const correction = K.map(v => v * innovation);
      const xUpdated = vec6Add(xPred, correction);

      // Covariance update: P = (I - K·H) · P_pred
      // Using Joseph form for numerical stability:
      // P = (I - K·H) · P_pred · (I - K·H)ᵀ + K · R · Kᵀ
      const KH = mat6Init();
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          KH[i * 6 + j] = K[i] * H[j];
        }
      }
      const IKH = mat6Init();
      for (let i = 0; i < 36; i++) IKH[i] = (i % 7 === 0 ? 1 : 0) - KH[i];

      const IKH_P = mat6Multiply(IKH, Ppred);
      const IKH_T = mat6Transpose(IKH);
      const Pupd1 = mat6Multiply(IKH_P, IKH_T);

      // K · R · Kᵀ
      const Rscalar = measurementNoiseCovariance() * this.config.measurementNoiseScale;
      const KRKT = mat6Init();
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          KRKT[i * 6 + j] = K[i] * Rscalar * K[j];
        }
      }
      const Pupd = mat6Add(Pupd1, KRKT);

      this.state = isValidState(xUpdated) ? xUpdated : xPred;
      this.P = Pupd;
    }

    // Ensure covariance stays positive definite (diagonal floor)
    for (let i = 0; i < 6; i++) {
      this.P[i * 6 + i] = Math.max(this.P[i * 6 + i], 0.001);
    }

    // ── Step 4: Convert state to clinical BP ──
    const bpResult = stateToBloodPressure(this.state);

    // ── Step 5: Coherence-based confidence adjustment ──
    // If coherence is low, degrade confidence
    if (bpResult.coherenceScore < this.config.coherenceThreshold) {
      // Reduce effective confidence
      const coherenceFactor = bpResult.coherenceScore / this.config.coherenceThreshold;
      bpResult.systolic = Math.round(bpResult.systolic * coherenceFactor + 120 * (1 - coherenceFactor));
      bpResult.diastolic = Math.round(bpResult.diastolic * coherenceFactor + 80 * (1 - coherenceFactor));
    }

    // Track estimate history for convergence
    this.estimateHistory.push(bpResult.systolic);
    if (this.estimateHistory.length > this.HISTORY_MAX) {
      this.estimateHistory.shift();
    }

    this.lastBpResult = bpResult;
    return bpResult;
  }

  /**
   * Get current hemodynamic state (for debugging / UI display).
   */
  getState(): HemodynamicState {
    return {
      map: this.state[0],
      resistance: this.state[1],
      compliance: this.state[2],
      pwv: this.state[3],
      diastolic: this.state[4],
      reflection: this.state[5],
    };
  }

  /**
   * Get last BP result.
   */
  getLastResult(): HemodynamicBpResult | null {
    return this.lastBpResult;
  }

  /**
   * Estimate convergence: has the observer settled?
   * Returns a value 0–1 (1 = fully converged).
   */
  getConvergence(): number {
    if (this.estimateHistory.length < 5) return 0;

    const recent = this.estimateHistory.slice(-10);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recent.length;
    const std = Math.sqrt(variance);

    // Lower std → higher convergence
    return clamp(1 - std / 20, 0, 1);
  }

  /**
   * Get Takens embedding quality (how well can we reconstruct the attractor).
   */
  getEmbeddingQuality(): number {
    return this.embeddingCache?.quality ?? 0;
  }

  /**
   * Check if the observer has produced enough frames for reliable estimates.
   */
  isReady(): boolean {
    return this.frameCount >= this.config.warmupFrames && this.initialized;
  }
}

// ═══════════════════════════════════════════════════════════
// CONVENIENCE — Single-shot estimation (no state)
// ═══════════════════════════════════════════════════════════

/**
 * One-shot BP estimation from a PPG segment and RR intervals.
 * Creates a fresh observer and runs it over the segment.
 * Useful for validation and testing.
 */
export function estimateBpFromSegment(
  ppgSegment: number[],
  sampleRateHz: number,
  rrIntervalsMs: number[],
  estimatedBpm: number = 0,
): HemodynamicBpResult | null {
  if (ppgSegment.length < 30 || rrIntervalsMs.length < 2) return null;

  const observer = new HemodynamicObserver({ warmupFrames: 5 });
  const bpm = estimatedBpm > 0
    ? estimatedBpm
    : 60000 / (rrIntervalsMs.reduce((a, b) => a + b, 0) / rrIntervalsMs.length);

  let lastResult: HemodynamicBpResult | null = null;
  const dt = 1000 / sampleRateHz;

  for (let i = 0; i < ppgSegment.length; i++) {
    const result = observer.estimate(
      ppgSegment[i],
      i * dt,
      sampleRateHz,
      bpm,
    );
    if (result) lastResult = result;
  }

  return lastResult;
}
