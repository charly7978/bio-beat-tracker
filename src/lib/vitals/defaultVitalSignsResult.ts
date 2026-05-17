/**
 * Estado inicial único de signos vitales (evita duplicar defaults en Index/hooks).
 */
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import type { SignalQualityMetrics } from '@/types/measurements';

const emptySq: SignalQualityMetrics = {
  sqi: 0,
  perfusionIndex: 0,
  snr: null,
  periodicity: null,
  motionScore: null,
  saturationRatio: 0,
  underexposureRatio: 0,
  frameDropRatio: 0,
  fpsEffective: 30,
  timestampJitterMs: 0,
};

export function createDefaultVitalSignsResult(): VitalSignsResult {
  const ts = Date.now();
  const base = {
    timestamp: ts,
    confidence: 0,
    status: 'WARMUP' as const,
    reason: '',
    signalQuality: { ...emptySq },
    diagnostics: {},
  };
  return {
    heartRate: { ...base, name: 'Heart Rate', value: null, unit: 'bpm' },
    spo2: { ...base, name: 'SpO2', value: null, unit: '%' },
    bloodPressure: {
      ...base,
      name: 'BP',
      value: null,
      unit: 'mmHg',
    },
    respiration: { ...base, name: 'RR', value: null, unit: 'rpm' },
    arrhythmia: {
      ...base,
      name: 'Arrhythmia',
      value: { count: 0, status: 'NORMAL' },
      unit: 'event',
    },
    signalQuality: 0,
    isCalibrating: false,
    calibrationProgress: 0,
    lastArrhythmiaData: null,
  };
}
