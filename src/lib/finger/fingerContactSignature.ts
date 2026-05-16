import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

/** Métricas instantáneas (suavizadas o crudas) del ROI para firma hemoglobina + dedo. */
export interface FingerRgbSnapshot {
  red: number;
  green: number;
  blue: number;
  coverage: number;
  fingerScore: number;
}

/**
 * Firma mínima de dedo con flash: R domina y B bajo (hemoglobina).
 * Rechaza escena iluminada por flash sin contacto (R≈G≈B alto).
 */
export function hasFingerHemoglobinSignature(s: FingerRgbSnapshot): boolean {
  const F = VITAL_THRESHOLDS.FINGER;
  const r = s.red;
  const g = Math.max(1, s.green);
  const b = Math.max(1, s.blue);
  const total = r + g + b;
  if (total < F.ACQUIRE_SOFT_INTENSITY_MIN) return false;

  const redDominance = r - (g + b) / 2;
  const rg = r / g;
  const rb = r / b;

  if (r < F.MIN_RED_INTENSITY) return false;
  if (rg < F.MIN_RG_RATIO) return false;
  if (rb < F.HEMOGLOBIN_MIN_RB) return false;
  if (redDominance < F.MIN_RED_DOMINANCE) return false;

  // Flash al aire: canal verde/azul aún altos frente a rojo
  if (rg < 1.12 && rb < 1.25) return false;
  if (g > 100 && b > 85 && redDominance < 28) return false;

  const hasSpatial =
    s.coverage >= F.MIN_COVERAGE || s.fingerScore >= F.ACQUIRE_SOFT_FINGER_SCORE_ROI;
  return hasSpatial;
}
