import { describe, expect, it } from 'vitest';
import { quickSkewness } from '../dsp';

describe('quickSkewness (Elgendi 2016 SQI)', () => {
  it('señal simétrica → skewness ≈ 0', () => {
    // Senoidal pura es simétrica → skew ≈ 0
    const sine = Array.from({ length: 64 }, (_, i) => Math.sin((i / 64) * 2 * Math.PI * 3));
    const sk = quickSkewness(sine);
    expect(Math.abs(sk)).toBeLessThan(0.1);
  });

  it('PPG-like (sístole alta, valle ancho) → skewness positiva alta', () => {
    // Pulsos asimétricos: pico estrecho + valle ancho.
    const ppg: number[] = [];
    for (let i = 0; i < 4; i++) {
      // 16 muestras por ciclo: sistole pronunciada con power=8 + valle ancho.
      for (let k = 0; k < 16; k++) {
        const phase = k / 16;
        const val = Math.pow(Math.max(0, Math.sin(phase * Math.PI)), 8);
        ppg.push(val);
      }
    }
    const sk = quickSkewness(ppg);
    expect(sk).toBeGreaterThan(0.5);
  });

  it('varianza nula → 0 (sin división por cero)', () => {
    const flat = new Array(32).fill(0.5);
    expect(quickSkewness(flat)).toBe(0);
  });

  it('muestra insuficiente → 0', () => {
    expect(quickSkewness([1, 2, 3])).toBe(0);
  });

  it('respeta offset y length (zero-alloc)', () => {
    const data = [0, 0, 0, 0].concat(
      Array.from({ length: 64 }, (_, i) => Math.sin((i / 64) * 2 * Math.PI * 3)),
    );
    const sk = quickSkewness(data, 4, 64);
    expect(Math.abs(sk)).toBeLessThan(0.1);
  });
});
