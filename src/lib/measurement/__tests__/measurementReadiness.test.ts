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
      hasUsableContact: true,
      contactState: 'UNSTABLE_CONTACT',
      rawSqi: 15,
      perfusionIndex: 0.002,
      piMin: 0.0001,
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
      hasUsableContact: false,
      contactState: 'NO_CONTACT',
      rawSqi: 40,
      perfusionIndex: 0.01,
      piMin: 0.0001,
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
});
