/**
 * Suavizado adaptativo para displays en vivo (BPM, SpO2, PA).
 * Alphas bajos: responde sin congelar el número en pantalla.
 */
import { clamp } from '@/utils/math';

/** Pesos de suavizado por vital (solo UI, no afecta guardado clínico). */
export const DISPLAY_SMOOTH_ALPHAS = {
  hr: 0.08,
  spo2: 0.14,
  bp: 0.12,
} as const;

function adaptiveAlpha(prev: number, next: number, baseAlpha: number): number {
  if (prev <= 0 || next <= 0) return Math.min(1, baseAlpha * 2.2);
  const rel = Math.abs(next - prev) / Math.max(1, Math.abs(prev));
  if (rel > 0.12) return clamp(baseAlpha * 2.8, baseAlpha, 0.72);
  if (rel > 0.05) return clamp(baseAlpha * 1.75, baseAlpha, 0.5);
  return baseAlpha;
}

export function smoothDisplayValue(
  prev: number,
  next: number,
  alpha: number = DISPLAY_SMOOTH_ALPHAS.hr,
): number {
  const base = Math.min(1, Math.max(0.06, alpha));
  if (next <= 0) {
    if (prev <= 0) return 0;
    return prev + (0 - prev) * Math.min(1, base * 2.5);
  }
  if (prev <= 0) return next;

  const a = adaptiveAlpha(prev, next, base);
  let out = prev + (next - prev) * a;
  if (Math.abs(next - out) < 0.55) out = next;
  return out;
}

export function smoothDisplayPair(
  prev: { systolic: number; diastolic: number },
  next: { systolic: number; diastolic: number },
  alpha: number = DISPLAY_SMOOTH_ALPHAS.bp,
): { systolic: number; diastolic: number } {
  return {
    systolic: Math.round(smoothDisplayValue(prev.systolic, next.systolic, alpha)),
    diastolic: Math.round(smoothDisplayValue(prev.diastolic, next.diastolic, alpha)),
  };
}

/** Mismo algoritmo para el canvas (PPGSignalMeter). */
export function lerpDisplayValue(
  cur: number,
  tgt: number,
  base: number,
): number {
  if (tgt <= 0) return smoothDisplayValue(cur, 0, base);
  if (cur <= 0) return tgt;
  return smoothDisplayValue(cur, tgt, base);
}
