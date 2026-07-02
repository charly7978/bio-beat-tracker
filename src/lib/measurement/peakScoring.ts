/**
 * Ponderación de candidatos a pico PPG (Elgendi + SQI/PI).
 *
 * Regla crítica: PI/SQI no pueden aplastar multiplicativamente un pico real.
 * En cámara+flash hay latidos genuinos de baja perfusión: el detector debe dejar
 * que la morfología Elgendi + confianza ensemble manden, usando PI/SQI como
 * penalización suave contra falsos positivos, no como bloqueo encubierto.
 */
import { clamp } from '@/utils/math';
import { median } from '@/utils/stats';

export const PEAK_SCORE_WEIGHTS = {
  // Elgendi es el detector sistólico primario: debe pesar más que el SQI global.
  elgendi: 0.46,
  ensemble: 0.28,
  sqi: 0.10,
  rrStability: 0.16,
} as const;

export const PEAK_SCORE_THRESHOLDS = {
  /** Umbral mínimo de pico genuino: bajo enough para pulso débil, alto against ruido. */
  minScore: 0.30,
  /** Desviación máxima vs mediana RR previa para bonificar, no bloquear. */
  rrMedianMaxRelDev: 0.36,
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
    // Arranque/re-adquisición: no castigar por falta de historial RR.
    score += w.rrStability * 0.40;
  }

  // Penalty suave: un PI bajo NO significa automáticamente falso positivo. En PPG
  // por cámara el PI puede ser muy bajo con dedo real, presión fuerte o flash desigual.
  const piGate =
    input.perfusionIndex > 0
      ? clamp(0.72 + (input.perfusionIndex / 0.007) * 0.28, 0.72, 1)
      : 0.90;
  const sqiGate =
    input.sqi > 0
      ? clamp(0.78 + (input.sqi / 100) * 0.22, 0.78, 1)
      : 0.86;

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
