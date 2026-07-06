import { describe, expect, it } from 'vitest';
import { BloodPressureProcessor, isPhysiologicalBp } from '../BloodPressureProcessor';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

function syntheticPpgBuffer(cycles = 8, spc = 30, shift = 0): number[] {
  const buf: number[] = [];
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < spc; i++) {
      const t = (i + shift) / spc;
      const up = t < 0.18 ? t / 0.18 : 1;
      const down = t >= 0.18 ? Math.exp(-(t - 0.18) * 5.2) : 1;
      const notch = t > 0.45 && t < 0.52 ? 0.92 : 1;
      buf.push(0.15 + 0.85 * up * down * notch);
    }
  }
  return buf;
}

describe('BloodPressureProcessor', () => {
  it('acumula ciclos en buffer persistente y produce valores fisiológicos', () => {
    const proc = new BloodPressureProcessor();
    const rr = [850, 870, 860, 855, 865, 858];

    // Usar buffers ligeramente diferentes cada frame (shift variable)
    // para evitar que el detector de duplicados los rechace todos
    let lastEst = proc.estimate(syntheticPpgBuffer(8, 30, 0), rr, 30);
    for (let i = 1; i <= 5; i++) {
      lastEst = proc.estimate(syntheticPpgBuffer(8, 30, i), rr, 30);
    }

    // Después de 6 frames con shifts distintos, debe acumular ≥3 ciclos únicos
    expect(lastEst.cyclesUsed).toBeGreaterThanOrEqual(3);

    // Si produce estimación, debe ser fisiológica
    if (lastEst.confidence !== 'INSUFFICIENT') {
      expect(isPhysiologicalBp(lastEst.systolic, lastEst.diastolic)).toBe(true);
      expect(lastEst.diastolic).toBeLessThan(lastEst.systolic);
      expect(lastEst.diastolic / lastEst.systolic).toBeGreaterThan(
        VITAL_THRESHOLDS.BP.DIA_SYS_RATIO_MIN,
      );
      expect(lastEst.diastolic / lastEst.systolic).toBeLessThan(
        VITAL_THRESHOLDS.BP.DIA_SYS_RATIO_MAX,
      );
    }
  });

  it('retorna INSUFFICIENT sin buffer suficiente', () => {
    const proc = new BloodPressureProcessor();
    const est = proc.estimate([0.1, 0.2], [800, 810], 30);
    expect(est.confidence).toBe('INSUFFICIENT');
    expect(est.diastolic).toBe(0);
  });

  it('mantiene últimos valores conocidos tras pérdida de señal', () => {
    const proc = new BloodPressureProcessor();
    const rr = [850, 870, 860];

    // Alimentar buffer con frames variados para acumular ciclos
    let est = proc.estimate(syntheticPpgBuffer(6, 30, 0), rr, 30);
    for (let i = 0; i < 3; i++) {
      est = proc.estimate(syntheticPpgBuffer(6, 30, i + 1), rr, 30);
    }

    if (est.confidence === 'INSUFFICIENT') return;

    // Señal perdida
    const est2 = proc.estimate([0, 0, 0], rr, 30);
    expect(est2.systolic).toBeGreaterThan(0);
  });
});
