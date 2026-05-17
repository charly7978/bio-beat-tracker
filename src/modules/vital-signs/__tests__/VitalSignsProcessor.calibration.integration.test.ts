/**
 * Integración VitalSignsProcessor + CalibrationManager + localStorage (jsdom).
 * No usa Math.random ni señales inventadas: valores RGB/sQM fijos repetibles.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CalibrationManager, type CalibrationProfile } from '../CalibrationManager';
import { VitalSignsProcessor } from '../VitalSignsProcessor';

function resetCalibrationSingleton(): void {
  const ctor = CalibrationManager as unknown as { instance?: CalibrationManager };
  if (ctor.instance) {
    ctor.instance.reset();
  }
  ctor.instance = undefined;
}

function spo2Profile(id: string, expiresAt: number): CalibrationProfile {
  const t = Date.now();
  return {
    id,
    type: 'SPO2',
    deviceId: 'vitest-device',
    modelName: 'Vitest',
    coefficients: {},
    referenceValues: { refSpo2: 98 },
    createdAt: t,
    expiresAt,
    method: 'pulse-oximeter',
  };
}

const stableSqm = {
  sqi: 62,
  perfusionIndex: 0.0022,
  snr: 0.55,
  periodicity: 0.22,
  motionScore: 0.12,
  saturationRatio: 0.08,
  underexposureRatio: 0.05,
  frameDropRatio: 0.04,
  fpsEffective: 30,
  timestampJitterMs: 22,
} as const;

/** AC/DC que mantienen R en rango y SpO2 estimado dentro de 70–99 tras mediana. */
const stableRgb = {
  redAC: 0.42,
  redDC: 120,
  greenAC: 0.28,
  greenDC: 95,
};

describe('VitalSignsProcessor + CalibrationManager (integración)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCalibrationSingleton();
  });

  it('hidrata perfiles SpO2 desde localStorage al instanciar CalibrationManager', () => {
    const future = Date.now() + 30 * 86400000;
    const p = spo2Profile('ls-spo2', future);
    localStorage.setItem('calibration_profiles', JSON.stringify({ [p.id]: p }));
    localStorage.setItem('active_calibration_id', p.id);

    const ctor = CalibrationManager as unknown as { instance?: CalibrationManager };
    ctor.instance = undefined;
    const info = CalibrationManager.getInstance().getCalibrationInfo('SPO2');
    expect(info.available).toBe(true);
    expect(info.expired).toBe(false);
    expect(info.profileId).toBe(p.id);
  });

  it('sin perfil SpO2 activo, la salida no es VALID aunque la estimación interna sea plausible', () => {
    const proc = new VitalSignsProcessor();
    proc.setRGBData(stableRgb);
    let last = proc.processSignal(0.5, 60, 72, undefined, 0.002, { ...stableSqm });
    for (let i = 0; i < 30; i++) {
      const wobble = ((i % 5) - 2) * 0.001;
      last = proc.processSignal(0.5 + wobble, 60, 72, undefined, 0.002, { ...stableSqm });
    }
    expect(last.spo2.value).not.toBeNull();
    expect(['REQUIRES_CALIBRATION', 'LOW_SIGNAL_QUALITY', 'NO_VALID_SIGNAL']).toContain(
      last.spo2.status,
    );
    expect(last.spo2.status).not.toBe('VALID');
  });

  it('con perfil SpO2 vigente y SQM alto, SpO2 puede alcanzar VALID tras ventana de ratio R', () => {
    const cm = CalibrationManager.getInstance();
    cm.addProfile(spo2Profile('active-spo2', Date.now() + 30 * 86400000));

    const proc = new VitalSignsProcessor();
    proc.setRGBData(stableRgb);
    let last = proc.processSignal(0.5, 60, 72, undefined, 0.002, { ...stableSqm });
    for (let i = 0; i < 35; i++) {
      const wobble = ((i % 5) - 2) * 0.001;
      last = proc.processSignal(0.5 + wobble, 60, 72, undefined, 0.002, { ...stableSqm });
    }
    expect(last.spo2.calibration?.available).toBe(true);
    expect(last.spo2.status).toBe('VALID');
    expect(last.spo2.value).not.toBeNull();
  });
});
