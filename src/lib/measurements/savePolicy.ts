/**
 * Política única: qué se puede guardar como medición final vs solo intento auditable.
 * Incluye validación de artefactos (movimiento, saturación, subexposición).
 */
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import type { MeasurementStatus } from '@/types/measurements';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

export type MeasurementAttemptOutcome =
  | 'valid_saved'
  | 'rejected_low_quality'
  | 'rejected_incomplete'
  | 'rejected_status'
  | 'rejected_artifact';

export interface ArtifactMetrics {
  motionArtifactRatio: number;
  saturationRatio: number;
  underexposureRatio: number;
  totalFrames: number;
}

const ARTIFACT_LIMITS = {
  MAX_MOTION_RATIO: 0.25,
  MAX_SATURATION_RATIO: 0.15,
  MAX_UNDEREXPOSURE_RATIO: 0.20,
  MIN_TOTAL_FRAMES: 30,
} as const;

function statusOk(s: MeasurementStatus | undefined): boolean {
  return s === 'VALID';
}

/** Resumen serializable para `measurement_attempts.diagnostics` (sin objetos cíclicos). */
export function buildAttemptDiagnostics(
  vitalSigns: VitalSignsResult,
  signalQuality: number,
  reasons: string[],
  artifactMetrics?: ArtifactMetrics,
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
    ...(artifactMetrics ? { artifacts: artifactMetrics } : {}),
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
  signalQuality: number,
  artifactMetrics?: ArtifactMetrics,
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

  const hrVal = vitalSigns.heartRate.value;
  const hrOk =
    statusOk(vitalSigns.heartRate.status) &&
    hrVal != null &&
    hrVal >= VITAL_THRESHOLDS.HR.MIN &&
    hrVal <= VITAL_THRESHOLDS.HR.MAX;

  if (!hrOk) {
    reasons.push('HR_OUT_OF_RANGE_OR_INVALID');
  }

  const spo2Val = vitalSigns.spo2.value;
  const spo2Ok =
    vitalSigns.spo2.status === 'VALID' &&
    spo2Val != null &&
    spo2Val >= VITAL_THRESHOLDS.SPO2.MIN_VALID &&
    spo2Val <= VITAL_THRESHOLDS.SPO2.MAX_VALID;

  if (!spo2Ok) {
    reasons.push('SPO2_NOT_VALID');
  }

  const bpVal = vitalSigns.bloodPressure.value;
  const bpOk =
    (vitalSigns.bloodPressure.status === 'VALID' ||
      vitalSigns.bloodPressure.status === 'REQUIRES_CALIBRATION') &&
    bpVal != null &&
    bpVal.systolic > 0 &&
    bpVal.diastolic > 0;

  if (!bpOk) {
    reasons.push('BP_NOT_VALID');
  }

  const sqiOk = signalQuality >= minSqi;

  // Validación de artefactos de sesión
  let artifactOk = true;
  if (artifactMetrics && artifactMetrics.totalFrames >= ARTIFACT_LIMITS.MIN_TOTAL_FRAMES) {
    if (artifactMetrics.motionArtifactRatio > ARTIFACT_LIMITS.MAX_MOTION_RATIO) {
      artifactOk = false;
      reasons.push(`MOTION_RATIO_${(artifactMetrics.motionArtifactRatio * 100).toFixed(0)}pct`);
    }
    if (artifactMetrics.saturationRatio > ARTIFACT_LIMITS.MAX_SATURATION_RATIO) {
      artifactOk = false;
      reasons.push(`SATURATION_RATIO_${(artifactMetrics.saturationRatio * 100).toFixed(0)}pct`);
    }
    if (artifactMetrics.underexposureRatio > ARTIFACT_LIMITS.MAX_UNDEREXPOSURE_RATIO) {
      artifactOk = false;
      reasons.push(`UNDEREXPOSURE_RATIO_${(artifactMetrics.underexposureRatio * 100).toFixed(0)}pct`);
    }
  }

  const canSaveFinal = hrOk && sqiOk && spo2Ok && bpOk && artifactOk;

  let outcome: MeasurementAttemptOutcome = 'valid_saved';
  if (!canSaveFinal) {
    if (!artifactOk) outcome = 'rejected_artifact';
    else if (!sqiOk) outcome = 'rejected_low_quality';
    else if (!hrOk) outcome = 'rejected_status';
    else outcome = 'rejected_incomplete';
  }

  return { canSaveFinal, outcome, reasons };
}
