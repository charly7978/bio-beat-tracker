import { describe, it, expect } from 'vitest';
import { createMotionGateState, resetMotionGate, updateMotionGate } from '../motionGate';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

const ENTER = VITAL_THRESHOLDS.QUALITY.MAX_MOTION;
const Q = VITAL_THRESHOLDS.QUALITY;
const OVER = ENTER + 0.4;
const QUIET = 0.05;

function feed(state: ReturnType<typeof createMotionGateState>, score: number, frames: number) {
  for (let i = 0; i < frames; i++) updateMotionGate(state, score, ENTER);
  return state;
}

describe('motionGate (veto de movimiento transitorio vs sostenido)', () => {
  it('un pico AISLADO de movimiento NO activa el veto', () => {
    const st = createMotionGateState();
    updateMotionGate(st, OVER, ENTER);
    expect(st.artifact).toBe(false);
    expect(st.suppression).toBe(0);
  });

  it('un temblor breve (bajo el nº de frames de entrada) NO activa el veto', () => {
    const st = createMotionGateState();
    feed(st, OVER, Q.MOTION_ARTIFACT_ENTER_FRAMES - 1);
    expect(st.artifact).toBe(false);
  });

  it('movimiento SOSTENIDO activa el veto', () => {
    const st = createMotionGateState();
    feed(st, OVER, Q.MOTION_ARTIFACT_ENTER_FRAMES);
    expect(st.artifact).toBe(true);
    expect(st.suppression).toBeGreaterThan(0);
  });

  it('la racha de entrada se rompe si un frame baja del umbral', () => {
    const st = createMotionGateState();
    feed(st, OVER, Q.MOTION_ARTIFACT_ENTER_FRAMES - 1);
    updateMotionGate(st, QUIET, ENTER); // rompe la racha
    feed(st, OVER, Q.MOTION_ARTIFACT_ENTER_FRAMES - 1);
    expect(st.artifact).toBe(false);
  });

  it('histéresis: se libera al caer bajo el umbral de SALIDA (más bajo que el de entrada)', () => {
    const st = createMotionGateState();
    feed(st, OVER, Q.MOTION_ARTIFACT_ENTER_FRAMES);
    expect(st.artifact).toBe(true);

    // Zona intermedia (bajo el de entrada pero sobre el de salida) → sigue vetado.
    const between = (Q.MOTION_ARTIFACT_EXIT_SCORE + ENTER) / 2;
    feed(st, between, 10);
    expect(st.artifact).toBe(true);

    feed(st, QUIET, Q.MOTION_ARTIFACT_EXIT_FRAMES);
    expect(st.artifact).toBe(false);
  });

  it('la supresión post-movimiento es PROPORCIONAL a la duración real', () => {
    const corto = createMotionGateState();
    feed(corto, OVER, Q.MOTION_ARTIFACT_ENTER_FRAMES);
    const supCorta = corto.suppression;

    const largo = createMotionGateState();
    feed(largo, OVER, 40);
    const supLarga = largo.suppression;

    expect(supCorta).toBe(Q.MOTION_SUPPRESSION_MIN_FRAMES);
    expect(supLarga).toBe(Q.MOTION_SUPPRESSION_MAX_FRAMES);
    expect(supLarga).toBeGreaterThan(supCorta);
  });

  it('la supresión decae frame a frame hasta liberar la señal', () => {
    const st = createMotionGateState();
    feed(st, OVER, Q.MOTION_ARTIFACT_ENTER_FRAMES);
    const sup = st.suppression;
    feed(st, QUIET, sup + Q.MOTION_ARTIFACT_EXIT_FRAMES);
    expect(st.artifact).toBe(false);
    expect(st.suppression).toBe(0);
  });

  it('reset deja el veto limpio', () => {
    const st = createMotionGateState();
    feed(st, OVER, 20);
    resetMotionGate(st);
    expect(st).toEqual(createMotionGateState());
  });
});
