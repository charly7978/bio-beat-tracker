import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ArrhythmiaProcessor } from '../arrhythmia-processor';

describe('ArrhythmiaProcessor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no marca arritmia con RR regulares tras calibración', () => {
    const proc = new ArrhythmiaProcessor();
    vi.advanceTimersByTime(11_000);

    const intervals = [812, 818, 815, 821, 809, 816, 814, 820, 813, 817];

    const r = proc.processRRData({
      intervals,
      lastPeakTime: performance.now(),
      timestampNow: performance.now(),
    });

    expect(r.arrhythmiaStatus).not.toContain('ARRITMIA DETECTADA');
    expect(r.arrhythmiaCount).toBe(0);
  });

  it('permanece en CALIBRANDO durante ventana inicial', () => {
    const proc = new ArrhythmiaProcessor();
    const r = proc.processRRData({
      intervals: [800, 810, 795, 805],
      lastPeakTime: performance.now(),
    });
    expect(r.arrhythmiaStatus).toBe('CALIBRANDO...');
  });
});
