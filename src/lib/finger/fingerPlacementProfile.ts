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
    if (count >= VITAL_THRESHOLDS.PLACEMENT.MODE_DEBOUNCE_FRAMES) {
      return { mode: next, streak: { mode: next, count } };
    }
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

/**
 * Coach de colocación. El tono importa: el usuario abandona cuando el mensaje
 * suena a reproche o le exige una inmovilidad imposible. Los textos orientan
 * ("apoye la mano") y normalizan explícitamente el temblor fisiológico, que el
 * pipeline ya tolera (zona muerta del IMU + gracia de contacto + veto sostenido).
 *
 * @param motionScore Movimiento del frame (0..~2). Si supera el umbral de aviso
 *   se prioriza la sugerencia de apoyo, que es la acción con más impacto real.
 */
export function placementHintText(
  mode: FingerPlacementMode,
  perfusionIndex?: number,
  motionScore?: number,
): string {
  if (motionScore !== undefined && motionScore > VITAL_THRESHOLDS.ACQUISITION.MOTION_TOLERANCE) {
    return 'Apoye la mano en una superficie — un temblor leve es normal';
  }
  if (perfusionIndex !== undefined && perfusionIndex > 0 && perfusionIndex < 0.00025) {
    return 'Afloje un poco la presión: está cortando el flujo';
  }
  switch (mode) {
    case 'tip':
      return 'Cubra la lente con toda la yema, no solo con la punta';
    case 'pad':
      return 'Buen apoyo — manténgalo así, sin apretar más';
    default:
      return 'Apoye la yema sobre la lente con presión suave y constante';
  }
}
