import { describe, expect, it } from 'vitest';
import { VitalSignsProcessor } from '../VitalSignsProcessor';
import { DisplaySmoothing } from '../DisplaySmoothing';
import { SpO2Calculator } from '../SpO2Calculator';

describe('VitalSignsProcessor', () => {
  it('se inicializa con valores correctos', () => {
    const proc = new VitalSignsProcessor();
    const result = proc.reset();
    expect(result).toBeDefined();
    expect(result!.heartRate.value).toBeNull();
    expect(result!.spo2.value).toBeNull();
  });

  it('smoothWeightedValue actualiza con mayor velocidad ante alta confianza y viceversa', () => {
    const smoother = new DisplaySmoothing();
    
    // Test con peso = 1.0 (alta confianza)
    const valHighConf = smoother.smoothWeightedValue(120, 140, 1.0, 'stable');
    
    // Test con peso = 0.1 (baja confianza)
    const valLowConf = smoother.smoothWeightedValue(120, 140, 0.1, 'stable');

    // Alta confianza debe estar más cerca del nuevo valor (140)
    // que baja confianza (que debe quedarse más cerca del valor previo 120).
    const diffHigh = Math.abs(valHighConf - 140);
    const diffLow = Math.abs(valLowConf - 140);

    expect(diffHigh).toBeLessThan(diffLow);
    
    // Ambas salidas deben ser valores numéricos finitos y coherentes
    expect(isFinite(valHighConf)).toBe(true);
    expect(isFinite(valLowConf)).toBe(true);
    expect(valHighConf).toBeGreaterThan(120);
    expect(valLowConf).toBeGreaterThan(120);
  });

  it('SpO2Calculator rechaza DC insuficiente', () => {
    const calc = new SpO2Calculator();
    const result = calc.calculate(
      { redAC: 0.5, redDC: 5, greenAC: 0.3, greenDC: 3 },
      0,
    );
    expect(result).toBe(0);
  });

  it('procesa señales válidas y actualiza el estado de las mediciones', () => {
    const proc = new VitalSignsProcessor();
    
    const result = proc.processSignal(
      150,
      75,
      72,
      { intervals: [833, 830, 835], lastPeakTime: Date.now() },
      0.0035,
      { sqi: 75 }
    );

    expect(result).toBeDefined();
    expect(result.signalQuality).toBe(75);
  });
});
