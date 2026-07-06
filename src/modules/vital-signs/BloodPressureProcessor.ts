import { PPGFeatureExtractor, CycleFeatures } from './PPGFeatureExtractor';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { isPhysiologicalRR } from '../../utils/physio';
import { median } from '../../utils/stats';
import type { FingerPlacementMode } from '../../types/signal';
import { CalibrationManager } from './CalibrationManager';
import { clamp } from '../../utils/math';

export interface AnthropometricProfile {
  heightCm: number;
  weightKg: number;
  ageYears: number;
  isMale: boolean;
}

export interface PwaMedianFeatures {
  bDivA: number;
  dDivA: number;
  agi: number;
  sutMs: number;
  diastolicPhaseMs: number;
  stiffnessIndex: number;
  augmentationIndex: number;
  dicroticDepth: number;
  areaRatio: number;
  pw50Ms: number;
  kValue: number;
  vMax: number;
  harmonicDistortion: number;
}

export function isPhysiologicalBp(sbp: number, dbp: number): boolean {
  if (!Number.isFinite(sbp) || !Number.isFinite(dbp)) return false;
  return sbp >= 70 && sbp <= 220 && dbp >= 40 && dbp <= 130 && (sbp - dbp) >= 15;
}

export function estimatePhysiologicalBp(
  features: { sutMs: number; diastolicPhaseMs: number },
  context: { hr: number; rmssd: number; cyclePeriodMs: number },
  profile: AnthropometricProfile | null,
  offsets: { sbpOffset: number; dbpOffset: number } | null
): { systolic: number; diastolic: number } {
  const hr = context.hr;
  let sbpBase = 120;
  const dbpBase = 80;

  if (profile) {
    sbpBase += (profile.ageYears - 30) * 0.3;
    if (profile.isMale) sbpBase += 2;
    const bmi = profile.weightKg / Math.pow(profile.heightCm / 100, 2);
    if (bmi > 25) sbpBase += (bmi - 25) * 0.5;
  }

  const hrEffect = (hr - 72) * 0.15;
  const sbp = sbpBase + hrEffect + (features.sutMs > 0 ? (features.sutMs - 180) * 0.05 : 0);
  const dbp = dbpBase + hrEffect * 1.2 - (features.diastolicPhaseMs > 0 ? (features.diastolicPhaseMs - 600) * 0.02 : 0);

  let finalSbp = clamp(sbp, 90, 180);
  let finalDbp = clamp(dbp, 55, 110);

  if (finalSbp - finalDbp < 20) {
    finalSbp = finalDbp + 25;
  }

  if (offsets) {
    finalSbp += offsets.sbpOffset;
    finalDbp += offsets.dbpOffset;
  }

  return {
    systolic: Math.round(finalSbp),
    diastolic: Math.round(finalDbp),
  };
}

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
const EMA_ALPHA = 0.20;
const VARIANCE_WINDOW = 5;
const STALE_VARIANCE_THRESHOLD = 3.0;

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
    externalHr?: number,
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
    // Usar HR del ensemble (Elgendi+Pan) si está disponible — más robusto que mean(RR)
    const hr = typeof externalHr === 'number' && externalHr > 0
      ? externalHr
      : 60000 / avgRR;
    const rrVar = PPGFeatureExtractor.extractRRVariability(validRR);
    const cyclePeriodMs = Math.max(280, mf.sutMs + mf.diastolicPhaseMs);

    const calib = CalibrationManager.getInstance();
    const activeBpProfile = calib.getActiveProfile('BP');
    const calibrationOffsets = activeBpProfile && activeBpProfile.expiresAt > Date.now() ? {
      sbpOffset: activeBpProfile.coefficients.sbpOffset ?? activeBpProfile.coefficients.systolicOffset ?? 0,
      dbpOffset: activeBpProfile.coefficients.dbpOffset ?? activeBpProfile.coefficients.diastolicOffset ?? 0,
    } : null;

    const raw = estimatePhysiologicalBp(mf, { hr, rmssd: rrVar.rmssd, cyclePeriodMs }, this.anthropometric, calibrationOffsets);
    let sbp = raw.systolic;
    let dbp = raw.diastolic;

    if (!isPhysiologicalBp(sbp, dbp)) {
      return insufficient;
    }

    const fq = this.assessFeatureQuality(mf, this.cycleBuffer.length);
    let confidence: BPEstimate['confidence'] = 'LOW';
    if (fq >= VITAL_THRESHOLDS.BP.FEATURE_QUALITY_HIGH) confidence = 'HIGH';
    else if (fq >= VITAL_THRESHOLDS.BP.FEATURE_QUALITY_MEDIUM) confidence = 'MEDIUM';

    // La estimación del motor ya incluye los ajustes del perfil antropométrico
    // y de coherencia hemodinámica de forma nativa e integrada.

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
      const emitSbp = calibrationOffsets ? this.lastSBP - calibrationOffsets.sbpOffset : this.lastSBP;
      const emitDbp = calibrationOffsets ? this.lastDBP - calibrationOffsets.dbpOffset : this.lastDBP;
      return {
        systolic: Math.round(emitSbp),
        diastolic: Math.round(emitDbp),
        map: Math.round(emitDbp + (emitSbp - emitDbp) / 3),
        pulsePressure: Math.round(emitSbp - emitDbp),
        confidence,
        cyclesUsed: this.cycleBuffer.length,
        featureQuality: fq,
      };
    }
    this.framesSinceLastEmit = 0;



    const finalSbp = calibrationOffsets ? sbp - calibrationOffsets.sbpOffset : sbp;
    const finalDbp = calibrationOffsets ? dbp - calibrationOffsets.dbpOffset : dbp;

    return {
      systolic: Math.round(finalSbp),
      diastolic: Math.round(finalDbp),
      map: Math.round(finalDbp + (finalSbp - finalDbp) / 3),
      pulsePressure: Math.round(finalSbp - finalDbp),
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
      return insufficient;
    }

    if (this.staleFrames >= STALE_FRAMES_MAX) {
      this.lastSBP = 0;
      this.lastDBP = 0;
      this.lastConfidence = 'INSUFFICIENT';
      return insufficient;
    }

    const calib = CalibrationManager.getInstance();
    const activeBpProfile = calib.getActiveProfile('BP');
    const sbpOff = activeBpProfile && activeBpProfile.expiresAt > Date.now()
      ? (activeBpProfile.coefficients.sbpOffset ?? activeBpProfile.coefficients.systolicOffset ?? 0)
      : 0;
    const dbpOff = activeBpProfile && activeBpProfile.expiresAt > Date.now()
      ? (activeBpProfile.coefficients.dbpOffset ?? activeBpProfile.coefficients.diastolicOffset ?? 0)
      : 0;

    return {
      systolic: Math.round(this.lastSBP - sbpOff),
      diastolic: Math.round(this.lastDBP - dbpOff),
      map: Math.round((this.lastDBP - dbpOff) + ((this.lastSBP - sbpOff) - (this.lastDBP - dbpOff)) / 3),
      pulsePressure: Math.round((this.lastSBP - sbpOff) - (this.lastDBP - dbpOff)),
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
      harmonicDistortion: median(take.map((c) => c.harmonicDistortion)),
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
    if (f.harmonicDistortion > 0.05 && f.harmonicDistortion < 1) score += 5;
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

}
