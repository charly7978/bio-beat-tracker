import { describe, it, expect } from 'vitest';
import { tilePulsatility, pulsatilityBoost } from '../tileFusion';

function pulseWave(n: number, amp: number, dc: number, periodSamples: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(dc + amp * Math.sin((2 * Math.PI * i) / periodSamples));
  return out;
}

describe('tileFusion (fusión multi-celda por pulsatilidad)', () => {
  describe('tilePulsatility', () => {
    it('celda con pulso fuerte → pulsatilidad mayor que una plana', () => {
      const fuerte = pulsatility_of(pulseWave(60, 8, 120, 18)); // AC 8 sobre DC 120
      const plana = pulsatility_of(new Array(60).fill(120)); // sin pulso
      expect(fuerte).toBeGreaterThan(plana);
      expect(plana).toBeCloseTo(0, 3);
    });

    it('más amplitud de pulso → más pulsatilidad', () => {
      const debil = pulsatility_of(pulseWave(60, 3, 120, 18));
      const fuerte = pulsatility_of(pulseWave(60, 12, 120, 18));
      expect(fuerte).toBeGreaterThan(debil);
    });

    it('ignora deriva lenta de línea base (no la confunde con pulso)', () => {
      // Rampa pura (deriva), sin oscilación → pulsatilidad baja tras detrend.
      const rampa = Array.from({ length: 60 }, (_, i) => 120 + i * 2);
      expect(pulsatility_of(rampa)).toBeLessThan(0.05);
    });

    it('datos insuficientes → 0 (fallback)', () => {
      expect(tilePulsatility([120, 121, 119])).toBe(0);
    });
  });

  describe('pulsatilityBoost', () => {
    it('mejor celda (pulsatilidad = max) recibe el realce completo', () => {
      expect(pulsatilityBoost(0.1, 0.1, 3)).toBeCloseTo(4, 5); // 1 + 3*1
    });
    it('peor celda (pulsatilidad 0) recibe realce neutro (1)', () => {
      expect(pulsatilityBoost(0, 0.1, 3)).toBeCloseTo(1, 5);
    });
    it('sin info de pulsatilidad (max≈0) → 1 (fallback seguro = comportamiento actual)', () => {
      expect(pulsatilityBoost(0, 0, 3)).toBe(1);
    });
    it('celda intermedia recibe realce proporcional', () => {
      expect(pulsatilityBoost(0.05, 0.1, 3)).toBeCloseTo(2.5, 5); // 1 + 3*0.5
    });
  });
});

function pulsatility_of(samples: number[]): number {
  return tilePulsatility(samples);
}
