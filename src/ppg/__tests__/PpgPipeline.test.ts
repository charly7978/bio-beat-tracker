import { describe, it, expect } from 'vitest';
import { PpgPipeline, computePerfusionIndex } from '../PpgPipeline';
import type { RoiSample } from '../roiSampler';

const FS = 30;

function ppgWave(phase: number): number {
  const p = phase - Math.floor(phase);
  return (
    Math.exp(-Math.pow((p - 0.18) / 0.09, 2)) +
    0.3 * Math.exp(-Math.pow((p - 0.45) / 0.11, 2))
  );
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Simula el ROI de un dedo real: DC alto (linterna a través del tejido) con una
 * componente pulsátil pequeña — perfusión ~1 %, el valor típico de piel humana.
 */
function feedFinger(p: PpgPipeline, seconds: number, bpm: number, piPercent = 1.0) {
  const hz = bpm / 60;
  const dc = 140;
  const ac = (dc * piPercent) / 100;
  let last = { measuring: false } as ReturnType<PpgPipeline['push']>;
  const n = Math.round(seconds * FS);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const v = dc + ac * ppgWave(t * hz);
    last = p.push(sample(v, t));
  }
  return last;
}

function sample(red: number, tSec: number): RoiSample {
  return { red, green: red * 0.35, blue: red * 0.28, timestampMs: tSec * 1000 };
}

describe('PpgPipeline — cámara → señal → latidos', () => {
  it('un DEDO real (perfusión ~1 %, ritmo estable) SÍ mide, con el bpm correcto', () => {
    const p = new PpgPipeline();
    const r = feedFinger(p, 12, 72);
    expect(r.measuring).toBe(true);
    expect(r.reason).toBe('MEASURING');
    expect(Math.abs(r.bpm - 72)).toBeLessThan(6);
    expect(r.perfusionIndex).toBeGreaterThan(0.002);
  });

  it('mide a distintas frecuencias fisiológicas', () => {
    for (const bpm of [48, 60, 95, 120]) {
      const p = new PpgPipeline();
      const r = feedFinger(p, 12, bpm);
      expect(r.measuring, `bpm=${bpm} reason=${r.reason}`).toBe(true);
      expect(Math.abs(r.bpm - bpm), `bpm=${bpm} medido=${r.bpm}`).toBeLessThan(bpm * 0.1);
    }
  });

  describe('escenas SIN dedo — el fallo que motivó la reescritura', () => {
    it('PARED bajo linterna (DC alto, sin pulsatilidad) NO mide', () => {
      const p = new PpgPipeline();
      const rnd = makeRng(7);
      let last = p.push(sample(200, 0));
      for (let i = 1; i < 12 * FS; i++) {
        last = p.push(sample(200 + rnd() * 0.2, i / FS));
      }
      expect(last.measuring).toBe(false);
      expect(last.reason).toBe('NO_PERFUSION');
    });

    it('RUIDO fuerte (perfusión alta pero ritmo inconsistente) NO mide', () => {
      const p = new PpgPipeline();
      const rnd = makeRng(4242);
      let last = p.push(sample(140, 0));
      for (let i = 1; i < 14 * FS; i++) {
        last = p.push(sample(140 + (rnd() - 0.5) * 30, i / FS));
      }
      expect(last.measuring).toBe(false);
      expect(['RHYTHM_NOT_CONSISTENT', 'NO_RHYTHM', 'WAITING_BEATS']).toContain(last.reason);
    });

    it('OSCILACIÓN NO CARDÍACA (0,25 Hz = 15 bpm) NO mide', () => {
      const p = new PpgPipeline();
      let last = p.push(sample(140, 0));
      for (let i = 1; i < 14 * FS; i++) {
        const t = i / FS;
        last = p.push(sample(140 + 3 * Math.sin(2 * Math.PI * 0.25 * t), t));
      }
      expect(last.measuring).toBe(false);
    });

    it('ESCENA OSCURA (sin señal) NO mide', () => {
      const p = new PpgPipeline();
      let last = p.push(sample(0, 0));
      for (let i = 1; i < 12 * FS; i++) last = p.push(sample(0, i / FS));
      expect(last.measuring).toBe(false);
    });
  });

  it('al retirar el dedo deja de medir: NO retiene el valor anterior', () => {
    const p = new PpgPipeline();
    const measuring = feedFinger(p, 12, 72);
    expect(measuring.measuring).toBe(true);

    // Se retira el dedo: DC plano, sin pulso. La ventana se vacía por tiempo.
    let last = measuring;
    for (let i = 0; i < 12 * FS; i++) {
      last = p.push(sample(210, 12 + i / FS));
    }
    expect(last.measuring).toBe(false);
    expect(last.bpm).toBe(0);
  });

  it('tolera JITTER de cuadros y cuadros perdidos (cámara real)', () => {
    const p = new PpgPipeline();
    const rnd = makeRng(99);
    const hz = 72 / 60;
    const dc = 140;
    const ac = dc * 0.01;
    let t = 0;
    let last = p.push(sample(dc, 0));
    while (t < 14) {
      // Intervalo irregular 25–40 ms, con caídas ocasionales de cuadro.
      t += (rnd() < 0.06 ? 70 : 25 + rnd() * 15) / 1000;
      last = p.push(sample(dc + ac * ppgWave(t * hz), t));
    }
    expect(last.measuring).toBe(true);
    expect(Math.abs(last.bpm - 72)).toBeLessThan(8);
  });

  it('reset deja el pipeline sin estado', () => {
    const p = new PpgPipeline();
    feedFinger(p, 12, 72);
    p.reset();
    const r = p.push(sample(140, 0));
    expect(r.measuring).toBe(false);
    expect(r.bpm).toBe(0);
  });
});

describe('computePerfusionIndex', () => {
  it('mide AC/DC en el rango fisiológico esperado', () => {
    const dc = 150;
    const signal = Array.from({ length: 200 }, (_, i) => dc + 1.5 * Math.sin(i / 4));
    // AC ≈ 3 (p95−p05 de una senoide de amplitud 1,5), DC = 150 → ~2 %.
    expect(computePerfusionIndex(signal)).toBeGreaterThan(0.015);
    expect(computePerfusionIndex(signal)).toBeLessThan(0.025);
  });

  it('una señal plana da perfusión ~0', () => {
    expect(computePerfusionIndex(new Array(200).fill(180))).toBeLessThan(0.0001);
  });

  it('un único cuadro atípico NO fabrica perfusión (rango robusto)', () => {
    const x = new Array(200).fill(150);
    x[100] = 255;
    expect(computePerfusionIndex(x)).toBeLessThan(0.001);
  });
});
