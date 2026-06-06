import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import {
  computeFingerEnsemble,
  isFingerPresentByEnsemble,
  hasFingerHemoglobinSignature,
  type FingerRgbSnapshot,
  type FingerEnsembleMetrics,
} from './fingerContactSignature';
import { passesUnifiedFingerAcquire } from './fingerPlacementProfile';

let lastEnsemble: FingerEnsembleMetrics | null = null;

export function getLastEnsemble(): FingerEnsembleMetrics | null {
  return lastEnsemble;
}

export function isOpenFlashWithoutContact(s: FingerRgbSnapshot): boolean {
  const r = s.red;
  const g = Math.max(1, s.green);
  const b = Math.max(1, s.blue);
  const total = r + g + b;
  if (total < 45) return false;
  const dom = r - (g + b) / 2;
  if (dom > 20) return false;
  if (g > 0.8 * r && b > 0.7 * r && total > 200) return true;
  if (g > 0.75 * r && b > 0.65 * r && total > 150 && dom < 10) return true;
  return false;
}

export interface FingerRoiSpatial {
  coverageRatio: number;
  fingerScore: number;
  fingerTileCount: number;
}

export function passesLiveFingerContact(
  raw: FingerRgbSnapshot,
  smoothed: FingerRgbSnapshot,
  spatial: FingerRoiSpatial,
  ensembleScore?: number,
): boolean {
  const F = VITAL_THRESHOLDS.FINGER;
  if (isOpenFlashWithoutContact(raw) || isOpenFlashWithoutContact(smoothed)) return false;
  if (spatial.coverageRatio < F.MIN_COVERAGE * 0.88) return false;
  if (spatial.fingerTileCount < F.MIN_FINGER_TILES_FOR_WEIGHTING) return false;

  if (ensembleScore !== undefined && ensembleScore > F.ENSEMBLE_FINGER_THRESHOLD * 0.85) {
    return true;
  }
  if (hasFingerHemoglobinSignature(raw) || hasFingerHemoglobinSignature(smoothed)) {
    return true;
  }
  return false;
}

export function passesFingerMaintain(
  raw: FingerRgbSnapshot,
  smoothed: FingerRgbSnapshot,
  spatial: FingerRoiSpatial,
  ensembleScore?: number,
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
  if (ensembleScore !== undefined && ensembleScore > F.ENSEMBLE_FINGER_THRESHOLD * 0.8) {
    return true;
  }
  if (!hasFingerHemoglobinSignature(raw)) return false;
  return true;
}

export function passesFingerAcquire(
  raw: FingerRgbSnapshot,
  smoothed: FingerRgbSnapshot,
  spatial: FingerRoiSpatial,
  opts?: { roiRedCv?: number; perfusionIndex?: number; ensembleScore?: number },
): boolean {
  const F = VITAL_THRESHOLDS.FINGER;
  const rb = raw.red / Math.max(1, raw.blue);

  if (opts?.ensembleScore !== undefined && opts.ensembleScore > F.ENSEMBLE_FINGER_THRESHOLD) {
    if (spatial.coverageRatio >= F.MIN_COVERAGE * 0.88 && spatial.fingerTileCount >= F.MIN_FINGER_TILES_FOR_WEIGHTING) {
      return true;
    }
  }

  if (!passesLiveFingerContact(raw, smoothed, spatial, opts?.ensembleScore)) return false;
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

export function passesPulsatileAcquire(
  raw: FingerRgbSnapshot,
  smoothed: FingerRgbSnapshot,
  spatial: FingerRoiSpatial,
  roiRedCv: number,
  ensembleScore?: number,
): boolean {
  const F = VITAL_THRESHOLDS.FINGER;
  if (ensembleScore !== undefined && ensembleScore > F.ENSEMBLE_FINGER_THRESHOLD * 0.75) {
    if (roiRedCv >= F.ROI_RED_CV_MIN * 0.8) return true;
  }
  if (roiRedCv < F.ROI_RED_CV_MIN) return false;
  if (isExposureFlickerNotFingerPulse(roiRedCv, smoothed, F.PULSATILE_ACQUIRE_RB)) return false;
  const r = Math.max(raw.red, smoothed.red);
  const g = Math.max(1, raw.green, smoothed.green);
  const b = Math.max(1, raw.blue, smoothed.blue);
  const dom = r - (g + b) / 2;
  return (
    r >= F.PULSATILE_ACQUIRE_MIN_RED &&
    r / g >= F.PULSATILE_ACQUIRE_RG &&
    r / b >= F.PULSATILE_ACQUIRE_RB &&
    dom >= F.PULSATILE_ACQUIRE_MIN_DOMINANCE &&
    spatial.coverageRatio >= F.PULSATILE_ACQUIRE_COVERAGE
  );
}

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
    coverage >= 0.11 &&
    fingerScore >= 0.14 &&
    snap.coverage >= 0.1
  );
}

export function updateFingerDetection(
  raw: FingerRgbSnapshot,
  smoothed: FingerRgbSnapshot,
  spatial: FingerRoiSpatial,
  grayPixels: Uint8ClampedArray | null,
  temporalVariance: number,
): { fingerDetected: boolean; ensemble: FingerEnsembleMetrics } {
  const ensemble = computeFingerEnsemble(raw, grayPixels, temporalVariance);
  lastEnsemble = ensemble;
  const fingerDetected = isFingerPresentByEnsemble(ensemble);
  return { fingerDetected, ensemble };
}
