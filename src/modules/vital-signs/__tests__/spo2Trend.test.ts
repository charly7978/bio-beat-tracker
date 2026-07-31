import { describe, it, expect } from 'vitest';
import { Spo2TrendTracker } from '../spo2Trend';

/** Alimenta n muestras de R con dispersión determinista alrededor de `base`. */
function feed(t: Spo2TrendTracker, base: number, n: number, spread = 0.01) {
  for (let i = 0; i < n; i++) {
    // Alternancia determinista: da dispersión sin depender de un generador.
    t.push(base + (i % 2 === 0 ? spread : -spread));
  }
}

describe('Spo2TrendTracker', () => {
  describe('línea base', () => {
    it('no opina hasta tener línea base', () => {
      const t = new Spo2TrendTracker();
      feed(t, 0.5, 5);
      const r = t.current();

      expect(r.baselineReady).toBe(false);
      expect(r.direction).toBe('UNKNOWN');
    });

    it('la confianza crece mientras acumula línea base', () => {
      const t = new Spo2TrendTracker();
      feed(t, 0.5, 3);
      const a = t.current().confidence;
      feed(t, 0.5, 5);
      const b = t.current().confidence;

      expect(b).toBeGreaterThan(a);
    });

    it('fija la línea base a las 12 muestras', () => {
      const t = new Spo2TrendTracker();
      feed(t, 0.5, 12);
      expect(t.current().baselineReady).toBe(true);
    });

    it('tras la línea base sigue sin opinar hasta tener muestras recientes', () => {
      const t = new Spo2TrendTracker();
      feed(t, 0.5, 12);
      const r = t.current();

      expect(r.baselineReady).toBe(true);
      expect(r.direction).toBe('UNKNOWN');
    });
  });

  describe('dirección de la tendencia', () => {
    it('R que sube significa oxigenación que BAJA', () => {
      // Relación física: la hemoglobina desoxigenada absorbe más rojo, así que
      // R sube cuando la saturación cae.
      const t = new Spo2TrendTracker();
      feed(t, 0.50, 12, 0.01);
      feed(t, 0.60, 8, 0.01);

      expect(t.current().direction).toBe('FALLING');
    });

    it('R que baja significa oxigenación que SUBE', () => {
      const t = new Spo2TrendTracker();
      feed(t, 0.50, 12, 0.01);
      feed(t, 0.40, 8, 0.01);

      expect(t.current().direction).toBe('RISING');
    });

    it('R sin cambio real se reporta ESTABLE', () => {
      const t = new Spo2TrendTracker();
      feed(t, 0.50, 12, 0.01);
      feed(t, 0.50, 8, 0.01);

      expect(t.current().direction).toBe('STABLE');
    });

    it('un cambio menor que la variabilidad basal NO se reporta como tendencia', () => {
      // Línea base ruidosa: hace falta un cambio mayor para distinguirlo.
      const t = new Spo2TrendTracker();
      feed(t, 0.50, 12, 0.10);
      feed(t, 0.53, 8, 0.10);

      expect(t.current().direction).toBe('STABLE');
    });

    it('el mismo cambio SÍ se reporta si la línea base fue estable', () => {
      // Mismo desplazamiento absoluto que el test anterior, pero con línea base
      // limpia: ahora sí supera la variabilidad propia del usuario.
      const t = new Spo2TrendTracker();
      feed(t, 0.50, 12, 0.005);
      feed(t, 0.53, 8, 0.005);

      expect(t.current().direction).toBe('FALLING');
    });
  });

  describe('no inventa magnitudes', () => {
    it('sigmas se expresa en desviaciones de la línea base, no en puntos de saturación', () => {
      const t = new Spo2TrendTracker();
      feed(t, 0.50, 12, 0.01);
      feed(t, 0.60, 8, 0.01);

      const r = t.current();
      // El desplazamiento es de 0.10 con dispersión basal ~0.01 → muchas sigmas.
      expect(Math.abs(r.sigmas)).toBeGreaterThan(TREND_MIN_SIGMAS);
      // Y no se parece a un porcentaje de saturación.
      expect(r.sigmas).not.toBeCloseTo(98, 0);
    });

    it('con línea base de dispersión nula no se opina', () => {
      // Todas las muestras idénticas: cualquier cambio daría infinitas sigmas.
      const t = new Spo2TrendTracker();
      for (let i = 0; i < 12; i++) t.push(0.5);
      for (let i = 0; i < 8; i++) t.push(0.9);

      const r = t.current();
      expect(r.direction).toBe('STABLE');
      expect(r.sigmas).toBe(0);
    });
  });

  describe('robustez', () => {
    it('descarta valores no finitos sin alterar el estado', () => {
      const t = new Spo2TrendTracker();
      feed(t, 0.5, 12, 0.01);
      const before = t.current();

      t.push(NaN);
      t.push(Infinity);

      expect(t.current().baselineReady).toBe(before.baselineReady);
    });

    it('descarta R no positivo', () => {
      const t = new Spo2TrendTracker();
      t.push(0);
      t.push(-1);
      expect(t.current().baselineReady).toBe(false);
    });

    it('reset vuelve al estado inicial', () => {
      const t = new Spo2TrendTracker();
      feed(t, 0.5, 20, 0.01);
      t.reset();

      const r = t.current();
      expect(r.baselineReady).toBe(false);
      expect(r.direction).toBe('UNKNOWN');
      expect(r.confidence).toBe(0);
    });
  });
});

const TREND_MIN_SIGMAS = 2;
