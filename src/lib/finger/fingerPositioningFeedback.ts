/**
 * Dispara feedback háptico cuando el dedo entra o sale de la posición
 * "perfect" (contacto estable, bien puesto, aún estabilizando lectura).
 */

import { GuideLevel } from '@/lib/ui/cameraPeek';
import {
  triggerPerfectPositioningHaptic,
  triggerPositioningAdjustmentHaptic,
} from '@/utils/haptics';

export interface PositioningFeedbackState {
  lastWasPerfect: boolean;
  suppressUntil: number;
}

export function createPositioningFeedbackState(): PositioningFeedbackState {
  return {
    lastWasPerfect: false,
    suppressUntil: 0,
  };
}

/**
 * Procesa cambios de estado y dispara feedback apropiado.
 * Detecta transiciones clave y evita feedback redundante.
 */
export async function processFeedback(
  currentLevel: GuideLevel,
  currentTime: number,
  state: PositioningFeedbackState,
): Promise<void> {
  // Evita spam de feedback: espera al menos 400ms entre feedbacks
  if (currentTime < state.suppressUntil) {
    return;
  }

  const currentIsPerfect = currentLevel === 'perfect';

  // Transición a 'perfect': dedo correctamente colocado y estable
  if (currentIsPerfect && !state.lastWasPerfect) {
    await triggerPerfectPositioningHaptic();
    state.suppressUntil = currentTime + 500;
  }

  // Transición fuera de 'perfect': dedo se salió de posición
  // (no alerta si es la transición esperada a 'ready')
  if (!currentIsPerfect && state.lastWasPerfect && currentLevel !== 'ready') {
    await triggerPositioningAdjustmentHaptic();
    state.suppressUntil = currentTime + 400;
  }

  state.lastWasPerfect = currentIsPerfect;
}
