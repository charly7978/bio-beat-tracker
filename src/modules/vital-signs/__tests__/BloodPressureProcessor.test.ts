import { describe, expect, it } from 'vitest';
import { BloodPressureProcessor } from '../BloodPressureProcessor';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

/** Pulso sintético repetido (~1 Hz @ 30 fps) para estimación morfológica. */
function syntheticPpgBuffer(cycles = 6, samplesPerCycle = 30): number[] {
  const buf: number[] = [];
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < samplesPerCycle; i++) {
      const t = i / samplesPerCycle;
      const up = t < 0.18 ? t / 0.18 : 1;
      const down = t >= 0.18 ? Math.exp(-(t - 0.18) * 5.2) : 1;
      const notch = t > 0.45 && t < 0.52 ? 0.92 : 1;
      buf.push(0.15 + 0.85 * up * down * notch);
    }
  }
  return buf;
}

describe('BloodPressureProcessor', () => {
  it('DBP no queda pegado al piso DIASTOLIC_MIN con señal sintética válida', () => {
    const proc = new BloodPressureProcessor();
    const rr = [850, 870, 860, 855, 865];
    const est = proc.estimate(syntheticPpgBuffer(), rr, 30);
    expect(est.confidence).not.toBe('INSUFFICIENT');
    expect(est.systolic).toBeGreaterThan(0);
    expect(est.diastolic).toBeGreaterThan(VITAL_THRESHOLDS.BP.DIASTOLIC_MIN);
    expect(est.diastolic).toBeLessThanOrEqual(est.systolic - VITAL_THRESHOLDS.BP.MIN_PP);
    expect(est.diastolic / est.systolic).toBeGreaterThan(0.5);
    expect(est.diastolic / est.systolic).toBeLessThan(0.88);
  });

  it('retorna INSUFFICIENT sin buffer suficiente', () => {
    const proc = new BloodPressureProcessor();
    const est = proc.estimate([0.1, 0.2], [800, 810], 30);
    expect(est.confidence).toBe('INSUFFICIENT');
    expect(est.diastolic).toBe(0);
  });
});
