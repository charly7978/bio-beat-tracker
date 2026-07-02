import { describe, it, expect } from 'vitest';
import {
  FrameReservoir,
  DEFAULT_FRAME_RESERVOIR_CONFIG,
  type FrameReservoirConfig,
} from '../FrameReservoir';

const cfg = (over: Partial<FrameReservoirConfig> = {}): FrameReservoirConfig => ({
  ...DEFAULT_FRAME_RESERVOIR_CONFIG,
  ...over,
});

describe('FrameReservoir', () => {
  it('no emite hasta llenar el colchón (delay mínimo inicial)', () => {
    const r = new FrameReservoir<number>(cfg({ latencyFrames: 5, capacity: 20 }));
    for (let i = 0; i < 5; i++) {
      r.push(i, 0.9, i * 33);
      expect(r.consume()).toBeNull();
    }
    // El 6º push supera latencyFrames → ya puede emitir.
    r.push(5, 0.9, 5 * 33);
    expect(r.canEmit).toBe(true);
    const e = r.consume();
    expect(e).not.toBeNull();
    expect(e!.payload).toBe(0); // emite el más viejo (FIFO con retraso)
  });

  it('emite en orden FIFO con el retraso configurado', () => {
    const r = new FrameReservoir<number>(cfg({ latencyFrames: 3, capacity: 20 }));
    const emitted: number[] = [];
    for (let i = 0; i < 10; i++) {
      r.push(i, 0.9, i * 33);
      const e = r.consume();
      if (e) emitted.push(e.payload);
    }
    // Con retraso 3, tras 10 push quedan 3 en el colchón → se emiten 0..6.
    expect(emitted).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('sustituye un frame degradado por el mejor vecino bueno reciente', () => {
    const r = new FrameReservoir<string>(
      cfg({ latencyFrames: 2, admitQuality: 0.5, maxStaleMs: 600, capacity: 20 }),
    );
    // Buenos alrededor, uno malo en el medio (índice 3).
    const q = [0.9, 0.9, 0.9, 0.1, 0.9, 0.9, 0.9];
    for (let i = 0; i < q.length; i++) {
      r.push(`f${i}`, q[i], i * 33);
    }
    const out: { payload: string; substituted: boolean }[] = [];
    let e = r.consume();
    while (e) {
      out.push({ payload: e.payload, substituted: e.substituted });
      e = r.consume();
    }
    const bad = out.find((o) => !['f0', 'f1', 'f2', 'f4', 'f5', 'f6'].includes(o.payload) || o.substituted);
    // El slot malo (f3) debió sustituirse por un vecino bueno (no f3).
    const f3Emission = out.find((_, idx) => idx === 3);
    expect(f3Emission).toBeDefined();
    expect(f3Emission!.substituted).toBe(true);
    expect(f3Emission!.payload).not.toBe('f3');
    expect(bad).toBeDefined();
  });

  it('no sustituye si no hay vecino bueno dentro de maxStaleMs', () => {
    const r = new FrameReservoir<number>(
      cfg({ latencyFrames: 1, admitQuality: 0.5, maxStaleMs: 50, capacity: 20 }),
    );
    // Todos malos salvo uno lejano en el tiempo (>50ms del malo objetivo).
    r.push(0, 0.9, 0);
    r.push(1, 0.1, 1000);
    r.push(2, 0.1, 1033);
    r.consume(); // emite slot 0 (bueno)
    const e = r.consume(); // slot 1: malo, vecino bueno está a 1000ms > 50ms
    expect(e).not.toBeNull();
    expect(e!.substituted).toBe(false);
    expect(e!.admitted).toBe(false);
    expect(e!.payload).toBe(1); // se emite el degradado tal cual
  });

  it('reporta cobertura buena en la ventana', () => {
    const r = new FrameReservoir<number>(
      cfg({ latencyFrames: 1, admitQuality: 0.5, coverageWindow: 4, capacity: 20 }),
    );
    // 2 buenos, 2 malos → cobertura 0.5 en ventana de 4.
    r.push(0, 0.9, 0);
    r.push(1, 0.9, 33);
    r.push(2, 0.1, 66);
    r.push(3, 0.1, 99);
    r.consume();
    r.consume();
    const e = r.consume(); // targetAbs=2, ventana [0..2] pero mide hasta target
    expect(e).not.toBeNull();
    expect(e!.goodCoverage).toBeGreaterThan(0);
    expect(e!.goodCoverage).toBeLessThanOrEqual(1);
  });

  it('no se estanca si el consumidor se atrasa más allá de la capacidad', () => {
    const r = new FrameReservoir<number>(cfg({ latencyFrames: 2, capacity: 8 }));
    // Llenar de sobra sin consumir → sobrescribe viejos.
    for (let i = 0; i < 30; i++) r.push(i, 0.9, i * 33);
    const e = r.consume();
    expect(e).not.toBeNull();
    // Debe emitir un slot todavía presente (no uno sobrescrito hace rato).
    expect(e!.payload).toBeGreaterThanOrEqual(30 - 8);
  });

  it('reset limpia el estado y vuelve a exigir el colchón', () => {
    const r = new FrameReservoir<number>(cfg({ latencyFrames: 3, capacity: 20 }));
    for (let i = 0; i < 10; i++) r.push(i, 0.9, i * 33);
    expect(r.canEmit).toBe(true);
    r.reset();
    expect(r.canEmit).toBe(false);
    expect(r.pending).toBe(0);
    expect(r.consume()).toBeNull();
  });
});
