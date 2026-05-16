/**
 * Suavizado adaptativo para displays en vivo: rápido ante cambios grandes,
 * suave en estabilidad, y sin quedarse “pegado” por redondeo.
 */
import { clamp } from '@/utils/math';

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
  alpha: number,
): number {
  const base = Math.min(1, Math.max(0.08, alpha));
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
  alpha: number,
): { systolic: number; diastolic: number } {
  return {
    systolic: Math.round(smoothDisplayValue(prev.systolic, next.systolic, alpha)),
    diastolic: Math.round(smoothDisplayValue(prev.diastolic, next.diastolic, alpha)),
  };
}
