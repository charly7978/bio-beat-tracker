import { describe, expect, it } from 'vitest';
import { median, robustBounds, robustDynamicRange, skewness } from '../stats';

describe('stats', () => {
  it('median de ventana impar/par', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('robustDynamicRange positivo', () => {
    expect(robustDynamicRange([1, 2, 3, 4, 5])).toBeGreaterThan(0);
    const b = robustBounds([10, 20, 30]);
    expect(b.range).toBeGreaterThan(0);
  });

  describe('skewness (SQI Elgendi 2016)', () => {
    it('señal simétrica → ~0', () => {
      expect(Math.abs(skewness([-2, -1, 0, 1, 2]))).toBeLessThan(1e-6);
    });
    it('cola a la derecha (PPG limpio) → positiva', () => {
      // muchos valores bajos + pocos picos altos = subida sistólica abrupta
      expect(skewness([0, 0, 0, 0, 0, 0, 0, 1, 3, 8])).toBeGreaterThan(0);
    });
    it('cola a la izquierda → negativa', () => {
      // masa alta + cola baja (el 0 arrastra una cola a la izquierda)
      expect(skewness([10, 10, 10, 10, 10, 10, 10, 9, 7, 0])).toBeLessThan(0);
    });
    it('señal plana o corta → 0 (sin información)', () => {
      expect(skewness([5, 5, 5, 5])).toBe(0);
      expect(skewness([1, 2])).toBe(0);
    });
  });
});
