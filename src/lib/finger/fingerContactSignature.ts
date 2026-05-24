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
 * Umbrales ultra-permisivos: cualquier escena con suficiente rojo
 * dominante pasa; la pulsación es quien confirma o descarta después.
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

  // Solo flash al aire extremo (R≈G≈B alto muy brillante)
  if (total > 160 && g > 120 && b > 100 && rb < 1.25) return false;

  return (
    s.coverage >= F.MIN_COVERAGE * 0.95 &&
    s.fingerScore >= F.ACQUIRE_SOFT_FINGER_SCORE_ROI * 0.9
  );
}
