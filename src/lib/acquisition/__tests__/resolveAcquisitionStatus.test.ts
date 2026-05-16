import { describe, it, expect } from 'vitest';
import { resolveAcquisitionStatus } from '../resolveAcquisitionStatus';

const base = {
  contactState: 'STABLE_CONTACT' as const,
  fingerDetected: true,
  coverageRatio: 0.18,
  perfusionIndex: 0.002,
  motionScore: 0.1,
  saturationRatio: 0,
  underexposureRatio: 0.05,
  fpsEffective: 28,
  frameDropRatio: 0.04,
  timestampJitterMs: 25,
  torchSupported: true,
  torchActive: true,
};

describe('resolveAcquisitionStatus', () => {
  it('sin dedo → NO_FINGER', () => {
    expect(resolveAcquisitionStatus({ ...base, fingerDetected: false, contactState: 'NO_CONTACT' })).toBe(
      'NO_FINGER',
    );
  });

  it('saturación → SATURATED', () => {
    expect(resolveAcquisitionStatus({ ...base, saturationRatio: 0.9 })).toBe('SATURATED');
  });

  it('contacto estable con señal ok → VALID', () => {
    expect(resolveAcquisitionStatus(base)).toBe('VALID');
  });
});
