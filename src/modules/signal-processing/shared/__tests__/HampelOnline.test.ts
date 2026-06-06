import { describe, it, expect } from 'vitest';
import {
  createHampelState,
  applyHampelOnline,
  resetHampelState,
} from '../HampelOnline';

describe('HampelOnline', () => {
  describe('operación básica', () => {
    it('pasa señal limpia sin modificar (< 3σ)', () => {
      const state = createHampelState(7);
      // Alimentamos una señal constante
      for (let i = 0; i < 10; i++) {
        const out = applyHampelOnline(state, 50, 3.0);
        if (i >= 2) {
          expect(out).toBeCloseTo(50, 4);
        }
      }
    });

    it('reemplaza spike 5σ por mediana', () => {
      const state = createHampelState(7);
      // Señal de base = 50
      for (let i = 0; i < 6; i++) {
        applyHampelOnline(state, 50, 3.0);
      }
      // Spike enorme
      const out = applyHampelOnline(state, 500, 3.0);
      // Debería devolver algo cercano a la mediana (50), no 500
      expect(out).toBeLessThan(100);
    });

    it('no reemplaza variación fisiológica moderada (< 3σ)', () => {
      const state = createHampelState(7);
      const base = 100;
      for (let i = 0; i < 6; i++) {
        applyHampelOnline(state, base + Math.sin(i) * 5, 3.0);
      }
      // Variación dentro de ±5 sobre base 100 → no es outlier
      const out = applyHampelOnline(state, base + 4, 3.0);
      expect(out).toBeGreaterThan(90);
      expect(out).toBeLessThan(115);
    });

    it('maneja NaN devolviendo 0', () => {
      const state = createHampelState(7);
      const out = applyHampelOnline(state, NaN, 3.0);
      expect(out).toBe(0);
    });

    it('maneja Infinity devolviendo 0', () => {
      const state = createHampelState(7);
      const out = applyHampelOnline(state, Infinity, 3.0);
      expect(out).toBe(0);
    });
  });

  describe('reset', () => {
    it('reinicia el estado correctamente', () => {
      const state = createHampelState(7);
      for (let i = 0; i < 7; i++) {
        applyHampelOnline(state, 100, 3.0);
      }
      expect(state.count).toBe(7);
      resetHampelState(state);
      expect(state.count).toBe(0);
      expect(state.head).toBe(0);
    });
  });

  describe('ventana pequeña', () => {
    it('funciona con ventana mínima (3)', () => {
      const state = createHampelState(3);
      applyHampelOnline(state, 10, 3.0);
      applyHampelOnline(state, 10, 3.0);
      const out = applyHampelOnline(state, 10, 3.0);
      expect(out).toBeCloseTo(10, 3);
    });
  });
});
