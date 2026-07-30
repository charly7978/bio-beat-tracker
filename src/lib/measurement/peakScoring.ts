/**
 * Ponderación de candidatos a pico PPG (Elgendi + SQI/PI).
 */
import { clamp } from '@/utils/math';
import { median } from '@/utils/stats';

export const PEAK_SCORE_WEIGHTS = {
  elgendi: 0.36,
  ensemble: 0.22,
  sqi: 0.16,
  rrStability: 0.16,
  shapeQuality: 0.10,
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
  /** Calidad de forma del pico (0-1): energía de la segunda derivada normalizada.
   *  Picos reales PPG tienen forma "M" pronunciada (aceleración sistólica fuerte);
   *  picos de ruido son más suaves/redondeados. */
  shapeQuality?: number;
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

  // Shape quality: picos PPG reales tienen segunda derivada pronunciada (aceleración
  // sistólica fuerte → forma "M"); picos de ruido/redondeados tienen poca energía en
  // la segunda derivada. Penaliza suavemente picos de baja calidad de forma.
  score += w.shapeQuality * clamp(input.shapeQuality ?? 0.5, 0, 1);

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

/**
 * Calcula la calidad de forma de un pico PPG usando la segunda derivada.
 * Picos reales tienen una aceleración sistólica fuerte (segunda derivada pronunciada);
 * picos de ruido/redondeados tienen poca energía en la segunda derivada.
 * Devuelve un valor [0, 1] donde 1 = forma perfecta de PPG.
 */
export function computePeakShapeQuality(
  signal: number[],
  peakIdx: number,
  searchRadius: number,
): number {
  const n = signal.length;
  if (n < 5 || peakIdx < 2 || peakIdx >= n - 2) return 0.5;

  // Segunda derivada central: d2x[i] = x[i+1] - 2*x[i] + x[i-1]
  const left = Math.max(2, peakIdx - searchRadius);
  const right = Math.min(n - 3, peakIdx + searchRadius);

  // Energía de la segunda derivada en la zona del pico vs. fuera del pico
  let peakEnergy = 0;
  let contextEnergy = 0;
  let peakCount = 0;
  let contextCount = 0;

  for (let i = left; i <= right; i++) {
    const d2 = signal[i + 1] - 2 * signal[i] + signal[i - 1];
    const isNearPeak = Math.abs(i - peakIdx) <= searchRadius * 0.3;
    if (isNearPeak) {
      peakEnergy += d2 * d2;
      peakCount++;
    } else {
      contextEnergy += d2 * d2;
      contextCount++;
    }
  }

  if (peakCount === 0 || contextCount === 0) return 0.5;

  const peakRms = Math.sqrt(peakEnergy / peakCount);
  const contextRms = Math.sqrt(contextEnergy / contextCount);

  // Ratio peak/context: picos reales tienen RMS mucho mayor en el pico que en el contexto
  const ratio = contextRms > 1e-9 ? peakRms / contextRms : 1;
  // Normalizar: ratio típico de PPG real ≈ 2-5; ruido ≈ 0.5-1.5
  return clamp((ratio - 0.5) / 4, 0, 1);
}
