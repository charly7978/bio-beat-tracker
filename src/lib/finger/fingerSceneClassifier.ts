import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { hasFingerHemoglobinSignature, type FingerRgbSnapshot } from './fingerContactSignature';
import { passesUnifiedFingerAcquire } from './fingerPlacementProfile';

/**
 * Flash al aire / superficie roja: brillo alto, G y B aún altos, R/B bajo.
 * Solo atrapa casos extremos (flash directo a superficie blanca/brillante).
 * La pulsación es quien finalmente distingue dedo de superficie inerte.
 */
export function isOpenFlashWithoutContact(s: FingerRgbSnapshot): boolean {
  const r = s.red;
  const g = Math.max(1, s.green);
  const b = Math.max(1, s.blue);
  const total = r + g + b;
  if (total < 60) return false;

  const rb = r / b;
  const dom = r - (g + b) / 2;

  // Solo flash directo a superficie muy brillante sin nada de hemoglobina
  if (total > 200 && dom < 20 && rb < 1.2) return true;
  if (total > 280 && rb < 1.4 && g > 80 && b > 70) return true;

  return false;
}

export interface FingerRoiSpatial {
  coverageRatio: number;
  fingerScore: number;
  fingerTileCount: number;
}

/** Contacto vivo: hemoglobina en crudo Y suavizado, tiles, sin flash abierto. */
export function passesLiveFingerContact(
  raw: FingerRgbSnapshot,
  smoothed: FingerRgbSnapshot,
  spatial: FingerRoiSpatial,
): boolean {
  const F = VITAL_THRESHOLDS.FINGER;
  if (isOpenFlashWithoutContact(raw) || isOpenFlashWithoutContact(smoothed)) return false;
  if (!hasFingerHemoglobinSignature(raw) || !hasFingerHemoglobinSignature(smoothed)) {
    return false;
  }
  if (spatial.coverageRatio < F.MIN_COVERAGE * 0.88) return false;
  if (spatial.fingerTileCount < F.MIN_FINGER_TILES_FOR_WEIGHTING) return false;
  const b = Math.max(1, raw.blue);
  if (raw.red / b < F.HEMOGLOBIN_MIN_RB) return false;

  return true;
}

/** Mantener contacto ya adquirido (umbrales más tolerantes — AE/torch variables en Motorola, etc.). */
export function passesFingerMaintain(
  raw: FingerRgbSnapshot,
  smoothed: FingerRgbSnapshot,
  spatial: FingerRoiSpatial,
): boolean {
  const F = VITAL_THRESHOLDS.FINGER;
  if (isOpenFlashWithoutContact(raw) || isOpenFlashWithoutContact(smoothed)) return false;

  const r = Math.max(raw.red, smoothed.red);
  const g = Math.max(1, raw.green, smoothed.green);
  const b = Math.max(1, raw.blue, smoothed.blue);
  const dom = r - (g + b) / 2;

  if (r < F.MAINTAIN_MIN_RED) return false;
  if (r / g < F.MAINTAIN_RG) return false;
  if (r / b < F.MAINTAIN_RB) return false;
  if (dom < F.MAINTAIN_DOMINANCE) return false;
  if (spatial.coverageRatio < F.MAINTAIN_COVERAGE) return false;
  if (!hasFingerHemoglobinSignature(raw)) return false;

  return true;
}

/** Primera adquisición: punta, almohadilla o escena en lente (postura unificada). */
export function passesFingerAcquire(
  raw: FingerRgbSnapshot,
  smoothed: FingerRgbSnapshot,
  spatial: FingerRoiSpatial,
  opts?: { roiRedCv?: number; perfusionIndex?: number },
): boolean {
  if (!passesLiveFingerContact(raw, smoothed, spatial)) return false;
  const F = VITAL_THRESHOLDS.FINGER;
  const rb = raw.red / Math.max(1, raw.blue);
  if (rb < F.ACQUIRE_RB_STRICT) return false;

  if (
    passesUnifiedFingerAcquire(
      raw,
      smoothed,
      spatial,
      opts?.roiRedCv ?? 0,
      opts?.perfusionIndex ?? 0,
    )
  ) {
    return true;
  }

  const onLens = isFingerOnLensScene(smoothed, spatial.coverageRatio, spatial.fingerScore);
  const r = smoothed.red;
  const g = Math.max(1, smoothed.green);
  const b = Math.max(1, smoothed.blue);
  const total = r + g + b;
  const strict =
    rb >= F.ACQUIRE_RB_STRICT &&
    total >= F.ACQUIRE_INTENSITY_MIN &&
    total <= F.ACQUIRE_INTENSITY_MAX &&
    spatial.coverageRatio >= F.MIN_COVERAGE &&
    spatial.fingerScore >= F.ACQUIRE_SMOOTHED_FINGER_MIN;

  return onLens || strict;
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
    total >= 24 &&
    total <= 580 &&
    rb >= 1.04 &&
    rg >= 1.01 &&
    dom >= 3 &&
    coverage >= 0.04 &&
    fingerScore >= 0.05 &&
    snap.coverage >= 0.03
  );
}
