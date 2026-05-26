import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

/** Métricas instantáneas (suavizadas o crudas) del ROI para firma hemoglobina + dedo. */
export interface FingerRgbSnapshot {
  red: number;
  green: number;
  blue: number;
  coverage: number;
  fingerScore: number;
}

/** Escala el umbral de rojo absoluto según el brillo total de la escena (melanina absorbe más → umbral más bajo). */
function adaptiveRedThreshold(r: number, g: number, b: number): number {
  const total = r + g + b;
  return Math.max(18, Math.min(VITAL_THRESHOLDS.FINGER.MIN_RED_INTENSITY, total * 0.12));
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

  if (r < adaptiveRedThreshold(r, g, b)) return false;
  if (rg < F.MIN_RG_RATIO) return false;
  if (rb < F.HEMOGLOBIN_MIN_RB) return false;
  if (redDominance < F.MIN_RED_DOMINANCE) return false;

  // Flash al aire: canal verde/azul aún altos frente a rojo
  if (rg < 1.14 && rb < 1.28) return false;
  if (g > 95 && b > 80 && redDominance < 30) return false;
  if (total > 200 && rb < 1.38) return false;
  if (total > 120 && rb < 1.42 && rg < 1.2) return false;

  return (
    s.coverage >= F.MIN_COVERAGE * 0.95 &&
    s.fingerScore >= F.ACQUIRE_SOFT_FINGER_SCORE_ROI * 0.9
  );
}
