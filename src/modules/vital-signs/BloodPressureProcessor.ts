/**
 * Procesador de presión arterial por PWA (Pulse Wave Analysis).
 * Cálculo desde morfología PPG + modelo Windkessel; rangos en vitalThresholds.
 * Calibración opcional con tensiómetro vía CalibrationManager (VitalSignsProcessor).
 */

import { PPGFeatureExtractor, CycleFeatures } from './PPGFeatureExtractor';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { isPhysiologicalRR } from '../../utils/physio';
import { median } from '../../utils/stats';
import type { FingerPlacementMode } from '../../types/signal';
import {
  enforceHemodynamicCoherence,
  estimatePhysiologicalBp,
  isPhysiologicalBp,
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

export class BloodPressureProcessor {
  private readonly MIN_CYCLES = VITAL_THRESHOLDS.BP.MIN_CYCLES;
  private placementMode: FingerPlacementMode = 'hybrid';
  private readonly MAX_CYCLES = 25;

  private lastSBP = 0;
  private lastDBP = 0;
  private readonly EMA_ALPHA = 0.18;

  setPlacementMode(mode: FingerPlacementMode): void {
    this.placementMode = mode;
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
      systolic: 0,
      diastolic: 0,
      map: 0,
      pulsePressure: 0,
      confidence: 'INSUFFICIENT',
      cyclesUsed: 0,
      featureQuality: 0,
    };

    if (
      signalBuffer.length < VITAL_THRESHOLDS.BP.MIN_BUFFER_SAMPLES ||
      rrIntervals.length < 2
    ) {
      return insufficient;
    }

    const cycles = PPGFeatureExtractor.detectCardiacCycles(signalBuffer, sampleRate);
    if (cycles.length < this.MIN_CYCLES) return insufficient;

    const validCycles: CycleFeatures[] = [];
    for (const cycle of cycles) {
      const features = PPGFeatureExtractor.extractCycleFeatures(signalBuffer, cycle, sampleRate);
      if (features && features.quality > this.minCycleQuality()) {
        validCycles.push(features);
      }
    }

    if (validCycles.length < this.MIN_CYCLES) return insufficient;
    const useCycles = validCycles.slice(-this.MAX_CYCLES);
    const mf = this.medianFeatures(useCycles);

    const validRR = rrIntervals.filter((i) => isPhysiologicalRR(i) && i <= 1800);
    if (validRR.length < 2) return insufficient;

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

    const fq = this.assessFeatureQuality(mf, useCycles.length);
    let confidence: BPEstimate['confidence'] = 'LOW';
    if (fq >= VITAL_THRESHOLDS.BP.FEATURE_QUALITY_HIGH) confidence = 'HIGH';
    else if (fq >= VITAL_THRESHOLDS.BP.FEATURE_QUALITY_MEDIUM) confidence = 'MEDIUM';

    if (this.lastSBP > 0) {
      sbp = this.lastSBP * (1 - this.EMA_ALPHA) + sbp * this.EMA_ALPHA;
      dbp = this.lastDBP * (1 - this.EMA_ALPHA) + dbp * this.EMA_ALPHA;
    }

    if (!isPhysiologicalBp(sbp, dbp)) {
      return insufficient;
    }

    this.lastSBP = sbp;
    this.lastDBP = dbp;

    const map = dbp + (sbp - dbp) / 3;

    return {
      systolic: Math.round(sbp),
      diastolic: Math.round(dbp),
      map: Math.round(map),
      pulsePressure: Math.round(sbp - dbp),
      confidence,
      cyclesUsed: useCycles.length,
      featureQuality: fq,
    };
  }

  private medianFeatures(cycles: CycleFeatures[]): PwaMedianFeatures {
    return {
      bDivA: median(cycles.map((c) => c.apg.bDivA)),
      dDivA: median(cycles.map((c) => c.apg.dDivA)),
      agi: median(cycles.map((c) => c.apg.agi)),
      sutMs: median(cycles.map((c) => c.sutMs)),
      diastolicPhaseMs: median(cycles.map((c) => c.diastolicPhaseMs)),
      stiffnessIndex: median(cycles.map((c) => c.stiffnessIndex)),
      augmentationIndex: median(cycles.map((c) => c.augmentationIndex)),
      dicroticDepth: median(cycles.map((c) => c.dicroticDepth)),
      areaRatio: median(cycles.map((c) => c.areaRatio)),
      pw50Ms: median(cycles.map((c) => c.pw50Ms)),
      kValue: median(cycles.map((c) => c.kValue)),
      vMax: median(cycles.map((c) => c.vMax)),
    };
  }

  private assessFeatureQuality(f: PwaMedianFeatures, cycleCount: number): number {
    let score = 0;
    score += Math.min(30, cycleCount * 3);
    if (f.bDivA !== 0) score += 12;
    if (f.dDivA !== 0) score += 13;
    if (f.sutMs > 30 && f.sutMs < 500) score += 10;
    if (f.diastolicPhaseMs > 40 && f.diastolicPhaseMs < 900) score += 10;
    if (f.stiffnessIndex > 0) score += 8;
    if (f.areaRatio > 0) score += 9;
    if (f.dicroticDepth > 0) score += 8;
    return Math.min(100, score);
  }

  reset(): void {
    this.lastSBP = 0;
    this.lastDBP = 0;
  }

  fullReset(): void {
    this.reset();
  }
}
