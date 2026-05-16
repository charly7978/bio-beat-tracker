/**
 * Compuertas únicas de adquisición → vitales (una sola fuente para Index).
 */
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { ContactState } from '@/types/signal';
import {
  isMeasurementPipelineLive,
  type MeasurementSessionLatch,
} from './measurementSessionLatch';

export interface MeasurementReadinessInput {
  hasUsableContact: boolean;
  contactState: ContactState;
  rawSqi: number;
  perfusionIndex: number;
  piMin: number;
  bpm: number;
  peakRecent: boolean;
  ensembleConfidence: number;
  minEnsembleConf: number;
  latch: MeasurementSessionLatch;
  nowMs: number;
}

export interface MeasurementReadiness {
  /** Alimentar DSP SpO2/BP/arr (dedo + SQI + PI mínimos) */
  vitalsDspReady: boolean;
  /** Mostrar/actualizar BPM en UI */
  hrDisplayReady: boolean;
  /** Sesión con picos recientes (PA/RR más fiables) */
  pipelineLive: boolean;
}

export function evaluateMeasurementReadiness(
  input: MeasurementReadinessInput,
): MeasurementReadiness {
  const Q = VITAL_THRESHOLDS.QUALITY;
  const {
    hasUsableContact,
    contactState,
    rawSqi,
    perfusionIndex,
    piMin,
    bpm,
    peakRecent,
    ensembleConfidence,
    minEnsembleConf,
    latch,
    nowMs,
  } = input;

  const pipelineLive = isMeasurementPipelineLive(
    latch,
    hasUsableContact,
    rawSqi,
    nowMs,
  );

  const piOk = perfusionIndex >= piMin;
  const latchWarming = latch.goodStreak >= 1 || latch.established;

  const vitalsDspReady =
    hasUsableContact &&
    rawSqi >= 3 &&
    piOk &&
    latchWarming;

  const confScale = contactState === 'STABLE_CONTACT' ? 1 : 0.82;
  const hrDisplayReady =
    hasUsableContact &&
    contactState !== 'NO_CONTACT' &&
    peakRecent &&
    bpm >= VITAL_THRESHOLDS.HR.MIN &&
    bpm <= VITAL_THRESHOLDS.HR.MAX &&
    rawSqi >= Q.MIN_FOR_HR &&
    ensembleConfidence >= minEnsembleConf * confScale;

  return { vitalsDspReady, hrDisplayReady, pipelineLive };
}
