import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { FingerPlacementMode } from '@/types/signal';

/**
 * Clasificación de colocación (yema vs. almohadilla) a partir de señales
 * FISIOLÓGICAS — cobertura del ROI, pulsatilidad temporal del rojo (CV) e índice
 * de perfusión — SIN firma de color. Solo ajusta pesos de morfología aguas abajo
 * (HR usa más verde en yema; PA usa más morfología en almohadilla); nunca abre
 * ni cierra la medición (eso lo decide el CardiacPresenceEngine).
 */
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

export function placementHintText(mode: FingerPlacementMode, perfusionIndex?: number): string {
  if (perfusionIndex !== undefined && perfusionIndex > 0 && perfusionIndex < 0.00025) {
    return 'Presione más suave (flujo sanguíneo limitado)';
  }
  switch (mode) {
    case 'tip':
      return 'Cubra la yema con presión media (no solo la punta)';
    case 'pad':
      return 'Buen apoyo; mantenga presión media sin aplastar del todo';
    default:
      return 'Apoye la yema cubriendo la lente, presión media y constante';
  }
}
