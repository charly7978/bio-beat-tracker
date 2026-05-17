import { describe, expect, it } from 'vitest';
import {
  bpZoneLabel,
  formatContactState,
  hrZoneLabel,
  levelColor,
  spo2ZoneLabel,
} from '../ppgMonitorClinical';

describe('ppgMonitorClinical', () => {
  it('clasifica FC en zonas clínicas', () => {
    expect(hrZoneLabel(55).text).toBe('BRADICARDIA');
    expect(hrZoneLabel(72).level).toBe('normal');
    expect(hrZoneLabel(130).text).toContain('TAQUICARDIA');
  });

  it('clasifica SpO2 y PA', () => {
    expect(spo2ZoneLabel(96).text).toBe('NORMOXIA');
    expect(bpZoneLabel(118, 76).text).toBe('NORMAL');
    expect(bpZoneLabel(145, 92).text).toBe('HIPERTENSIÓN');
  });

  it('formatea contacto y colores', () => {
    expect(formatContactState('STABLE_CONTACT')).toBe('CONTACTO ESTABLE');
    expect(levelColor('danger')).toBe('#ef4444');
  });
});
