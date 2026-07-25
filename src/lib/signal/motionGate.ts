import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { clamp } from '@/utils/math';

/**
 * VETO DE MOVIMIENTO CON HISTÉRESIS (transitorio vs sostenido).
 *
 * El temblor fisiológico de la mano y los micro-reajustes del dedo sobre la lente
 * producen picos BREVES del score de movimiento. Vetar la señal al primer frame
 * por encima del umbral —y suprimir un número FIJO de frames después— convierte
 * un temblor de milisegundos en la pérdida de la ventana de adquisición entera,
 * que es justo lo que impide al usuario llegar a ver su lectura.
 *
 * Criterio (alineado con AGENTS §5 «el movimiento degrada o pausa, no destruye»):
 *   - ENTRAR al veto exige N frames CONSECUTIVOS sobre el umbral → un blip aislado
 *     no veta nada.
 *   - SALIR exige menos frames y un umbral MÁS BAJO (histéresis asimétrica) → una
 *     vez que el movimiento real cesa, la señal se recupera rápido.
 *   - La supresión post-movimiento (ringing del bandpass de 4º orden) es
 *     PROPORCIONAL a lo que duró el movimiento, no un valor fijo.
 *
 * Es lógica pura y sin estado global: el procesador delega aquí para que el
 * comportamiento sea verificable por tests sin arrancar la cámara.
 */
export interface MotionGateState {
  /** Veto activo → `MOTION_ARTIFACT` (la señal no se publica este frame). */
  artifact: boolean;
  /** Frames consecutivos por encima del umbral de entrada. */
  overStreak: number;
  /** Frames consecutivos por debajo del umbral de salida. */
  underStreak: number;
  /** Frames que lleva el veto activo — dimensiona la supresión posterior. */
  artifactFrames: number;
  /** Frames restantes de supresión post-movimiento (0 = señal utilizable). */
  suppression: number;
}

export function createMotionGateState(): MotionGateState {
  return {
    artifact: false,
    overStreak: 0,
    underStreak: 0,
    artifactFrames: 0,
    suppression: 0,
  };
}

export function resetMotionGate(state: MotionGateState): void {
  state.artifact = false;
  state.overStreak = 0;
  state.underStreak = 0;
  state.artifactFrames = 0;
  state.suppression = 0;
}

/**
 * Avanza el veto un frame.
 *
 * @param motionScore Score de movimiento del frame (IMU, 0..~2).
 * @param enterScore  Umbral de entrada al veto (`QUALITY.MAX_MOTION`).
 * @returns El mismo estado, ya actualizado (mutación in-place: hot path por frame).
 */
export function updateMotionGate(
  state: MotionGateState,
  motionScore: number,
  enterScore: number,
): MotionGateState {
  const Q = VITAL_THRESHOLDS.QUALITY;

  if (motionScore > enterScore) {
    state.overStreak += 1;
    state.underStreak = 0;
  } else {
    state.overStreak = 0;
    state.underStreak =
      motionScore <= Q.MOTION_ARTIFACT_EXIT_SCORE ? state.underStreak + 1 : 0;
  }

  if (!state.artifact) {
    if (state.overStreak >= Q.MOTION_ARTIFACT_ENTER_FRAMES) {
      state.artifact = true;
      state.underStreak = 0;
    }
  } else if (state.underStreak >= Q.MOTION_ARTIFACT_EXIT_FRAMES) {
    state.artifact = false;
  }

  if (state.artifact) {
    state.artifactFrames += 1;
    state.suppression = Math.round(
      clamp(
        state.artifactFrames * Q.MOTION_SUPPRESSION_PER_FRAME,
        Q.MOTION_SUPPRESSION_MIN_FRAMES,
        Q.MOTION_SUPPRESSION_MAX_FRAMES,
      ),
    );
  } else {
    state.artifactFrames = 0;
    if (state.suppression > 0) state.suppression -= 1;
  }

  return state;
}
