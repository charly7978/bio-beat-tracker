/**
 * Compuertas únicas de adquisición → vitales (una sola fuente para Index).
 */
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { ContactState } from '@/types/signal';
import {
  isMeasurementPipelineLive,
  SESSION_LATCH,
  type MeasurementSessionLatch,
} from './measurementSessionLatch';

export interface MeasurementReadinessInput {
  /**
   * PULSO CARDÍACO VERIFICADO sobre la señal (ver `lib/signal/pulseVerification`).
   * Condición NECESARIA para publicar cualquier signo vital. Antes la compuerta
   * efectiva era la detección de dedo por color más unos pisos a nivel de ruido
   * (`rawSqi >= 3`, PI ≥ 0,0036 %), que cualquier escena satisfacía: por eso la
   * app entregaba una medición completa apuntando a cualquier lado.
   */
  pulseVerified: boolean;
  hasUsableContact: boolean;
  contactState: ContactState;
  rawSqi: number;
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
    pulseVerified,
    hasUsableContact,
    contactState,
    rawSqi,
    bpm,
    peakRecent,
    ensembleConfidence,
    minEnsembleConf,
    latch,
    nowMs,
  } = input;

  const pipelineLive =
    pulseVerified && isMeasurementPipelineLive(latch, hasUsableContact, rawSqi, nowMs);

  // El pulso verificado manda. `hasUsableContact` (color) queda como condición
  // ADICIONAL, nunca suficiente por sí sola: sin latido real comprobado en la
  // señal no se publica ningún signo vital.
  //
  // El antiguo `piOk` (PI ≥ piMin) se ELIMINÓ por muerto: exigía 0,000036 cuando
  // `pulseVerified` ya exige 0,0015 sobre la MISMA magnitud — 41,7× más estricto,
  // así que jamás podía rechazar nada que el pulso hubiera aceptado. Con él se
  // fueron `piMin`, `ROUTER.PI_MIN_READINESS_*` y `minPiScale` del perfil de
  // cámara, que no alimentaban ninguna otra decisión.
  const spo2PipelineReady =
    pulseVerified && hasUsableContact && rawSqi >= SESSION_LATCH.MIN_SQI;

  const fullVitalsReady =
    spo2PipelineReady &&
    peakRecent &&
    (latch.established || latch.goodStreak >= SESSION_LATCH.ESTABLISH_STREAK);

  const confScale = contactState === 'STABLE_CONTACT' ? 1 : 0.85;
  const hrBpm =
    bpm > 0 ? bpm : latch.lastBpm > 0 ? latch.lastBpm : 0;
  const hrDisplayReady =
    pulseVerified &&
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
