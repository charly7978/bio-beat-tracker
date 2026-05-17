/**
 * Etiquetas y umbrales clínicos para el monitor PPG (solo presentación).
 */
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

export type ClinicalLevel = 'normal' | 'warn' | 'danger' | 'dim';

export interface ClinicalLabel {
  text: string;
  level: ClinicalLevel;
}

const HR = VITAL_THRESHOLDS.HR;
const SPO2 = VITAL_THRESHOLDS.SPO2;

export function hrZoneLabel(bpm: number): ClinicalLabel {
  if (bpm <= 0) return { text: '—', level: 'dim' };
  if (bpm < 50) return { text: 'BRADICARDIA SEVERA', level: 'danger' };
  if (bpm < 60) return { text: 'BRADICARDIA', level: 'warn' };
  if (bpm <= 100) return { text: 'NORMAL (SINUSAL)', level: 'normal' };
  if (bpm <= 120) return { text: 'TAQUICARDIA LEVE', level: 'warn' };
  if (bpm <= 150) return { text: 'TAQUICARDIA', level: 'danger' };
  return { text: 'TAQUICARDIA SEVERA', level: 'danger' };
}

export function spo2ZoneLabel(spo2: number): ClinicalLabel {
  if (spo2 <= 0) return { text: '—', level: 'dim' };
  if (spo2 >= 95) return { text: 'NORMOXIA', level: 'normal' };
  if (spo2 >= 90) return { text: 'HIPOXEMIA LEVE', level: 'warn' };
  if (spo2 >= 85) return { text: 'HIPOXEMIA MOD.', level: 'danger' };
  return { text: 'HIPOXEMIA SEVERA', level: 'danger' };
}

export function bpZoneLabel(sys: number, dia: number): ClinicalLabel {
  if (sys <= 0 || dia <= 0) return { text: '—', level: 'dim' };
  if (sys >= 140 || dia >= 90) return { text: 'HIPERTENSIÓN', level: 'danger' };
  if (sys >= 130 || dia >= 80) return { text: 'ELEVADA', level: 'warn' };
  if (sys < 90 || dia < 60) return { text: 'HIPOTENSIÓN', level: 'warn' };
  return { text: 'NORMAL', level: 'normal' };
}

export function formatContactState(state?: string): string {
  switch (state) {
    case 'STABLE_CONTACT':
      return 'CONTACTO ESTABLE';
    case 'UNSTABLE_CONTACT':
      return 'CONTACTO INESTABLE';
    case 'NO_CONTACT':
      return 'SIN CONTACTO';
    default:
      return state?.replace(/_/g, ' ') ?? '—';
  }
}

export function formatAcquisitionStatus(status?: string): string {
  if (!status) return '—';
  return status.replace(/_/g, ' ');
}

export function formatArrhythmiaStatus(status?: string, count = 0): string {
  if (!status || status === 'NORMAL' || status === 'SINUS_RHYTHM') {
    return count > 0 ? `RITMO REGULAR · ${count} eventos` : 'RITMO REGULAR';
  }
  return `${status.replace(/_/g, ' ')}${count > 0 ? ` · ${count}` : ''}`;
}

export function levelColor(level: ClinicalLevel): string {
  switch (level) {
    case 'normal':
      return '#22c55e';
    case 'warn':
      return '#f59e0b';
    case 'danger':
      return '#ef4444';
    default:
      return 'rgba(148, 163, 184, 0.75)';
  }
}

export function isHrInRange(bpm: number): boolean {
  return bpm >= HR.MIN && bpm <= HR.MAX;
}

export function isSpo2InRange(spo2: number): boolean {
  return spo2 >= SPO2.MIN_VALID && spo2 <= SPO2.MAX_VALID;
}
