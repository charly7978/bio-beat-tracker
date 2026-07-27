import { describe, it, expect } from 'vitest';
import {
  PerfusionEvidence,
  EVIDENCE_UPPER,
  EVIDENCE_LOWER,
} from '../perfusionEvidence';

/**
 * Verosimilitudes que produce realmente el detector de firma espectral, medidas
 * en su propia batería de tests. No son números elegidos: son los que salen.
 */
const LLR_WALL = -2.58; // pared con parpadeo, θ ≈ 0.3°
const LLR_TISSUE = 12.0; // tejido perfundido, θ ≈ 32°
const LLR_UNKNOWN = 0; // ruido bajo el piso: el detector no opina

/** Periodo real de evaluación en el procesador. */
const STEP_S = 0.5;

/** Corre n pasos con una verosimilitud fija y devuelve el veredicto final. */
function run(ev: PerfusionEvidence, llr: number, steps: number) {
  let v = ev.peek();
  for (let i = 0; i < steps; i++) v = ev.update(llr, STEP_S);
  return v;
}

/** Cuántos pasos tarda en alcanzar un estado. -1 si no lo alcanza. */
function stepsUntil(
  ev: PerfusionEvidence,
  llr: number,
  target: string,
  maxSteps = 40,
): number {
  for (let i = 1; i <= maxSteps; i++) {
    if (ev.update(llr, STEP_S).state === target) return i;
  }
  return -1;
}

describe('PerfusionEvidence', () => {
  describe('los límites salen de las tasas de error, no están elegidos', () => {
    it('el límite superior es log((1−β)/α)', () => {
      // α = 0.005 (falso positivo), β = 0.05 (falso negativo)
      expect(EVIDENCE_UPPER).toBeCloseTo(Math.log(0.95 / 0.005), 6);
    });

    it('el límite inferior es log(β/(1−α))', () => {
      expect(EVIDENCE_LOWER).toBeCloseTo(Math.log(0.05 / 0.995), 6);
    });

    it('es asimétrico a propósito: cuesta más aceptar que rechazar', () => {
      // Preferimos rechazar un dedo bueno antes que aceptar una pared.
      expect(Math.abs(EVIDENCE_UPPER)).toBeGreaterThan(Math.abs(EVIDENCE_LOWER));
    });
  });

  describe('LA PARED — no debe llegar nunca a dar lectura', () => {
    it('rechaza una pared en menos de 1.5 s', () => {
      const ev = new PerfusionEvidence();
      const steps = stepsUntil(ev, LLR_WALL, 'NOT_PERFUSED');

      expect(steps).toBeGreaterThan(0);
      expect(steps * STEP_S).toBeLessThanOrEqual(1.5);
    });

    it('nunca alcanza PERFUSED por más que insista', () => {
      const ev = new PerfusionEvidence();
      const v = run(ev, LLR_WALL, 120); // 60 s apuntando a la pared

      expect(v.state).toBe('NOT_PERFUSED');
      expect(v.logOdds).toBeLessThan(EVIDENCE_LOWER);
    });

    it('el acumulado está acotado — no se hunde sin fondo', () => {
      // Si no estuviera acotado, tras un minuto de pared haría falta otro
      // minuto de dedo real para recuperarse.
      const ev = new PerfusionEvidence();
      const v = run(ev, LLR_WALL, 200);

      expect(Number.isFinite(v.logOdds)).toBe(true);
      expect(v.logOdds).toBeGreaterThan(-100);
    });
  });

  describe('TEJIDO REAL — no debe quedar bloqueado', () => {
    it('acepta tejido perfundido en 1 s o menos', () => {
      const ev = new PerfusionEvidence();
      const steps = stepsUntil(ev, LLR_TISSUE, 'PERFUSED');

      expect(steps).toBeGreaterThan(0);
      expect(steps * STEP_S).toBeLessThanOrEqual(1.0);
    });

    it('se mantiene aceptado mientras dura la medición', () => {
      const ev = new PerfusionEvidence();
      const v = run(ev, LLR_TISSUE, 120); // 60 s de medición

      expect(v.state).toBe('PERFUSED');
      expect(v.confidence).toBeGreaterThan(0.99);
    });
  });

  describe('TRANSICIONES — sacar y poner el dedo', () => {
    it('vuelve a rechazar poco después de retirar el dedo', () => {
      const ev = new PerfusionEvidence();
      run(ev, LLR_TISSUE, 20); // 10 s de dedo real
      expect(ev.peek().state).toBe('PERFUSED');

      // Se retira: el detector pasa a ver una pared.
      const steps = stepsUntil(ev, LLR_WALL, 'NOT_PERFUSED');
      expect(steps).toBeGreaterThan(0);
      expect(steps * STEP_S).toBeLessThanOrEqual(4.0);
    });

    it('el olvido evita quedarse congelado en el último veredicto', () => {
      const ev = new PerfusionEvidence();
      run(ev, LLR_TISSUE, 40); // 20 s, acumulado saturado

      // Sin más evidencia, el acumulado decae hacia cero.
      const before = ev.peek().logOdds;
      run(ev, LLR_UNKNOWN, 20); // 10 s sin poder decidir
      const after = ev.peek().logOdds;

      expect(Math.abs(after)).toBeLessThan(Math.abs(before));
    });
  });

  describe('ausencia de evidencia ≠ evidencia de ausencia', () => {
    it('con verosimilitud 0 no se pronuncia en ninguna dirección', () => {
      const ev = new PerfusionEvidence();
      const v = run(ev, LLR_UNKNOWN, 20);

      expect(v.state).toBe('UNDECIDED');
      expect(v.logOdds).toBeCloseTo(0, 6);
      expect(v.confidence).toBeCloseTo(0.5, 6);
    });

    it('arranca indeciso, no aceptando ni rechazando', () => {
      const v = new PerfusionEvidence().peek();

      expect(v.state).toBe('UNDECIDED');
      expect(v.logOdds).toBe(0);
    });
  });

  describe('robustez', () => {
    it('ignora dt inválido sin corromper el acumulado', () => {
      const ev = new PerfusionEvidence();
      ev.update(LLR_TISSUE, Number.NaN);
      ev.update(LLR_TISSUE, -1);

      expect(Number.isFinite(ev.peek().logOdds)).toBe(true);
      expect(ev.peek().logOdds).toBeGreaterThan(0);
    });

    it('ignora verosimilitud no finita', () => {
      const ev = new PerfusionEvidence();
      run(ev, LLR_TISSUE, 4);
      const before = ev.peek().logOdds;
      ev.update(Number.POSITIVE_INFINITY, STEP_S);

      expect(Number.isFinite(ev.peek().logOdds)).toBe(true);
      expect(ev.peek().logOdds).toBeLessThanOrEqual(before);
    });

    it('acota un dt enorme (app en segundo plano)', () => {
      const ev = new PerfusionEvidence();
      run(ev, LLR_TISSUE, 20);
      ev.update(0, 3600); // una hora suspendida

      // Debe haber decaído a cero, no quedar en el veredicto viejo.
      expect(ev.peek().logOdds).toBeCloseTo(0, 3);
      expect(ev.peek().state).toBe('UNDECIDED');
    });

    it('reset deja el acumulador en cero e indeciso', () => {
      const ev = new PerfusionEvidence();
      run(ev, LLR_TISSUE, 20);
      ev.reset();

      expect(ev.peek().logOdds).toBe(0);
      expect(ev.peek().state).toBe('UNDECIDED');
    });
  });
});
