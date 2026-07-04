import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { logWarn } from './logger';

const HAPTICS_SCOPE = 'Haptics';

/**
 * Activa una vibración háptica muy corta y sutil.
 * Diseñada específicamente para simular un latido de corazón individual.
 */
export async function triggerHeartbeatHaptic(): Promise<void> {
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(45);
      }
    } catch {
      logWarn(HAPTICS_SCOPE, 'Vibrate API not available');
    }
  }
}

/**
 * Activa una vibración háptica fuerte de advertencia.
 * Diseñada para alertar sobre la detección de una arritmia cardíaca.
 */
export async function triggerArrhythmiaHaptic(): Promise<void> {
  try {
    await Haptics.notification({ type: NotificationType.Warning });
  } catch {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([150, 100, 150]);
      }
    } catch {
      logWarn(HAPTICS_SCOPE, 'Vibrate fallback failed for arrhythmia');
    }
  }
}

/**
 * Activa una vibración para indicar el fin de la calibración de señal.
 */
export async function triggerCalibrationCompleteHaptic(): Promise<void> {
  try {
    await Haptics.impact({ style: ImpactStyle.Medium });
  } catch {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(100);
      }
    } catch {
      logWarn(HAPTICS_SCOPE, 'Vibrate fallback failed for calibration');
    }
  }
}

/**
 * Activa una vibración para indicar el inicio de la sesión de monitoreo.
 */
export async function triggerSessionStartHaptic(): Promise<void> {
  try {
    await Haptics.impact({ style: ImpactStyle.Medium });
  } catch {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(200);
      }
    } catch {
      logWarn(HAPTICS_SCOPE, 'Vibrate fallback failed for session start');
    }
  }
}

/**
 * Vibración corta y suave: se confirma que el dedo quedó bien colocado y el
 * contacto es estable (transición a STABLE_CONTACT). Refuerzo háptico para que
 * el usuario no dependa solo de la vista para saber que "ya está".
 */
export async function triggerFingerLockHaptic(): Promise<void> {
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(35);
      }
    } catch {
      logWarn(HAPTICS_SCOPE, 'Vibrate fallback failed for finger lock');
    }
  }
}

/**
 * Vibración doble y corta: se perdió el contacto estable del dedo durante una
 * medición en curso, para alertar sin necesidad de mirar la pantalla.
 */
export async function triggerFingerLostHaptic(): Promise<void> {
  try {
    await Haptics.impact({ style: ImpactStyle.Medium });
  } catch {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([40, 60, 40]);
      }
    } catch {
      logWarn(HAPTICS_SCOPE, 'Vibrate fallback failed for finger lost');
    }
  }
}

/**
 * Activa una vibración especial para indicar que la sesión de monitoreo finalizó correctamente.
 */
export async function triggerSessionEndHaptic(): Promise<void> {
  try {
    await Haptics.notification({ type: NotificationType.Success });
  } catch {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([100, 50, 100, 50, 200]);
      }
    } catch {
      logWarn(HAPTICS_SCOPE, 'Vibrate fallback failed for session end');
    }
  }
}

/**
 * Vibración de confirmación: el dedo está PERFECTAMENTE posicionado y centrado
 * en el círculo guía. Feedback táctil suave pero claro para indicar la posición óptima.
 */
export async function triggerPerfectPositioningHaptic(): Promise<void> {
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(30);
      }
    } catch {
      logWarn(HAPTICS_SCOPE, 'Vibrate fallback failed for perfect positioning');
    }
  }
}

/**
 * Vibración de alerta: el dedo se salió del área óptima del círculo guía.
 * Feedback táctil para alertar que necesita reajustar la posición.
 */
export async function triggerPositioningAdjustmentHaptic(): Promise<void> {
  try {
    await Haptics.impact({ style: ImpactStyle.Medium });
  } catch {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([40, 40]);
      }
    } catch {
      logWarn(HAPTICS_SCOPE, 'Vibrate fallback failed for positioning adjustment');
    }
  }
}
