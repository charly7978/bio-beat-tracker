/**
 * Política única: qué se puede guardar como medición final vs solo intento auditable.
 */
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import type { MeasurementStatus } from '@/types/measurements';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

export type MeasurementAttemptOutcome =
  | 'valid_saved'
  | 'rejected_low_quality'
  | 'rejected_incomplete'
  | 'rejected_status';

function statusOk(s: MeasurementStatus | undefined): boolean {
  return s === 'VALID';
}

/** Resumen serializable para `measurement_attempts.diagnostics` (sin objetos cíclicos). */
export function buildAttemptDiagnostics(
  vitalSigns: VitalSignsResult,
  signalQuality: number,
  reasons: string[]
): Record<string, unknown> {
  const snap = (name: string, m: VitalSignsResult['heartRate']) => ({
    name,
    value: m.value,
    unit: m.unit,
    status: m.status,
    reason: m.reason,
    confidence: m.confidence,
  });
  return {
    signalQuality,
    reasons,
    vitals: {
      heartRate: snap('HR', vitalSigns.heartRate),
      spo2: snap('SpO2', vitalSigns.spo2),
      bloodPressure: {
        status: vitalSigns.bloodPressure.status,
        reason: vitalSigns.bloodPressure.reason,
        confidence: vitalSigns.bloodPressure.confidence,
        value: vitalSigns.bloodPressure.value,
      },
      respiration: snap('RR', vitalSigns.respiration as unknown as VitalSignsResult['heartRate']),
      arrhythmia: vitalSigns.arrhythmia.value,
    },
    calibration: {
      spo2: vitalSigns.spo2.calibration,
      bp: vitalSigns.bloodPressure.calibration,
    },
  };
}

export function evaluateFinalMeasurementSave(
  vitalSigns: VitalSignsResult,
  signalQuality: number
): {
  canSaveFinal: boolean;
  outcome: MeasurementAttemptOutcome;
  reasons: string[];
} {
  const reasons: string[] = [];
  const minSqi = VITAL_THRESHOLDS.QUALITY.MIN_FOR_CLINICAL;

  if (signalQuality < minSqi) {
    reasons.push(`SQI_${signalQuality}_LT_${minSqi}`);
  }
  if (!statusOk(vitalSigns.heartRate.status)) {
    reasons.push(`HR_STATUS_${vitalSigns.heartRate.status}`);
  }
  if (vitalSigns.heartRate.value == null || vitalSigns.heartRate.value <= 0) {
    reasons.push('HR_VALUE_MISSING');
  }

  const hrOk =
    statusOk(vitalSigns.heartRate.status) &&
    vitalSigns.heartRate.value != null &&
    vitalSigns.heartRate.value > VITAL_THRESHOLDS.HR.MIN &&
    vitalSigns.heartRate.value < VITAL_THRESHOLDS.HR.MAX;

  if (!hrOk) {
    reasons.push('HR_OUT_OF_RANGE_OR_INVALID');
  }

  const sqiOk = signalQuality >= minSqi;
  const canSaveFinal = hrOk && sqiOk;

  let outcome: MeasurementAttemptOutcome = 'valid_saved';
  if (!canSaveFinal) {
    if (!sqiOk) outcome = 'rejected_low_quality';
    else if (!hrOk) outcome = 'rejected_status';
    else outcome = 'rejected_incomplete';
  }

  return { canSaveFinal, outcome, reasons };
}
