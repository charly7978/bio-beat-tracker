import { describe, it, expect } from 'vitest';
import {
  SignalQualityIndex,
  createDiagnosticStatusState,
} from '../SignalQualityIndex';

describe('SignalQualityIndex.resolveDiagnosticDisplayStatus', () => {
  it('mantiene VALID con SQI crudo oscilando alrededor del umbral antiguo (45)', () => {
    const state = createDiagnosticStatusState();
    const pi = 0.0015;
    const base = {
      rejectionStatus: null,
      pi,
      fingerDetected: true,
      contactState: 'UNSTABLE_CONTACT' as const,
    };

    for (let i = 0; i < 8; i++) {
      SignalQualityIndex.resolveDiagnosticDisplayStatus(state, {
        ...base,
        rawSqi: 48,
      });
    }
    expect(state.displayStatus).toBe('VALID');

    for (let i = 0; i < 6; i++) {
      const sqi = i % 2 === 0 ? 44 : 46;
      SignalQualityIndex.resolveDiagnosticDisplayStatus(state, { ...base, rawSqi: sqi });
    }
    expect(state.displayStatus).toBe('VALID');
  });

  it('pasa a LOW solo tras racha sostenida de SQI muy bajo', () => {
    const state = createDiagnosticStatusState();
    const base = {
      rejectionStatus: null,
      pi: 0.0001,
      fingerDetected: true,
      contactState: 'STABLE_CONTACT' as const,
    };

    for (let i = 0; i < 12; i++) {
      SignalQualityIndex.resolveDiagnosticDisplayStatus(state, { ...base, rawSqi: 8 });
    }
    expect(state.displayStatus).toBe('LOW_SIGNAL_QUALITY');
  });
});
