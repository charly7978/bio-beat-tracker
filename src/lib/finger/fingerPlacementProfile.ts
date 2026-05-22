import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { FingerRgbSnapshot } from './fingerContactSignature';
import type { FingerRoiSpatial } from './fingerSceneClassifier';
import type { FingerPlacementMode } from '@/types/signal';
import {
  isFingerOnLensScene,
  passesFingerMaintain,
  passesLiveFingerContact,
} from './fingerSceneClassifier';

export interface PlacementMetrics {
  coverageRatio: number;
  roiRedCv: number;
  perfusionIndex: number;
}

export function classifyFingerPlacement(m: PlacementMetrics): FingerPlacementMode {
  const P = VITAL_THRESHOLDS.PLACEMENT;
  if (m.coverageRatio >= P.PAD_COVERAGE_MIN && m.roiRedCv <= P.PAD_CV_MAX) {
    return 'pad';
  }
  if (
    m.coverageRatio <= P.TIP_COVERAGE_MAX &&
    (m.roiRedCv >= P.TIP_CV_MIN || m.perfusionIndex >= P.TIP_PI_MIN)
  ) {
    return 'tip';
  }
  return 'hybrid';
}

export function smoothPlacementMode(
  prev: FingerPlacementMode,
  next: FingerPlacementMode,
  streak: { mode: FingerPlacementMode; count: number },
): { mode: FingerPlacementMode; streak: { mode: FingerPlacementMode; count: number } } {
  if (next === streak.mode) {
    const count = streak.count + 1;
    if (count >= 4) return { mode: next, streak: { mode: next, count } };
    return { mode: prev, streak: { mode: next, count } };
  }
  return { mode: prev, streak: { mode: next, count: 1 } };
}

/** Adquisición unificada: punta (pulso fuerte) o almohadilla (morfología PA) sin exigir solo un modo. */
export function passesUnifiedFingerAcquire(
  raw: FingerRgbSnapshot,
  smoothed: FingerRgbSnapshot,
  spatial: FingerRoiSpatial,
  roiRedCv: number,
  perfusionIndex: number,
): boolean {
  const F = VITAL_THRESHOLDS.FINGER;
  const rb = raw.red / Math.max(1, raw.blue);
  if (rb < F.ACQUIRE_RB_STRICT) return false;

  const mode = classifyFingerPlacement({
    coverageRatio: spatial.coverageRatio,
    roiRedCv,
    perfusionIndex,
  });

  if (mode === 'pad') {
    return (
      spatial.coverageRatio >= VITAL_THRESHOLDS.PLACEMENT.PAD_COVERAGE_MIN * 0.92 &&
      passesFingerMaintain(raw, smoothed, spatial)
    );
  }

  if (mode === 'tip') {
    return (
      spatial.coverageRatio >= F.MIN_COVERAGE * 0.88 &&
      passesLiveFingerContact(raw, smoothed, spatial)
    );
  }

  const r = smoothed.red;
  const g = Math.max(1, smoothed.green);
  const b = Math.max(1, smoothed.blue);
  const total = r + g + b;
  const strict =
    rb >= F.ACQUIRE_RB_STRICT &&
    total >= F.ACQUIRE_INTENSITY_MIN &&
    total <= F.ACQUIRE_INTENSITY_MAX &&
    spatial.coverageRatio >= F.MIN_COVERAGE * 0.95 &&
    spatial.fingerScore >= F.ACQUIRE_SMOOTHED_FINGER_MIN;

  return (
    isFingerOnLensScene(smoothed, spatial.coverageRatio, spatial.fingerScore) || strict
  );
}

export function placementHintText(mode: FingerPlacementMode): string {
  switch (mode) {
    case 'tip':
      return 'Cubra la yema con presión media (no solo la punta)';
    case 'pad':
      return 'Buen apoyo; mantenga presión media sin aplastar del todo';
    default:
      return 'Apoye la yema cubriendo la lente, presión media y constante';
  }
}
