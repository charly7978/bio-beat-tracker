import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

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
      // Ignorar errores en navegadores que no admiten vibración
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
      // Ignorar
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
      // Ignorar
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
      // Ignorar
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
      // Ignorar
    }
  }
}
