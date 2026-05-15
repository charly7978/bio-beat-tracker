import { describe, it, expect } from 'vitest';
import { evaluateFinalMeasurementSave } from '../savePolicy';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';

const sqm = {
  sqi: 60,
  perfusionIndex: 0.01,
  snr: null as number | null,
  periodicity: null as number | null,
  motionScore: null as number | null,
  saturationRatio: 0,
  frameDropRatio: 0,
  fpsEffective: 30,
  timestampJitterMs: 0,
};

function makeVs(hrStatus: VitalSignsResult['heartRate']['status'], sqiRound: number): VitalSignsResult {
  const now = Date.now();
  const m = (name: string, v: VitalSignsResult['heartRate']['value']): VitalSignsResult['heartRate'] => ({
    name,
    value: v,
    unit: 'u',
    timestamp: now,
    confidence: 0.5,
    status: 'VALID',
    reason: '',
    signalQuality: { ...sqm, sqi: sqiRound },
    diagnostics: {},
  });
  return {
    heartRate: { ...m('HR', 72), status: hrStatus },
    spo2: m('SpO2', 97),
    bloodPressure: {
      name: 'BP',
      value: { systolic: 0, diastolic: 0 },
      unit: 'mmHg',
      timestamp: now,
      confidence: 0.2,
      status: 'REQUIRES_CALIBRATION',
      reason: '',
      signalQuality: { ...sqm, sqi: sqiRound },
      diagnostics: {},
    },
    respiration: { ...m('RR', null), status: 'INSUFFICIENT_WINDOW' },
    arrhythmia: {
      name: 'a',
      value: { count: 0, status: 'NORMAL' },
      unit: 'e',
      timestamp: now,
      confidence: 0.5,
      status: 'VALID',
      reason: '',
      signalQuality: { ...sqm, sqi: sqiRound },
      diagnostics: {},
    },
    signalQuality: sqiRound,
    isCalibrating: false,
    calibrationProgress: 0,
  };
}

describe('evaluateFinalMeasurementSave', () => {
  it('permite guardar con HR VALID y SQI alto', () => {
    const r = evaluateFinalMeasurementSave(makeVs('VALID', 60), 60);
    expect(r.canSaveFinal).toBe(true);
  });

  it('rechaza SQI bajo', () => {
    const r = evaluateFinalMeasurementSave(makeVs('VALID', 60), 40);
    expect(r.canSaveFinal).toBe(false);
    expect(r.outcome).toBe('rejected_low_quality');
  });

  it('rechaza HR no VALID', () => {
    const r = evaluateFinalMeasurementSave(makeVs('LOW_SIGNAL_QUALITY', 60), 60);
    expect(r.canSaveFinal).toBe(false);
  });
});
