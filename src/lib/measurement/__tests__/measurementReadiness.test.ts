import { describe, expect, it } from 'vitest';
import { evaluateMeasurementReadiness } from '../measurementReadiness';
import {
  createMeasurementSessionLatch,
  updateMeasurementSessionLatch,
} from '../measurementSessionLatch';

describe('measurementReadiness', () => {
  it('habilita vitales con dedo, SQI y al menos un pico en latch', () => {
    let latch = createMeasurementSessionLatch();
    latch = updateMeasurementSessionLatch(latch, true, 72, 12, 1000, true);
    latch = updateMeasurementSessionLatch(latch, true, 72, 12, 1800, true);
    const r = evaluateMeasurementReadiness({
      pulseVerified: true,
      hasUsableContact: true,
      contactState: 'UNSTABLE_CONTACT',
      rawSqi: 15,
      bpm: 72,
      peakRecent: true,
      ensembleConfidence: 0.2,
      minEnsembleConf: 0.12,
      latch,
      nowMs: 1100,
    });
    expect(r.spo2PipelineReady).toBe(true);
    expect(r.vitalsDspReady).toBe(true);
    expect(r.fullVitalsReady).toBe(true);
    expect(r.hrDisplayReady).toBe(true);
  });

  it('no habilita vitales sin contacto', () => {
    const latch = createMeasurementSessionLatch();
    const r = evaluateMeasurementReadiness({
      pulseVerified: false,
      hasUsableContact: false,
      contactState: 'NO_CONTACT',
      rawSqi: 40,
      bpm: 0,
      peakRecent: false,
      ensembleConfidence: 0,
      minEnsembleConf: 0.12,
      latch,
      nowMs: 1000,
    });
    expect(r.spo2PipelineReady).toBe(false);
    expect(r.vitalsDspReady).toBe(false);
    expect(r.fullVitalsReady).toBe(false);
    expect(r.hrDisplayReady).toBe(false);
  });

  it('SIN PULSO VERIFICADO no publica NADA, aunque el color diga «dedo» y el SQI sea alto', () => {
    // Es exactamente la escena denunciada: cámara apuntando a cualquier lado que
    // satisface los heurísticos de color y los pisos de SQI/PI antiguos. Sin
    // latido real comprobado en la señal, ningún signo vital sale a la UI.
    let latch = createMeasurementSessionLatch();
    latch = updateMeasurementSessionLatch(latch, true, 72, 40, 1000, true);
    latch = updateMeasurementSessionLatch(latch, true, 72, 40, 1800, true);
    const r = evaluateMeasurementReadiness({
      pulseVerified: false,
      hasUsableContact: true,
      contactState: 'STABLE_CONTACT',
      rawSqi: 80,
      bpm: 72,
      peakRecent: true,
      ensembleConfidence: 0.9,
      minEnsembleConf: 0.12,
      latch,
      nowMs: 1900,
    });
    expect(r.spo2PipelineReady).toBe(false);
    expect(r.vitalsDspReady).toBe(false);
    expect(r.fullVitalsReady).toBe(false);
    expect(r.hrDisplayReady).toBe(false);
    expect(r.pipelineLive).toBe(false);
  });
});
