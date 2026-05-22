import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ArrhythmiaProcessor } from '../arrhythmia-processor';

function calibratedProc(): ArrhythmiaProcessor {
  const p = new ArrhythmiaProcessor();
  vi.advanceTimersByTime(13_000);
  return p;
}

function feed(
  proc: ArrhythmiaProcessor,
  intervals: number[],
  now?: number,
) {
  const t = now ?? performance.now();
  return proc.processRRData({
    intervals,
    lastPeakTime: t,
    timestampNow: t,
  });
}

describe('ArrhythmiaProcessor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe('learning phase', () => {
    it('permanece en CALIBRANDO durante ventana inicial', () => {
      const r = new ArrhythmiaProcessor().processRRData({
        intervals: [800, 810, 795, 805],
        lastPeakTime: performance.now(),
      });
      expect(r.arrhythmiaStatus).toBe('CALIBRANDO...');
      expect(r.arrhythmiaConfidence).toBe('none');
    });
  });

  describe('normal sinus rhythm — no false positive', () => {
    it('RR estables (~10ms var) → RITMO NORMAL, score bajo', () => {
      const proc = calibratedProc();
      const r = feed(proc, [812, 818, 815, 821, 809, 816, 814, 820, 813, 817]);
      expect(r.arrhythmiaStatus).not.toContain('ARRITMIA DETECTADA');
      expect(r.arrhythmiaCount).toBe(0);
      expect(r.arrhythmiaScore).toBeLessThan(0.30);
    });

    it('RR con variación fisiológica (sinus arrhythmia) → no detection', () => {
      const proc = calibratedProc();
      const r = feed(proc, [780, 810, 795, 825, 770, 805, 790, 815, 785, 810]);
      expect(r.arrhythmiaStatus).not.toContain('ARRITMIA DETECTADA');
      expect(r.arrhythmiaScore).toBeLessThan(0.40);
    });
  });

  describe('AF-like rhythm — true positive', () => {
    it('RR altamente irregulares (simulando AF) → ARRITMIA DETECTADA', () => {
      const proc = calibratedProc();
      // AF pattern: chaotic RR with large successive diffs
      const r = feed(proc, [490, 810, 380, 920, 410, 780, 340, 960, 450, 850]);
      expect(r.arrhythmiaStatus).toContain('ARRITMIA DETECTADA');
      expect(r.arrhythmiaScore).toBeGreaterThanOrEqual(0.45);
    });

    it('RR con patrón bigeminio → detectado (score moderado)', () => {
      const proc = calibratedProc();
      // Bigeminy: short-long-short-long alternation
      const r = feed(proc, [520, 1080, 510, 1100, 530, 1050, 540, 1070, 520, 1090]);
      expect(r.arrhythmiaStatus).toContain('ARRITMIA DETECTADA');
      expect(r.arrhythmiaScore).toBeGreaterThanOrEqual(0.40);
    });
  });

  describe('noise rejection — evita falsos positivos por micromovimiento', () => {
    it('todos los intervalos < 450ms → no detection', () => {
      const proc = calibratedProc();
      const r = feed(proc, [320, 290, 340, 280, 310, 330, 290, 310, 280, 340]);
      expect(r.arrhythmiaStatus).not.toContain('ARRITMIA DETECTADA');
      expect(r.arrhythmiaScore).toBe(0);
    });

    it('mediana < 450ms con CV > 0.30 → no detection', () => {
      const proc = calibratedProc();
      // Alternating very short / mid intervals that produce high CV
      const r = feed(proc, [300, 580, 310, 590, 305, 575, 295, 585, 315, 570]);
      expect(r.arrhythmiaStatus).not.toContain('ARRITMIA DETECTADA');
      expect(r.arrhythmiaScore).toBe(0);
    });

    it('100% diffs > 50ms con mediana < 500ms → no detection', () => {
      const proc = calibratedProc();
      // Alternating but every successive diff is huge
      const r = feed(proc, [400, 510, 410, 520, 420, 510, 430, 520, 440, 510]);
      expect(r.arrhythmiaStatus).not.toContain('ARRITMIA DETECTADA');
      expect(r.arrhythmiaScore).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('ventana sin PVC (últimos 10 normales) → no detection', () => {
      const proc = calibratedProc();
      // 20 intervals; PVC at position ~5, but the sliding window of the last 10
      // (positions 11-20) is all normal sinus rhythm.
      const r = feed(proc, [
        800, 815, 810, 805, 380, 1240, 808, 812, 806, 814,
        802, 818, 804, 816, 803, 817, 805, 815, 801, 819,
      ]);
      expect(r.arrhythmiaStatus).not.toContain('ARRITMIA DETECTADA');
      expect(r.arrhythmiaScore).toBeLessThan(0.45);
    });

    it('RR insuficientes → no detection', () => {
      const proc = calibratedProc();
      const r = feed(proc, [800, 810]);
      expect(r.arrhythmiaStatus).not.toContain('ARRITMIA');
    });

    it('reset limpia todo el estado', () => {
      const proc = calibratedProc();
      feed(proc, [490, 810, 380, 920, 410, 780, 340, 960, 450, 850]);
      proc.reset();
      const r = feed(proc, [812, 818, 815, 821, 809, 816, 814, 820, 813, 817]);
      expect(r.arrhythmiaStatus).toBe('CALIBRANDO...');
      expect(r.arrhythmiaCount).toBe(0);
      expect(r.arrhythmiaScore).toBe(0);
    });

    it('callback se dispara en cambios de estado', () => {
      const cb = vi.fn();
      const proc = calibratedProc();
      proc.setArrhythmiaDetectionCallback(cb);

      feed(proc, [812, 818, 815, 821, 809, 816, 814, 820, 813, 817]);
      expect(cb).not.toHaveBeenCalledWith(true);

      feed(proc, [490, 810, 380, 920, 410, 780, 340, 960, 450, 850]);
      expect(cb).toHaveBeenCalledWith(true);

      proc.reset();
      expect(cb).toHaveBeenCalledWith(false);
    });

    it('confidence mapping correcto', () => {
      const proc = calibratedProc();
      // Con score ≈ 0 (RR muy regulares)
      const r0 = feed(proc, [800, 802, 798, 801, 803, 797, 800, 804, 796, 799]);
      expect(r0.arrhythmiaConfidence).toBe('none');

      // Con score ≥ 0.45 (AF pattern)
      const r1 = feed(proc, [490, 810, 380, 920, 410, 780, 340, 960, 450, 850]);
      expect(['moderate', 'severe']).toContain(r1.arrhythmiaConfidence);
    });
  });

  describe('strucutral output', () => {
    it('incluye arrhythmiaScore y arrhythmiaConfidence en el resultado', () => {
      const proc = calibratedProc();
      const r = feed(proc, [800, 810, 795, 805, 815, 790, 820, 785, 810, 795]);
      expect(r).toHaveProperty('arrhythmiaScore');
      expect(r).toHaveProperty('arrhythmiaConfidence');
      expect(r).toHaveProperty('arrhythmiaStatus');
      expect(r).toHaveProperty('arrhythmiaCount');
      expect(r).toHaveProperty('lastArrhythmiaData');
    });

    it('lastArrhythmiaData incluye metrics cuando hay detección', () => {
      const proc = calibratedProc();
      const r = feed(proc, [490, 810, 380, 920, 410, 780, 340, 960, 450, 850]);
      if (r.lastArrhythmiaData) {
        expect(r.lastArrhythmiaData.metrics).toBeDefined();
        expect(r.lastArrhythmiaData.metrics.rmssd).toBeGreaterThan(0);
        expect(r.lastArrhythmiaData.metrics.pnn31).toBeGreaterThan(0);
        expect(r.lastArrhythmiaData.metrics.tpr).toBeGreaterThan(0);
      }
    });
  });
});
