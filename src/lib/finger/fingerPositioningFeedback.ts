/**
 * Maneja el feedback (visual, háptico, audio) cuando el dedo se mueve
 * dentro o fuera de la posición perfecta.
 */

import { GuideLevel } from '@/lib/ui/cameraPeek';
import {
  triggerPerfectPositioningHaptic,
  triggerPositioningAdjustmentHaptic,
} from '@/utils/haptics';

export interface PositioningFeedbackState {
  lastGuideLevel: GuideLevel;
  lastCenteringScore: number;
  lastWasPerfect: boolean;
  lastFeedbackTime: number;
  suppressUntil: number;
}

/**
 * Crea un estado inicial de feedback
 */
export function createPositioningFeedbackState(): PositioningFeedbackState {
  return {
    lastGuideLevel: 'none',
    lastCenteringScore: 0,
    lastWasPerfect: false,
    lastFeedbackTime: 0,
    suppressUntil: 0,
  };
}

/**
 * Procesa cambios de estado y dispara feedback apropiado.
 * Detecta transiciones clave y evita feedback redundante.
 */
export async function processFeedback(
  currentLevel: GuideLevel,
  currentCenteringScore: number,
  currentTime: number,
  state: PositioningFeedbackState,
): Promise<void> {
  // Evita spam de feedback: espera al menos 400ms entre feedbacks
  if (currentTime < state.suppressUntil) {
    return;
  }

  const currentIsPerfect = currentLevel === 'perfect' && currentCenteringScore >= 0.75;
  const levelChanged = currentLevel !== state.lastGuideLevel;
  const scoreImproved = currentCenteringScore > state.lastCenteringScore + 0.2;
  const scoreWorsened = currentCenteringScore < state.lastCenteringScore - 0.2;

  // Transición a 'perfect': dedo correctamente centrado
  if (currentIsPerfect && !state.lastWasPerfect) {
    await triggerPerfectPositioningHaptic();
    state.suppressUntil = currentTime + 500;
  }

  // Transición fuera de 'perfect': dedo se salió del círculo
  if (!currentIsPerfect && state.lastWasPerfect && currentLevel !== 'ready') {
    // Solo alerta si realmente se degradó, no si es transición esperada a 'ready'
    await triggerPositioningAdjustmentHaptic();
    state.suppressUntil = currentTime + 400;
  }

  // Degradación severa durante ajuste (ej: de 'adjusting' con score 0.6 a 0.2)
  if (
    currentLevel === 'adjusting' &&
    scoreWorsened &&
    currentCenteringScore < 0.4
  ) {
    await triggerPositioningAdjustmentHaptic();
    state.suppressUntil = currentTime + 600;
  }

  // Actualiza el estado
  state.lastGuideLevel = currentLevel;
  state.lastCenteringScore = currentCenteringScore;
  state.lastWasPerfect = currentIsPerfect;
  state.lastFeedbackTime = currentTime;
}

/**
 * Determina el mensaje de feedback visual basado en el estado y el hint de corrección.
 */
export function getPositioningFeedbackMessage(
  guideLevel: GuideLevel,
  centeringScore: number,
  correctionHint?: string | null,
): string {
  switch (guideLevel) {
    case 'ready':
      return 'Lectura completa - retira el dedo cuando esté listo';

    case 'perfect':
      if (centeringScore > 0.9) {
        return '✓ ¡Excelente! Mantiéndolo así';
      }
      return '✓ Perfecto - quedate quieto';

    case 'adjusting':
      if (correctionHint) {
        const hints: Record<string, string> = {
          move_left: '← Mové a la izquierda',
          move_right: 'Mové a la derecha →',
          move_up: '↑ Mové hacia arriba',
          move_down: 'Mové hacia abajo ↓',
          move_closer: '⊙ Acercá el dedo',
        };
        return hints[correctionHint] || 'Ajustá la posición';
      }

      if (centeringScore < 0.3) {
        return 'Acercá el dedo más al centro';
      }
      if (centeringScore < 0.6) {
        return 'Casi ahí - centrá bien el dedo';
      }
      return 'Ajustá para que quede perfecto';

    case 'searching':
      return 'Cubrí lente + flash con la yema';

    default:
      return 'Apuntá el dedo sobre la cámara';
  }
}
