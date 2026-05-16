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
  /** SpO2: dedo + SQI + PI (no exige picos recientes) */
  spo2PipelineReady: boolean;
  /** BP/arritmia: sesión con picos + RR */
  fullVitalsReady: boolean;
  /** Alias legacy: mismo que spo2PipelineReady para no cortar SpO2 */
  vitalsDspReady: boolean;
  hrDisplayReady: boolean;
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

  const spo2PipelineReady =
    hasUsableContact && rawSqi >= 3 && piOk;

  const fullVitalsReady =
    spo2PipelineReady &&
    peakRecent &&
    (latch.established || latch.goodStreak >= 2);

  const confScale = contactState === 'STABLE_CONTACT' ? 1 : 0.85;
  const hrBpm =
    bpm > 0 ? bpm : latch.lastBpm > 0 ? latch.lastBpm : 0;
  const hrDisplayReady =
    hasUsableContact &&
    contactState !== 'NO_CONTACT' &&
    peakRecent &&
    hrBpm >= VITAL_THRESHOLDS.HR.MIN &&
    hrBpm <= VITAL_THRESHOLDS.HR.MAX &&
    rawSqi >= Q.MIN_FOR_HR &&
    ensembleConfidence >= minEnsembleConf * confScale;

  return {
    spo2PipelineReady,
    fullVitalsReady,
    vitalsDspReady: spo2PipelineReady,
    hrDisplayReady,
    pipelineLive,
  };
}
