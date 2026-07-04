/**
 * Calcula cuánta "ventana" de cámara debe verse a través del monitor cardíaco
 * (efecto vidrio esmerilado) y qué color/mensaje debe tener el anillo guía de
 * colocación del dedo. Todo derivado de señales que YA existen en el pipeline
 * (contactState, acquisitionStage, calidad) — no se agrega ningún algoritmo de
 * detección nuevo, solo se traduce lo que el sistema ya sabe en una guía visual
 * continua en vez de un texto reactivo.
 */

export type GuideLevel = 'none' | 'searching' | 'adjusting' | 'stabilizing' | 'ready';

export interface CameraPeekState {
  /** 0 = cámara totalmente visible (aim libre), 1 = monitor opaco (mínima distracción). */
  monitorOpacity: number;
  guideLevel: GuideLevel;
  /** Color guía (borde del anillo / halo). */
  guideColor: string;
  glowColor: string;
}

interface PeekInput {
  isMonitoring: boolean;
  contactState?: string;
  acquisitionStage?: 'SEARCHING' | 'STABILIZING' | 'READY';
  quality: number;
  placementStable?: boolean;
}

export function computeCameraPeekState(input: PeekInput): CameraPeekState {
  const { isMonitoring, contactState, acquisitionStage, quality, placementStable } = input;

  if (!isMonitoring) {
    // Antes de arrancar: máxima transparencia para que el usuario pueda apuntar
    // el dedo mirando su propia posición a través del monitor.
    return {
      monitorOpacity: 0.22,
      guideLevel: 'none',
      guideColor: 'rgba(148, 163, 184, 0.9)',
      glowColor: 'rgba(148, 163, 184, 0.25)',
    };
  }

  if (contactState === 'NO_CONTACT' || contactState == null) {
    return {
      monitorOpacity: 0.32,
      guideLevel: 'searching',
      guideColor: 'rgba(239, 68, 68, 0.95)',
      glowColor: 'rgba(239, 68, 68, 0.30)',
    };
  }

  if (contactState === 'UNSTABLE_CONTACT') {
    return {
      monitorOpacity: 0.52,
      guideLevel: 'adjusting',
      guideColor: 'rgba(245, 158, 11, 0.95)',
      glowColor: 'rgba(245, 158, 11, 0.28)',
    };
  }

  // STABLE_CONTACT
  if (acquisitionStage !== 'READY' || quality < 55) {
    return {
      monitorOpacity: placementStable ? 0.78 : 0.66,
      guideLevel: 'stabilizing',
      guideColor: 'rgba(56, 189, 248, 0.9)',
      glowColor: 'rgba(56, 189, 248, 0.22)',
    };
  }

  return {
    monitorOpacity: 0.93,
    guideLevel: 'ready',
    guideColor: 'rgba(34, 197, 94, 0.9)',
    glowColor: 'rgba(34, 197, 94, 0.18)',
  };
}

export function guideCaption(level: GuideLevel, hint?: string): string {
  switch (level) {
    case 'searching':
      return 'Cubrí la lente y el flash con la yema del dedo';
    case 'adjusting':
      return hint || 'Ajustá la presión, mantené el dedo quieto';
    case 'stabilizing':
      return 'Quieto… estabilizando señal';
    case 'ready':
      return '';
    default:
      return 'Apuntá el dedo sobre la cámara trasera';
  }
}
