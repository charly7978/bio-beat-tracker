import { describe, it, expect } from 'vitest';
import { redSeriesCoefficientOfVariation } from '../fingerRoiPulsation';

describe('fingerRoiPulsation', () => {
  it('CV ~0 en serie casi constante', () => {
    const a = new Float32Array(15);
    a.fill(100);
    expect(redSeriesCoefficientOfVariation(a)).toBeLessThan(0.002);
  });

  it('CV > 0 con oscilación sinusoidal en R', () => {
    const a = new Float32Array(20);
    for (let i = 0; i < 20; i++) a[i] = 100 + Math.sin(i * 0.5) * 3;
    expect(redSeriesCoefficientOfVariation(a)).toBeGreaterThan(0.012);
  });

  it('respeta count cuando el buffer es más largo', () => {
    const a = new Float32Array(20);
    for (let i = 0; i < 20; i++) a[i] = 100 + Math.sin(i * 0.4) * 2;
    expect(redSeriesCoefficientOfVariation(a, 15)).toBeGreaterThan(0.005);
  });
});
