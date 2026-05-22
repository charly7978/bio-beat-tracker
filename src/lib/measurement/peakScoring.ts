/**
 * Ponderación de candidatos a pico PPG (Elgendi + SQI/PI).
 */
import { clamp } from '@/utils/math';
import { median } from '@/utils/stats';

export const PEAK_SCORE_WEIGHTS = {
  elgendi: 0.40,
  ensemble: 0.24,
  sqi: 0.18,
  rrStability: 0.18,
} as const;

export const PEAK_SCORE_THRESHOLDS = {
  minScore: 0.42,
  /** Desviación máxima vs mediana RR previa para aceptar pico */
  rrMedianMaxRelDev: 0.26,
} as const;

export interface PeakScoreInput {
  elConf: number;
  ensConf: number;
  sqi: number;
  perfusionIndex: number;
  rrMs?: number;
  prevRrMedianMs?: number;
}

export function scorePeakCandidate(input: PeakScoreInput): number {
  const w = PEAK_SCORE_WEIGHTS;

  let score =
    w.elgendi * clamp(input.elConf, 0, 1) +
    w.ensemble * clamp(input.ensConf, 0, 1) +
    w.sqi * clamp(input.sqi / 100, 0, 1);

  if (input.rrMs != null && input.prevRrMedianMs != null && input.prevRrMedianMs > 0) {
    const rel = Math.abs(input.rrMs - input.prevRrMedianMs) / input.prevRrMedianMs;
    score += w.rrStability * clamp(1 - rel / PEAK_SCORE_THRESHOLDS.rrMedianMaxRelDev, 0, 1);
  } else {
    score += w.rrStability * 0.4;
  }

  const piGate =
    input.perfusionIndex > 0
      ? clamp(input.perfusionIndex / 0.007, 0.38, 1)
      : 0.92;
  const sqiGate =
    input.sqi > 0
      ? clamp(0.55 + (input.sqi / 100) * 0.45, 0.55, 1)
      : 0.82;
  return clamp(score * piGate * sqiGate, 0, 1);
}

export function rrMedianMs(intervals: number[]): number {
  const v = intervals.filter((x) => x > 0);
  return v.length ? median(v) : 0;
}

export function passesRrPlausibility(rrMs: number, prevMedianMs: number): boolean {
  if (prevMedianMs <= 0) return true;
  const rel = Math.abs(rrMs - prevMedianMs) / prevMedianMs;
  return rel <= PEAK_SCORE_THRESHOLDS.rrMedianMaxRelDev;
}
