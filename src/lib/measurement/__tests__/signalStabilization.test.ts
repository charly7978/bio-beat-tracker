import { describe, it, expect } from 'vitest';
import {
  createStabilizationState,
  updateStabilization,
  type StabilizationSample,
} from '../signalStabilization';

function feed(
  state: ReturnType<typeof createStabilizationState>,
  frames: number,
  sample: (i: number) => Partial<StabilizationSample>,
) {
  let last = updateStabilization(state, base(0, sample(0)));
  for (let i = 1; i < frames; i++) {
    last = updateStabilization(state, base(i, sample(i)));
  }
  return last;
}

function base(i: number, over: Partial<StabilizationSample>): StabilizationSample {
  return {
    hasContact: true,
    bpm: 70,
    sqi: 55,
    perfusionIndex: 0.003,
    periodicity: 0.55,
    motionScore: 0.15,
    nowMs: i * 33, // ~30 fps
    ...over,
  };
}

describe('signalStabilization (convergencia, no timer)', () => {
  it('sin contacto → SEARCHING, no estabiliza', () => {
    const st = createStabilizationState();
    const r = updateStabilization(st, base(0, { hasContact: false }));
    expect(r.stage).toBe('SEARCHING');
    expect(r.stabilized).toBe(false);
    expect(r.progress).toBe(0);
  });

  it('BPM estable + calidad sostenida → converge a READY', () => {
    const st = createStabilizationState();
    // ~140 frames (~4.6 s) con BPM constante y buena calidad supera MIN_WINDOW_MS.
    const r = feed(st, 140, () => ({ bpm: 72 }));
    expect(r.stabilized).toBe(true);
    expect(r.stage).toBe('READY');
    expect(r.progress).toBeGreaterThan(0.99);
  });

  it('BPM que DERIVA (no converge) → nunca estabiliza, progreso estancado', () => {
    const st = createStabilizationState();
    // BPM oscilando ±15 bpm (spread > BPM_SPREAD_MAX) durante mucho tiempo.
    const r = feed(st, 200, (i) => ({ bpm: 70 + (i % 30) }));
    expect(r.stabilized).toBe(false);
    expect(r.stage).toBe('STABILIZING');
    expect(r.progress).toBeLessThan(1);
  });

  it('calidad pobre (SQI bajo) → no estabiliza aunque el BPM sea estable', () => {
    const st = createStabilizationState();
    const r = feed(st, 160, () => ({ bpm: 72, sqi: 12 }));
    expect(r.stabilized).toBe(false);
  });

  it('una vez estable, un blip transitorio no des-revela (latch)', () => {
    const st = createStabilizationState();
    feed(st, 140, () => ({ bpm: 72 }));
    // Un frame malo despues de estabilizar.
    const r = updateStabilization(st, base(200, { bpm: 72, motionScore: 1.5 }));
    expect(r.stabilized).toBe(true);
  });

  it('perder el contacto resetea la estabilización', () => {
    const st = createStabilizationState();
    feed(st, 140, () => ({ bpm: 72 }));
    const r = updateStabilization(st, base(300, { hasContact: false }));
    expect(r.stabilized).toBe(false);
    expect(r.stage).toBe('SEARCHING');
  });
});
