import { describe, expect, it } from 'vitest';
import { DISPLAY_SMOOTH_ALPHAS, smoothDisplayValue } from '../displaySmoothing';

describe('displaySmoothing', () => {
  it('converge rápido ante salto grande', () => {
    let v = 70;
    for (let i = 0; i < 6; i++) {
      v = smoothDisplayValue(v, 92, 0.28);
    }
    expect(v).toBeGreaterThanOrEqual(88);
  });

  it('decae hacia cero sin quedarse pegado', () => {
    let v = 98;
    for (let i = 0; i < 12; i++) {
      v = smoothDisplayValue(v, 0, DISPLAY_SMOOTH_ALPHAS.spo2);
    }
    expect(v).toBeLessThan(20);
  });

  it('alphas de vitales son sutiles (< 0.2)', () => {
    expect(DISPLAY_SMOOTH_ALPHAS.hr).toBeLessThan(0.2);
    expect(DISPLAY_SMOOTH_ALPHAS.spo2).toBeLessThan(0.2);
    expect(DISPLAY_SMOOTH_ALPHAS.bp).toBeLessThan(0.2);
  });
});
