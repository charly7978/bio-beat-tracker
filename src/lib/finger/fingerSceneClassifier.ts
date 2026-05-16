import type { FingerRgbSnapshot } from './fingerContactSignature';

/**
 * Flash al aire / superficie roja: brillo alto, G y B aún altos, R/B bajo.
 * La causa habitual de “detecta más sin dedo”.
 */
export function isOpenFlashWithoutContact(s: FingerRgbSnapshot): boolean {
  const r = s.red;
  const g = Math.max(1, s.green);
  const b = Math.max(1, s.blue);
  const total = r + g + b;
  if (total < 55) return false;

  const rb = r / b;
  const rg = r / g;
  const dom = r - (g + b) / 2;

  if (total > 210 && rb < 1.4 && rg < 1.22) return true;
  if (g > 92 && b > 78 && dom < 34) return true;
  if (r > 0 && g > 0.7 * r && b > 0.62 * r && total > 130) return true;

  return false;
}

/**
 * Variación temporal alta con poca firma hemoglobina → AE del sensor, no pulso en dedo.
 */
export function isExposureFlickerNotFingerPulse(
  roiRedCv: number,
  snap: FingerRgbSnapshot,
  minRbForPulse: number,
): boolean {
  if (roiRedCv < 0.028) return false;
  const b = Math.max(1, snap.blue);
  const rb = snap.red / b;
  return rb < minRbForPulse;
}

/** Dedo cubriendo lente: intensidad moderada, buena cobertura, hemoglobina clara. */
export function isFingerOnLensScene(
  snap: FingerRgbSnapshot,
  coverage: number,
  fingerScore: number,
): boolean {
  const r = snap.red;
  const g = Math.max(1, snap.green);
  const b = Math.max(1, snap.blue);
  const total = r + g + b;
  const rb = r / b;
  const rg = r / g;
  const dom = r - (g + b) / 2;

  return (
    total >= 48 &&
    total <= 520 &&
    rb >= 1.14 &&
    rg >= 1.05 &&
    dom >= 10 &&
    coverage >= 0.13 &&
    fingerScore >= 0.16 &&
    snap.coverage >= 0.11
  );
}
