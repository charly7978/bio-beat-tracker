/**
 * Ponderación única de candidatos a pico PPG (Elgendi + Pan + espectral + SQI/PI).
 */
import { clamp } from '@/utils/math';

export const PEAK_SCORE_WEIGHTS = {
  fusionDual: 0.36,
  elgendi: 0.16,
  panTompkins: 0.16,
  ensemble: 0.12,
  spectral: 0.1,
  sqi: 0.05,
  rrStability: 0.05,
} as const;

export const PEAK_SCORE_THRESHOLDS = {
  dualMin: 0.44,
  soloMin: 0.58,
  /** Desviación máxima vs mediana RR previa para aceptar pico */
  rrMedianMaxRelDev: 0.32,
} as const;

export interface PeakScoreInput {
  source: 'dual' | 'solo_elgendi' | 'solo_pan';
  elConf: number;
  panConf: number;
  ensConf: number;
  spectralAgreement: number;
  sqi: number;
  perfusionIndex: number;
  rrMs?: number;
  prevRrMedianMs?: number;
}

export function scorePeakCandidate(input: PeakScoreInput): number {
  const w = PEAK_SCORE_WEIGHTS;
  const fusionFactor =
    input.source === 'dual' ? 1 : input.source === 'solo_elgendi' ? 0.48 : 0.42;

  let score =
    w.fusionDual * fusionFactor +
    w.elgendi * clamp(input.elConf, 0, 1) +
    w.panTompkins * clamp(input.panConf, 0, 1) +
    w.ensemble * clamp(input.ensConf, 0, 1) +
    w.spectral * clamp(input.spectralAgreement, 0, 1) +
    w.sqi * clamp(input.sqi / 100, 0, 1);

  if (input.rrMs != null && input.prevRrMedianMs != null && input.prevRrMedianMs > 0) {
    const rel = Math.abs(input.rrMs - input.prevRrMedianMs) / input.prevRrMedianMs;
    score += w.rrStability * clamp(1 - rel / PEAK_SCORE_THRESHOLDS.rrMedianMaxRelDev, 0, 1);
  } else {
    score += w.rrStability * (input.source === 'dual' ? 0.55 : 0.25);
  }

  const piGate =
    input.perfusionIndex > 0
      ? clamp(input.perfusionIndex / 0.007, 0.45, 1)
      : 0.88;
  const sqiGate =
    input.sqi > 0
      ? clamp(0.55 + (input.sqi / 100) * 0.45, 0.55, 1)
      : 0.82;
  return clamp(score * piGate * sqiGate, 0, 1);
}

export function rrMedianMs(intervals: number[]): number {
  const v = intervals.filter((x) => x > 0);
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export function passesRrPlausibility(rrMs: number, prevMedianMs: number): boolean {
  if (prevMedianMs <= 0) return true;
  const rel = Math.abs(rrMs - prevMedianMs) / prevMedianMs;
  return rel <= PEAK_SCORE_THRESHOLDS.rrMedianMaxRelDev;
}
