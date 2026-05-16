import { describe, expect, it } from 'vitest';
import { BloodPressureProcessor } from '../BloodPressureProcessor';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { isPhysiologicalBp } from '@/lib/vitals/pwaPhysiologicalBpEngine';

function syntheticPpgBuffer(cycles = 8, samplesPerCycle = 30): number[] {
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
  it('calcula PA desde PPG sin fijar pisos artificiales', () => {
    const proc = new BloodPressureProcessor();
    const rr = [850, 870, 860, 855, 865, 858];
    const est = proc.estimate(syntheticPpgBuffer(), rr, 30);
    expect(est.confidence).not.toBe('INSUFFICIENT');
    expect(isPhysiologicalBp(est.systolic, est.diastolic)).toBe(true);
    expect(est.diastolic).toBeLessThan(est.systolic);
    expect(est.diastolic / est.systolic).toBeGreaterThan(
      VITAL_THRESHOLDS.BP.DIA_SYS_RATIO_MIN,
    );
    expect(est.diastolic / est.systolic).toBeLessThan(
      VITAL_THRESHOLDS.BP.DIA_SYS_RATIO_MAX,
    );
  });

  it('retorna INSUFFICIENT sin buffer suficiente', () => {
    const proc = new BloodPressureProcessor();
    const est = proc.estimate([0.1, 0.2], [800, 810], 30);
    expect(est.confidence).toBe('INSUFFICIENT');
    expect(est.diastolic).toBe(0);
  });
});
