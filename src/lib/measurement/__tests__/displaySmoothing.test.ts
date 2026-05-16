import { describe, expect, it } from 'vitest';
import { smoothDisplayValue } from '../displaySmoothing';

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
      v = smoothDisplayValue(v, 0, 0.22);
    }
    expect(v).toBeLessThan(20);
  });
});
