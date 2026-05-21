import { PPGFeatureExtractor, CycleFeatures } from './PPGFeatureExtractor';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { isPhysiologicalRR } from '../../utils/physio';
import { median } from '../../utils/stats';
import type { FingerPlacementMode } from '../../types/signal';
import {
  applyAnthropometricAdjustment,
  enforceHemodynamicCoherence,
  estimatePhysiologicalBp,
  isPhysiologicalBp,
  type AnthropometricProfile,
  type PwaMedianFeatures,
} from '@/lib/vitals/pwaPhysiologicalBpEngine';

export interface BPEstimate {
  systolic: number;
  diastolic: number;
  map: number;
  pulsePressure: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  cyclesUsed: number;
  featureQuality: number;
}

const BUFFER_MAX = 18;
const EMIT_EVERY_N_FRAMES = 8;
const STALE_FRAMES_MAX = 15;
const EMA_ALPHA = 0.25;
const VARIANCE_WINDOW = 5;
const STALE_VARIANCE_THRESHOLD = 1.5;

export class BloodPressureProcessor {
  private readonly MIN_CYCLES = VITAL_THRESHOLDS.BP.MIN_CYCLES;
  private placementMode: FingerPlacementMode = 'hybrid';

  private cycleBuffer: CycleFeatures[] = [];
  private framesSinceLastEmit = 0;

  private lastSBP = 0;
  private lastDBP = 0;
  private lastConfidence: BPEstimate['confidence'] = 'INSUFFICIENT';
  private staleFrames = 0;
  private estimateHistory: number[] = [];

  private anthropometric: AnthropometricProfile | null = null;

  setPlacementMode(mode: FingerPlacementMode): void {
    this.placementMode = mode;
  }

  setAnthropometric(profile: AnthropometricProfile | null): void {
    this.anthropometric = profile;
  }

  getAnthropometric(): AnthropometricProfile | null {
    return this.anthropometric;
  }

  private minCycleQuality(): number {
    const P = VITAL_THRESHOLDS.PLACEMENT;
    if (this.placementMode === 'tip') return P.BP_CYCLE_QUALITY_TIP;
    if (this.placementMode === 'pad') return P.BP_CYCLE_QUALITY_PAD;
    return P.BP_CYCLE_QUALITY_HYBRID;
  }

  estimate(
    signalBuffer: number[],
    rrIntervals: number[],
    sampleRate: number = 30,
  ): BPEstimate {
    const insufficient: BPEstimate = {
      systolic: 0, diastolic: 0, map: 0, pulsePressure: 0,
      confidence: 'INSUFFICIENT', cyclesUsed: 0, featureQuality: 0,
    };

    if (signalBuffer.length < VITAL_THRESHOLDS.BP.MIN_BUFFER_SAMPLES || rrIntervals.length < 2) {
      return this.staleOrInsufficient(insufficient);
    }

    const cycles = PPGFeatureExtractor.detectCardiacCycles(signalBuffer, sampleRate);
    if (cycles.length < this.MIN_CYCLES) return this.staleOrInsufficient(insufficient);

    const validCycles: CycleFeatures[] = [];
    for (const cycle of cycles) {
      const features = PPGFeatureExtractor.extractCycleFeatures(signalBuffer, cycle, sampleRate);
      if (features && features.quality > this.minCycleQuality()) {
        validCycles.push(features);
      }
    }

    if (validCycles.length < this.MIN_CYCLES) return this.staleOrInsufficient(insufficient);

    for (const vc of validCycles) {
      this.cycleBuffer.push(vc);
    }

    if (this.cycleBuffer.length > BUFFER_MAX) {
      this.cycleBuffer = this.cycleBuffer.slice(-BUFFER_MAX);
    }

    if (this.cycleBuffer.length < this.MIN_CYCLES) return this.staleOrInsufficient(insufficient);

    const mf = this.medianFeatures(this.cycleBuffer);

    const validRR = rrIntervals.filter((i) => isPhysiologicalRR(i) && i <= 1800);
    if (validRR.length < 2) return this.staleOrInsufficient(insufficient);

    const avgRR = validRR.reduce((a, b) => a + b, 0) / validRR.length;
    const hr = 60000 / avgRR;
    const rrVar = PPGFeatureExtractor.extractRRVariability(validRR);
    const cyclePeriodMs = Math.max(280, mf.sutMs + mf.diastolicPhaseMs);

    const raw = estimatePhysiologicalBp(mf, { hr, rmssd: rrVar.rmssd, cyclePeriodMs });
    const coherent = enforceHemodynamicCoherence(raw.systolic, raw.diastolic);

    if (!isPhysiologicalBp(coherent.sbp, coherent.dbp)) {
      return insufficient;
    }

    let sbp = coherent.sbp;
    let dbp = coherent.dbp;

    const fq = this.assessFeatureQuality(mf, this.cycleBuffer.length);
    let confidence: BPEstimate['confidence'] = 'LOW';
    if (fq >= VITAL_THRESHOLDS.BP.FEATURE_QUALITY_HIGH) confidence = 'HIGH';
    else if (fq >= VITAL_THRESHOLDS.BP.FEATURE_QUALITY_MEDIUM) confidence = 'MEDIUM';

    if (this.anthropometric) {
      const adj = applyAnthropometricAdjustment(sbp, dbp, this.anthropometric);
      sbp = adj.sbp;
      dbp = adj.dbp;
    }

    if (this.lastSBP > 0) {
      sbp = this.lastSBP * (1 - EMA_ALPHA) + sbp * EMA_ALPHA;
      dbp = this.lastDBP * (1 - EMA_ALPHA) + dbp * EMA_ALPHA;
    }

    if (!isPhysiologicalBp(sbp, dbp)) {
      return insufficient;
    }

    this.lastSBP = sbp;
    this.lastDBP = dbp;
    this.lastConfidence = confidence;
    this.staleFrames = 0;

    this.estimateHistory.push(sbp);
    if (this.estimateHistory.length > VARIANCE_WINDOW) {
      this.estimateHistory.shift();
    }

    if (this.isEstimateStale(confidence)) {
      confidence = 'LOW';
    }

    this.framesSinceLastEmit++;
    if (this.framesSinceLastEmit < EMIT_EVERY_N_FRAMES) {
      return this.buildThrottledEmit(confidence, fq);
    }
    this.framesSinceLastEmit = 0;

    const map = dbp + (sbp - dbp) / 3;

    return {
      systolic: Math.round(sbp),
      diastolic: Math.round(dbp),
      map: Math.round(map),
      pulsePressure: Math.round(sbp - dbp),
      confidence,
      cyclesUsed: this.cycleBuffer.length,
      featureQuality: fq,
    };
  }

  private isEstimateStale(confidence: BPEstimate['confidence']): boolean {
    if (this.estimateHistory.length < VARIANCE_WINDOW) return false;
    const mean = this.estimateHistory.reduce((a, b) => a + b, 0) / this.estimateHistory.length;
    const variance = Math.sqrt(
      this.estimateHistory.reduce((sum, v) => sum + (v - mean) ** 2, 0) / this.estimateHistory.length,
    );
    return variance < STALE_VARIANCE_THRESHOLD && confidence === 'LOW';
  }

  private buildThrottledEmit(confidence: BPEstimate['confidence'], fq: number): BPEstimate {
    return {
      systolic: Math.round(this.lastSBP),
      diastolic: Math.round(this.lastDBP),
      map: Math.round(this.lastDBP + (this.lastSBP - this.lastDBP) / 3),
      pulsePressure: Math.round(this.lastSBP - this.lastDBP),
      confidence,
      cyclesUsed: this.cycleBuffer.length,
      featureQuality: fq,
    };
  }

  private staleOrInsufficient(insufficient: BPEstimate): BPEstimate {
    this.staleFrames++;

    if (this.lastSBP <= 0 || this.lastDBP <= 0) {
      this.framesSinceLastEmit = 0;
      return insufficient;
    }

    if (this.staleFrames >= STALE_FRAMES_MAX) {
      this.framesSinceLastEmit = 0;
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
      cyclesUsed: this.cycleBuffer.length,
      featureQuality: 0,
    };
  }

  private medianFeatures(cycles: CycleFeatures[]): PwaMedianFeatures {
    const take = cycles.slice(-BUFFER_MAX);
    return {
      bDivA: median(take.map((c) => c.apg.bDivA)),
      dDivA: median(take.map((c) => c.apg.dDivA)),
      agi: median(take.map((c) => c.apg.agi)),
      sutMs: median(take.map((c) => c.sutMs)),
      diastolicPhaseMs: median(take.map((c) => c.diastolicPhaseMs)),
      stiffnessIndex: median(take.map((c) => c.stiffnessIndex)),
      augmentationIndex: median(take.map((c) => c.augmentationIndex)),
      dicroticDepth: median(take.map((c) => c.dicroticDepth)),
      areaRatio: median(take.map((c) => c.areaRatio)),
      pw50Ms: median(take.map((c) => c.pw50Ms)),
      kValue: median(take.map((c) => c.kValue)),
      vMax: median(take.map((c) => c.vMax)),
    };
  }

  private assessFeatureQuality(f: PwaMedianFeatures, cycleCount: number): number {
    let score = 0;
    score += Math.min(30, cycleCount * 2);
    if (f.sutMs > 40 && f.sutMs < 400) score += 18;
    if (f.diastolicPhaseMs > 50 && f.diastolicPhaseMs < 800) score += 15;
    if (f.stiffnessIndex > 0.5 && f.stiffnessIndex < 25) score += 12;
    if (f.augmentationIndex > 2 && f.augmentationIndex < 45) score += 10;
    if (f.dicroticDepth > 0 && f.dicroticDepth < 0.8) score += 8;
    if (f.pw50Ms > 60 && f.pw50Ms < 600) score += 7;
    return Math.min(100, score);
  }

  reset(): void {
    this.lastSBP = 0;
    this.lastDBP = 0;
    this.cycleBuffer = [];
    this.framesSinceLastEmit = 0;
    this.lastConfidence = 'INSUFFICIENT';
    this.staleFrames = 0;
    this.estimateHistory = [];
  }

  fullReset(): void {
    this.reset();
  }
}
