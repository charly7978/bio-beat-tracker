import { describe, it, expect } from 'vitest';
import {
  createCardiacPresence,
  updateCardiacPresence,
  computeInstantConfidence,
  resetCardiacPresence,
  type CardiacPresenceSample,
} from '../CardiacPresenceEngine';

const FS = 30;

/** Latido PPG sintético: fundamental + armónicos (subida sistólica asimétrica). */
function pulseWindow(seconds: number, bpm: number, noise = 0): number[] {
  const n = Math.round(seconds * FS);
  const f = bpm / 60;
  const out: number[] = [];
  let seed = 12345;
  const rand = () => {
    // PRNG determinista (test reproducible; no es simulación de señal).
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const phase = TWO_PI * f * t;
    // Morfología asimétrica → skewness positiva + armónicos coherentes.
    const v =
      Math.sin(phase) +
      0.35 * Math.sin(2 * phase + 0.3) +
      0.15 * Math.sin(3 * phase + 0.6);
    out.push(v + noise * rand());
  }
  return out;
}
const TWO_PI = Math.PI * 2;

function whiteNoise(seconds: number): number[] {
  const n = Math.round(seconds * FS);
  const out: number[] = [];
  let seed = 98765;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out.push(seed / 0x7fffffff - 0.5);
  }
  return out;
}

function ramp(seconds: number): number[] {
  const n = Math.round(seconds * FS);
  return Array.from({ length: n }, (_, i) => i * 0.01);
}

function sampleFrom(
  signal: number[],
  over: Partial<CardiacPresenceSample> = {},
): CardiacPresenceSample {
  return {
    signal,
    fs: FS,
    perfusionIndex: 0.002,
    skewness: 0.3,
    motion: 0,
    opticalValid: true,
    nowMs: 0,
    ...over,
  };
}

describe('CardiacPresenceEngine — presencia de pulso real', () => {
  it('confianza ALTA para un pulso sintético limpio a 72 BPM', () => {
    const state = createCardiacPresence();
    const conf = computeInstantConfidence(sampleFrom(pulseWindow(6, 72)), state);
    expect(conf).toBeGreaterThan(0.6);
    expect(state.subScores.spectralConcentration).toBeGreaterThan(0.5);
    expect(state.subScores.template).toBeGreaterThan(0.5);
    expect(state.bpm).toBeGreaterThan(66);
    expect(state.bpm).toBeLessThan(78);
  });

  it('confianza BAJA para ruido blanco (objeto sin pulso)', () => {
    const state = createCardiacPresence();
    const conf = computeInstantConfidence(sampleFrom(whiteNoise(6)), state);
    expect(conf).toBeLessThan(0.35);
  });

  it('confianza BAJA para una rampa/DC (objeto rojo inerte)', () => {
    const state = createCardiacPresence();
    const conf = computeInstantConfidence(sampleFrom(ramp(6)), state);
    expect(conf).toBeLessThan(0.35);
  });

  it('confianza ~0 si el frame no es ópticamente válido (saturado/negro)', () => {
    const state = createCardiacPresence();
    const conf = computeInstantConfidence(
      sampleFrom(pulseWindow(6, 72), { opticalValid: false }),
      state,
    );
    expect(conf).toBe(0);
  });

  it('declara present=true tras sostener el pulso, y NO con ruido', () => {
    const pulse = createCardiacPresence();
    for (let i = 0; i < 80; i++) {
      updateCardiacPresence(pulse, sampleFrom(pulseWindow(6, 72), { nowMs: i * 33 }));
    }
    expect(pulse.present).toBe(true);
    expect(pulse.bpm).toBeGreaterThan(66);

    const noise = createCardiacPresence();
    for (let i = 0; i < 80; i++) {
      updateCardiacPresence(noise, sampleFrom(whiteNoise(6), { nowMs: i * 33 }));
    }
    expect(noise.present).toBe(false);
  });

  it('retira la presencia (dwell) cuando el pulso desaparece', () => {
    const state = createCardiacPresence();
    for (let i = 0; i < 80; i++) {
      updateCardiacPresence(state, sampleFrom(pulseWindow(6, 72), { nowMs: i * 33 }));
    }
    expect(state.present).toBe(true);
    // El dedo se retira → ruido/negro sostenido.
    for (let i = 0; i < 60; i++) {
      updateCardiacPresence(state, sampleFrom(whiteNoise(6), { nowMs: (80 + i) * 33 }));
    }
    expect(state.present).toBe(false);
    expect(state.bpm).toBe(0);
  });

  it('reset deja el estado limpio', () => {
    const state = createCardiacPresence();
    for (let i = 0; i < 40; i++) {
      updateCardiacPresence(state, sampleFrom(pulseWindow(6, 72), { nowMs: i * 33 }));
    }
    resetCardiacPresence(state);
    expect(state.present).toBe(false);
    expect(state.confidence).toBe(0);
    expect(state.bpm).toBe(0);
    expect(state.bpmHistory.length).toBe(0);
  });
});
