import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { FingerCenteringMetrics } from '@/lib/finger/fingerPositioningValidator';

/**
 * Calcula cuánta "ventana" de cámara debe verse a través del monitor cardíaco
 * (efecto vidrio esmerilado), dónde va EXACTAMENTE el anillo guía (mapeado a
 * la misma región de píxeles que el algoritmo realmente muestrea — no un
 * círculo decorativo) y cuándo el sistema puede decir "perfecto, quieto".
 *
 * Ahora integra métricas de centrado del dedo para validar que está
 * EXACTAMENTE en la posición requerida, no solo en contacto.
 */

export type GuideLevel = 'none' | 'searching' | 'adjusting' | 'perfect' | 'ready';

export interface CameraPeekState {
  /** 0 = cámara totalmente visible (aim libre), 1 = monitor opaco (mínima distracción). */
  monitorOpacity: number;
  guideLevel: GuideLevel;
  /** Color guía (borde del anillo / halo). */
  guideColor: string;
  glowColor: string;
  /** Métricas de centrado del dedo (si disponibles) */
  centeringMetrics?: FingerCenteringMetrics;
  /** Si el dedo está perfectamente centrado y el sistema está listo */
  isPerfectlyPositioned?: boolean;
}

interface PeekInput {
  isMonitoring: boolean;
  contactState?: string;
  acquisitionStage?: 'SEARCHING' | 'STABILIZING' | 'READY';
  quality: number;
  placementStable?: boolean;
  /** Métricas de centrado (opcional, mejora feedback visual) */
  centeringMetrics?: FingerCenteringMetrics;
}

export function computeCameraPeekState(input: PeekInput): CameraPeekState {
  const { isMonitoring, contactState, acquisitionStage, quality, placementStable, centeringMetrics } = input;

  if (!isMonitoring) {
    // Antes de arrancar: máxima transparencia para que el usuario pueda apuntar
    // el dedo mirando su propia posición a través del monitor.
    return {
      monitorOpacity: 0.22,
      guideLevel: 'none',
      guideColor: 'rgba(148, 163, 184, 0.9)',
      glowColor: 'rgba(148, 163, 184, 0.25)',
      centeringMetrics,
      isPerfectlyPositioned: false,
    };
  }

  // Usa métricas de centrado si están disponibles para validación más exacta
  if (centeringMetrics && contactState === 'STABLE_CONTACT') {
    return computePeekStateWithCentering(
      centeringMetrics,
      acquisitionStage,
      quality,
    );
  }

  // Fallback: lógica anterior basada solo en contactState
  if (contactState === 'NO_CONTACT' || contactState == null) {
    return {
      monitorOpacity: 0.32,
      guideLevel: 'searching',
      guideColor: 'rgba(239, 68, 68, 0.95)',
      glowColor: 'rgba(239, 68, 68, 0.30)',
      centeringMetrics,
      isPerfectlyPositioned: false,
    };
  }

  // Contacto detectado pero TODAVÍA no confirmado como "bien puesto y quieto"
  if (contactState === 'UNSTABLE_CONTACT' || !placementStable) {
    return {
      monitorOpacity: 0.55,
      guideLevel: 'adjusting',
      guideColor: 'rgba(245, 158, 11, 0.95)',
      glowColor: 'rgba(245, 158, 11, 0.28)',
      centeringMetrics,
      isPerfectlyPositioned: false,
    };
  }

  // STABLE_CONTACT + placementStable === true
  if (acquisitionStage !== 'READY' || quality < 55) {
    return {
      monitorOpacity: 0.72,
      guideLevel: 'perfect',
      guideColor: 'rgba(34, 197, 94, 0.95)',
      glowColor: 'rgba(34, 197, 94, 0.24)',
      centeringMetrics,
      isPerfectlyPositioned: false,
    };
  }

  return {
    monitorOpacity: 0.93,
    guideLevel: 'ready',
    guideColor: 'rgba(34, 197, 94, 0.9)',
    glowColor: 'rgba(34, 197, 94, 0.18)',
    centeringMetrics,
    isPerfectlyPositioned: true,
  };
}

/**
 * Computa el estado del peek usando métricas avanzadas de centrado.
 * Proporciona feedback más preciso sobre el posicionamiento del dedo.
 */
function computePeekStateWithCentering(
  metrics: FingerCenteringMetrics,
  acquisitionStage?: string,
  quality: number = 0,
): CameraPeekState {
  // Muy baja cobertura: buscando
  if (metrics.centeringScore < 0.3 || !metrics.isWithinAcceptableRange) {
    return {
      monitorOpacity: 0.32,
      guideLevel: 'searching',
      guideColor: 'rgba(239, 68, 68, 0.95)',
      glowColor: 'rgba(239, 68, 68, 0.30)',
      centeringMetrics: metrics,
      isPerfectlyPositioned: false,
    };
  }

  // Cobertura decente pero no bien centrado: ajustando
  if (metrics.centeringScore < 0.75) {
    return {
      monitorOpacity: 0.55,
      guideLevel: 'adjusting',
      guideColor: 'rgba(245, 158, 11, 0.95)',
      glowColor: 'rgba(245, 158, 11, 0.28)',
      centeringMetrics: metrics,
      isPerfectlyPositioned: false,
    };
  }

  // Bien centrado pero aún estabilizando
  if (acquisitionStage !== 'READY' || quality < 55) {
    return {
      monitorOpacity: 0.72,
      guideLevel: 'perfect',
      guideColor: 'rgba(34, 197, 94, 0.95)',
      glowColor: 'rgba(34, 197, 94, 0.24)',
      centeringMetrics: metrics,
      isPerfectlyPositioned: false,
    };
  }

  // Perfectamente centrado y estable: ready
  return {
    monitorOpacity: 0.93,
    guideLevel: 'ready',
    guideColor: 'rgba(34, 197, 94, 0.9)',
    glowColor: 'rgba(34, 197, 94, 0.18)',
    centeringMetrics: metrics,
    isPerfectlyPositioned: true,
  };
}

/**
 * Genera caption para el círculo guía basado en nivel y hints de corrección.
 */
export function guideCaption(
  level: GuideLevel,
  hint?: string,
  correctionHint?: FingerCenteringMetrics['correctionHint'],
): string {
  switch (level) {
    case 'searching':
      return 'Cubrí la lente y el flash con la yema del dedo';
    case 'adjusting': {
      // Si hay hint de corrección específico, usarlo
      if (correctionHint) {
        const corrections: Record<string, string> = {
          move_left: 'Mové el dedo a la derecha',
          move_right: 'Mové el dedo a la izquierda',
          move_up: 'Mové el dedo hacia abajo',
          move_down: 'Mové el dedo hacia arriba',
          move_closer: 'Acercá el dedo más',
        };
        return corrections[correctionHint] || 'Centrá el dedo en el círculo';
      }
      return hint || 'Centrá el dedo en el círculo, presión media';
    }
    case 'perfect':
      return '¡Perfecto! Quedate quieto';
    case 'ready':
      return '';
    default:
      return 'Apuntá el dedo sobre la cámara trasera';
  }
}

export interface RoiScreenRect {
  cx: number;
  cy: number;
  r: number;
}

/**
 * Traduce el ROI cuadrado que el algoritmo REALMENTE muestrea (ver
 * `computeRoiRect`/`ROI_SIZE_FRACTION` en `PPGSignalProcessor.ts`, centrado en
 * el frame de la cámara) a coordenadas de pantalla, considerando que el
 * `<video>` se muestra con `object-fit: cover` (recorte + escalado). Así el
 * anillo que ve el usuario coincide en pantalla con los píxeles exactos que
 * se procesan — deja de ser un círculo decorativo.
 */
export function computeRoiScreenRect(
  videoW: number,
  videoH: number,
  screenW: number,
  screenH: number,
): RoiScreenRect | null {
  if (!videoW || !videoH || !screenW || !screenH) return null;

  const scale = Math.max(screenW / videoW, screenH / videoH);
  const dispW = videoW * scale;
  const dispH = videoH * scale;
  const offsetX = (screenW - dispW) / 2;
  const offsetY = (screenH - dispH) / 2;

  const roiFraction = VITAL_THRESHOLDS.FINGER.ROI_SIZE_FRACTION;
  const roiSideNative = Math.min(videoW, videoH) * roiFraction;

  // Clamp de seguridad: en el caso normal (cámara trasera de un teléfono en
  // portrait, que entrega el frame ya rotado a portrait) esto no debería
  // activarse casi nunca. Pero si el video llega en una relación de aspecto
  // muy distinta a la pantalla (p. ej. cámaras de escritorio/webcams en
  // landscape, o un frame aún sin rotar), evita un anillo absurdamente
  // grande o chico y mantiene siempre una referencia visual utilizable.
  const screenMin = Math.min(screenW, screenH);
  const r = Math.max(screenMin * 0.16, Math.min((roiSideNative * scale) / 2, screenMin * 0.42));

  // Mismo espíritu de robustez: si el centro geométrico cae fuera de la
  // pantalla (aspect ratio muy distinto), lo recentramos sin perder la
  // referencia visual — mejor un anillo levemente desplazado que uno
  // invisible fuera del viewport.
  const cx = Math.max(r, Math.min(offsetX + (videoW / 2) * scale, screenW - r));
  const cy = Math.max(r, Math.min(offsetY + (videoH / 2) * scale, screenH - r));

  return { cx, cy, r };
}
