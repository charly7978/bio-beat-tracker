import { describe, expect, it } from 'vitest';
import { applyPulseAgc, createPulseAgcState } from '../pulseAgc';

describe('pulseAgc', () => {
  it('refuerza pulsos débiles periódicos', () => {
    const state = createPulseAgcState();
    const out: number[] = [];
    for (let i = 0; i < 120; i++) {
      const t = i / 30;
      const weak = 0.35 * Math.sin(2 * Math.PI * 1.1 * t);
      out.push(applyPulseAgc(state, weak, 0.72, 0.1));
    }
    const tail = out.slice(-30);
    const amp = Math.max(...tail.map(Math.abs));
    expect(amp).toBeGreaterThan(2);
    expect(state.scale).toBeGreaterThan(1.2);
  });

  it('no amplifica ruido plano sin periodicidad', () => {
    const state = createPulseAgcState();
    let last = 0;
    for (let i = 0; i < 80; i++) {
      last = applyPulseAgc(state, (Math.random() - 0.5) * 0.05, 0.05, 0.6);
    }
    expect(Math.abs(last)).toBeLessThan(1.0);
    expect(state.scale).toBeGreaterThanOrEqual(2);
  });
});
