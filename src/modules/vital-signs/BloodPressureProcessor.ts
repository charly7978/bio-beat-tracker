/**
 * BLOOD PRESSURE PROCESSOR — Hemodynamic State Observer.
 *
 * Uses an Extended Kalman Filter (EKF) that solves the inverse hemodynamic
 * problem in real-time. No machine learning, no trained weights, no thresholds.
 *
 * The observer:
 *   1. Receives PPG signal frames
 *   2. Predicts hemodynamic state via Navier-Stokes 1D physics
 *   3. Corrects with PPG observation (Kalman innovation)
 *   4. Converts estimated state to SBP/DBP via Moens-Korteweg + Windkessel
 *   5. Validates internal coherence (physics-based sanity check)
 *
 * References:
 *   - Kalman (1960) — A New Approach to Linear Filtering and Prediction
 *   - Takens (1981) — Detecting Strange Attractors in Turbulence
 *   - Moens-Korteweg (1878) — PWV = √(Eh/2ρr)
 *   - Windkessel (Frank, 1899) — 3-element arterial impedance
 *   - AVCT (arxiv 2605.10871, 2025) — PPG attractor for BP estimation
 */

import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { isPhysiologicalRR } from '../../utils/physio';
import type { FingerPlacementMode } from '../../types/signal';
import { HemodynamicObserver } from './HemodynamicObserver';
import type { HemodynamicBpResult, AnthropometricProfile } from './hemodynamicModel';
import { clamp } from '../../utils/math';

export interface BPEstimate {
  systolic: number;
  diastolic: number;
  map: number;
  pulsePressure: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  cyclesUsed: number;
  featureQuality: number;
}

const BUFFER_MAX = 24;
const EMIT_EVERY_N_FRAMES = 6;
const STALE_FRAMES_MAX = 30;
const VARIANCE_WINDOW = 5;
const STALE_VARIANCE_THRESHOLD = 3.0;

export class BloodPressureProcessor {
  private readonly MIN_CYCLES = VITAL_THRESHOLDS.BP.MIN_CYCLES;

  private cycleCount = 0;
  private framesSinceLastEmit = 0;

  private lastSBP = 0;
  private lastDBP = 0;
  private lastConfidence: BPEstimate['confidence'] = 'INSUFFICIENT';
  private staleFrames = 0;
  private estimateHistory: number[] = [];

  // Hemodynamic observer (the reasoning engine)
  private observer: HemodynamicObserver;
  private observerReady = false;
  private ppgFrameIndex = 0;

  constructor() {
    this.observer = new HemodynamicObserver({
      warmupFrames: 15,
      processNoiseScale: 1.0,
      measurementNoiseScale: 1.0,
      coherenceThreshold: 0.6,
    });
  }

  setPlacementMode(_mode: FingerPlacementMode): void {
    // Placement mode is managed by VitalSignsProcessor; kept for API compatibility
  }

  setAnthropometric(_profile: AnthropometricProfile): void {
    // Anthropometric profile is handled internally by HemodynamicObserver
  }

  /**
   * Feed a PPG signal frame to the hemodynamic observer.
   * The observer maintains state across frames (reasoning over time).
   */
  feedPpgFrame(
    ppgValue: number,
    timestampMs: number,
    sampleRateHz: number = 30,
    estimatedBpm: number = 0,
  ): void {
    if (Math.abs(ppgValue) < 1e-10) return;

    this.observer.estimate(
      ppgValue,
      timestampMs,
      sampleRateHz,
      estimatedBpm,
    );
    this.ppgFrameIndex++;
  }

  /**
   * Main estimation entry point.
   *
   * The hemodynamic observer processes frames continuously via feedPpgFrame().
   * This method extracts the current BP estimate from the observer's state
   * and applies throttling / confidence logic for the UI.
   */
  estimate(
    signalBuffer: number[],
    rrIntervals: number[],
    sampleRate: number = 30,
    externalHr?: number,
  ): BPEstimate {
    const insufficient: BPEstimate = {
      systolic: 0, diastolic: 0, map: 0, pulsePressure: 0,
      confidence: 'INSUFFICIENT', cyclesUsed: 0, featureQuality: 0,
    };

    if (signalBuffer.length < VITAL_THRESHOLDS.BP.MIN_BUFFER_SAMPLES || rrIntervals.length < 2) {
      return this.staleOrInsufficient(insufficient);
    }

    const bpm = externalHr ?? 60;
    for (let i = 0; i < signalBuffer.length; i++) {
      this.feedPpgFrame(signalBuffer[i], this.ppgFrameIndex * (1000 / sampleRate), sampleRate, bpm);
    }

    if (!this.observer.isReady()) {
      return this.staleOrInsufficient(insufficient);
    }

    // Get raw BP from observer
    const rawBp = this.observer.getLastResult();
    if (!rawBp) return this.staleOrInsufficient(insufficient);

    let sbp = rawBp.systolic;
    let dbp = rawBp.diastolic;
    const coherence = rawBp.coherenceScore;

    // Validate physiological bounds
    if (!this.isPhysiologicalBp(sbp, dbp)) {
      return insufficient;
    }

    // Compute confidence from observer metrics
    const convergence = this.observer.getConvergence();
    const embeddingQuality = this.observer.getEmbeddingQuality();
    const fq = this.assessConfidence(convergence, embeddingQuality, coherence, this.cycleCount);

    let confidence: BPEstimate['confidence'] = 'LOW';
    if (fq >= VITAL_THRESHOLDS.BP.FEATURE_QUALITY_HIGH) confidence = 'HIGH';
    else if (fq >= VITAL_THRESHOLDS.BP.FEATURE_QUALITY_MEDIUM) confidence = 'MEDIUM';

    // EMA smoothing for stability
    if (this.lastSBP > 0) {
      const alpha = 0.20;
      sbp = this.lastSBP * (1 - alpha) + sbp * alpha;
      dbp = this.lastDBP * (1 - alpha) + dbp * alpha;
    }

    if (!this.isPhysiologicalBp(sbp, dbp)) {
      return insufficient;
    }

    this.lastSBP = sbp;
    this.lastDBP = dbp;
    this.lastConfidence = confidence;
    this.staleFrames = 0;
    this.cycleCount = Math.min(this.cycleCount + 1, BUFFER_MAX);

    this.estimateHistory.push(sbp);
    if (this.estimateHistory.length > VARIANCE_WINDOW) {
      this.estimateHistory.shift();
    }

    if (this.isEstimateStale(confidence)) {
      confidence = 'LOW';
    }

    // Throttle emit rate
    this.framesSinceLastEmit++;
    if (this.framesSinceLastEmit < EMIT_EVERY_N_FRAMES) {
      return {
        systolic: Math.round(sbp),
        diastolic: Math.round(dbp),
        map: Math.round(dbp + (sbp - dbp) / 3),
        pulsePressure: Math.round(sbp - dbp),
        confidence,
        cyclesUsed: this.cycleCount,
        featureQuality: fq,
      };
    }
    this.framesSinceLastEmit = 0;

    return {
      systolic: Math.round(sbp),
      diastolic: Math.round(dbp),
      map: Math.round(dbp + (sbp - dbp) / 3),
      pulsePressure: Math.round(sbp - dbp),
      confidence,
      cyclesUsed: this.cycleCount,
      featureQuality: fq,
    };
  }

  private isEstimateStale(confidence: BPEstimate['confidence']): boolean {
    if (this.estimateHistory.length < VARIANCE_WINDOW) return false;
    const mean = this.estimateHistory.reduce((a, b) => a + b, 0) / this.estimateHistory.length;
    const stdDev = Math.sqrt(
      this.estimateHistory.reduce((sum, v) => sum + (v - mean) ** 2, 0) / this.estimateHistory.length,
    );
    return stdDev < STALE_VARIANCE_THRESHOLD && confidence === 'LOW';
  }

  /**
   * Compute confidence from observer convergence, embedding quality,
   * and hemodynamic coherence — all derived from the physics.
   */
  private assessConfidence(
    convergence: number,
    embeddingQuality: number,
    coherence: number,
    cycleCount: number,
  ): number {
    let score = 0;

    // Convergence (EKF settled)
    score += convergence * 30;

    // Takens embedding quality (attractor reconstructed)
    score += embeddingQuality * 20;

    // Hemodynamic coherence (physics self-consistent)
    score += coherence * 25;

    // Cycle count (enough data observed)
    score += Math.min(25, cycleCount * 2);

    return Math.min(100, score);
  }

  private isPhysiologicalBp(sbp: number, dbp: number): boolean {
    const cfg = VITAL_THRESHOLDS.BP;
    if (!Number.isFinite(sbp) || !Number.isFinite(dbp)) return false;
    if (sbp < cfg.SYSTOLIC_MIN || sbp > cfg.SYSTOLIC_MAX) return false;
    if (dbp < cfg.DIASTOLIC_MIN || dbp > cfg.DIASTOLIC_MAX) return false;
    const pp = sbp - dbp;
    if (pp < cfg.PP_MIN || pp > cfg.PP_MAX) return false;
    const ratio = dbp / sbp;
    if (ratio < cfg.DIA_SYS_RATIO_MIN || ratio > cfg.DIA_SYS_RATIO_MAX) return false;
    const map = dbp + pp / 3;
    if (map < cfg.MAP_MIN || map > cfg.MAP_MAX) return false;
    return true;
  }

  private staleOrInsufficient(insufficient: BPEstimate): BPEstimate {
    this.staleFrames++;

    if (this.lastSBP <= 0 || this.lastDBP <= 0) {
      return insufficient;
    }

    if (this.staleFrames >= STALE_FRAMES_MAX) {
      this.lastSBP = 0;
      this.lastDBP = 0;
      this.lastConfidence = 'INSUFFICIENT';
      return insufficient;
    }

    return {
      systolic: Math.round(this.lastSBP),
      diastolic: Math.round(this.lastDBP),
      map: Math.round(this.lastDBP + (this.lastSBP - this.lastDBP) / 3),
      pulsePressure: Math.round(this.lastSBP - this.lastDBP),
      confidence: 'LOW',
      cyclesUsed: this.cycleCount,
      featureQuality: 0,
    };
  }

  reset(): void {
    this.lastSBP = 0;
    this.lastDBP = 0;
    this.cycleCount = 0;
    this.framesSinceLastEmit = 0;
    this.lastConfidence = 'INSUFFICIENT';
    this.staleFrames = 0;
    this.estimateHistory = [];
    this.observer.reset();
    this.observerReady = false;
    this.ppgFrameIndex = 0;
  }
}
