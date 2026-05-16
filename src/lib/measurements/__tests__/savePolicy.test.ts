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
      value: { systolic: 120, diastolic: 80 },
      unit: 'mmHg',
      timestamp: now,
      confidence: 0.7,
      status: 'VALID',
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

  it('rechaza SpO2 no VALID aunque HR sea válido', () => {
    const vs = makeVs('VALID', 60);
    vs.spo2 = { ...vs.spo2, value: 0, status: 'NO_VALID_SIGNAL' };
    const r = evaluateFinalMeasurementSave(vs, 60);
    expect(r.canSaveFinal).toBe(false);
    expect(r.reasons).toContain('SPO2_NOT_VALID');
  });

  it('acepta HR en el límite inferior fisiológico (30 BPM)', () => {
    const vs = makeVs('VALID', 60);
    vs.heartRate = { ...vs.heartRate, value: 30 };
    const r = evaluateFinalMeasurementSave(vs, 60);
    expect(r.canSaveFinal).toBe(true);
  });
});
