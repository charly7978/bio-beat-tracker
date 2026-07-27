import { describe, expect, it } from 'vitest';
import { VitalSignsProcessor } from '../VitalSignsProcessor';
import { SpO2Calculator } from '../SpO2Calculator';

describe('VitalSignsProcessor', () => {
  it('se inicializa con valores correctos', () => {
    const proc = new VitalSignsProcessor();
    const result = proc.reset();
    expect(result).toBeDefined();
    expect(result!.heartRate.value).toBeNull();
    expect(result!.spo2.value).toBeNull();
  });

  it('no publica lecturas retenidas: sin señal los vitales quedan en null', () => {
    // El processor es la capa clínica: publica el valor medido o nada.
    // El display hold (mantener el último valor mientras la gate está abajo)
    // pertenece a useSignalRouter, no aquí. Sin frames procesados no puede
    // existir ningún valor publicado.
    const proc = new VitalSignsProcessor();
    const result = proc.reset();

    expect(result!.spo2.value).toBeNull();
    expect(result!.bloodPressure.value).toBeNull();
    expect(result!.heartRate.value).toBeNull();
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
