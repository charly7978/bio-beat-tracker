import type { MeasurementStatus } from '../../types/measurements';
import { SignalQualityMetrics } from '../../types/measurements';
import type { ContactState } from '../../types/signal';
import { clamp } from '../../utils/math';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';

/** Estado interno para histéresis del overlay de calidad (anti-parpadeo). */
export interface DiagnosticStatusState {
  smoothedSqi: number;
  displayStatus: MeasurementStatus;
  lowStreak: number;
  validStreak: number;
}

export function createDiagnosticStatusState(): DiagnosticStatusState {
  return {
    smoothedSqi: 0,
    displayStatus: 'WARMUP',
    lowStreak: 0,
    validStreak: 0,
  };
}

/**
 * CENTRAL SIGNAL QUALITY INDEX (SQI)
 * 
 * Unifica todos los criterios de calidad técnica en un único motor.
 * Basado en:
 * - Perfusión (PI)
 * - Relación Señal-Ruido (SNR)
 * - Periodicidad (Autocorrelación)
 * - Estabilidad Temporal
 * - Artefactos de Movimiento
 */
export class SignalQualityIndex {
  /**
   * Calcula el SQI unificado (0-100)
   */
  static calculate(metrics: SignalQualityMetrics): number {
    const {
      perfusionIndex,
      snr,
      periodicity,
      motionScore,
      saturationRatio,
      frameDropRatio,
      fpsEffective,
      timestampJitterMs
    } = metrics;

    // PPG por cámara: PI en AC/DC suele ser 1e-4–1e-2; no anular todo el SQI por debajo de 0.1 %.
    if (perfusionIndex < 0.00012) return 0;
    if (saturationRatio > 0.8) return 5;
    const under = metrics.underexposureRatio ?? 0;
    if (under > 0.82) return 4;

    let score = 0;

    // 1. Perfusión (30%) — curva calibrada para smartphone + flash
    const piScore = clamp((perfusionIndex - 0.00025) / 0.01, 0, 1) * 30;
    score += piScore;

    // 2. SNR (25%) — `strength` del pipeline suele ser O(1), no exigir 1.2 como mínimo duro
    const snrVal = snr ?? 0;
    const snrScore = clamp((snrVal - 0.25) / 2.2, 0, 1) * 25;
    score += snrScore;

    // 3. Periodicidad (20%) — autocorrelación en ventana corta rara vez supera 0.45 estable
    const pVal = periodicity ?? 0;
    const pScore = clamp((pVal - 0.18) / 0.42, 0, 1) * 20;
    score += pScore;

    // 4. Penalizaciones por Estabilidad y Artefactos (-X)
    const motionPenalty = (motionScore ?? 0) * 45;
    const jitterPenalty = clamp((timestampJitterMs - 22) / 55, 0, 1) * 26;
    const dropPenalty = frameDropRatio * 95;
    const lowFpsPenalty = fpsEffective < 25 ? (25 - fpsEffective) * 5 : 0;

    const agree = metrics.detectorAgreement ?? 0;
    const agreeBonus = agree > 0 ? clamp(agree, 0, 1) * 12 : 0;

    score = Math.max(0, score - motionPenalty - jitterPenalty - dropPenalty - lowFpsPenalty) + agreeBonus;

    // 5. Bonus por consistencia (si PI y SNR son razonables para cámara)
    if (perfusionIndex > 0.0025 && snrVal > 0.9) score += 12;

    return Math.round(clamp(score, 0, 100));
  }

  /**
   * Determina si la señal es apta para cálculos clínicos de alta precisión
   */
  static isClinicallyValid(sqi: number, pi: number): boolean {
    return sqi >= 55 && pi >= 0.0012;
  }

  /**
   * Umbral más bajo que {@link isClinicallyValid}: suficiente para mostrar HR/SpO2/BP estimados
   * en cámara+dedo cuando la señal es usable pero no “certificable”.
   */
  static isAdequateForLiveVitals(sqi: number, pi: number): boolean {
    return sqi >= 12 && pi >= 0.00028;
  }

  /**
   * Estado mostrado en UI (PPGSignalMeter) con EMA + histéresis.
   * Rechazos duros (saturación, etc.) se aplican al instante.
   */
  static resolveDiagnosticDisplayStatus(
    state: DiagnosticStatusState,
    opts: {
      rejectionStatus: MeasurementStatus | null;
      rawSqi: number;
      pi: number;
      fingerDetected: boolean;
      contactState: ContactState;
    },
  ): MeasurementStatus {
    const Q = VITAL_THRESHOLDS.QUALITY;
    const hard = opts.rejectionStatus;
    if (hard && hard !== 'WARMUP' && hard !== 'MOTION_ARTIFACT') {
      state.displayStatus = hard;
      state.lowStreak = 0;
      state.validStreak = 0;
      return hard;
    }

    if (hard === 'WARMUP') {
      state.displayStatus = 'WARMUP';
      state.lowStreak = 0;
      state.validStreak = 0;
      return 'WARMUP';
    }

    const raw = opts.rawSqi;
    if (state.smoothedSqi <= 0 && raw > 0) {
      state.smoothedSqi = raw;
    } else if (raw > 0) {
      const a = Q.DIAG_SQI_EMA_ALPHA;
      state.smoothedSqi = state.smoothedSqi * (1 - a) + raw * a;
    } else {
      state.smoothedSqi *= 0.92;
    }

    const canAssess =
      opts.fingerDetected && opts.contactState !== 'NO_CONTACT';
    if (!canAssess) {
      state.displayStatus = 'WARMUP';
      state.lowStreak = 0;
      state.validStreak = 0;
      return 'WARMUP';
    }

    const adequate =
      this.isAdequateForLiveVitals(raw, opts.pi) ||
      this.isAdequateForLiveVitals(Math.round(state.smoothedSqi), opts.pi);
    const smoothed = state.smoothedSqi;
    const instantValid =
      adequate || smoothed >= Q.DIAG_EXIT_VALID_SQI || raw >= Q.DIAG_EXIT_VALID_SQI + 4;
    const instantLow =
      !adequate &&
      smoothed < Q.DIAG_ENTER_LOW_SQI &&
      raw < Q.DIAG_ENTER_LOW_SQI + 4;

    if (instantValid) {
      state.validStreak = Math.min(state.validStreak + 1, Q.DIAG_VALID_FRAMES_REQ + 4);
      state.lowStreak = Math.max(0, state.lowStreak - 2);
    } else if (instantLow) {
      state.lowStreak = Math.min(state.lowStreak + 1, Q.DIAG_LOW_FRAMES_REQ + 4);
      state.validStreak = Math.max(0, state.validStreak - 1);
    } else {
      state.validStreak = Math.max(0, state.validStreak - 1);
      state.lowStreak = Math.max(0, state.lowStreak - 1);
    }

    if (state.displayStatus === 'WARMUP' || state.displayStatus === 'LOW_SIGNAL_QUALITY') {
      if (state.validStreak >= Q.DIAG_VALID_FRAMES_REQ || (adequate && state.validStreak >= 2)) {
        state.displayStatus = 'VALID';
      } else if (state.lowStreak >= Q.DIAG_LOW_FRAMES_REQ) {
        state.displayStatus = 'LOW_SIGNAL_QUALITY';
      }
    } else if (state.displayStatus === 'VALID') {
      if (state.lowStreak >= Q.DIAG_LOW_FRAMES_REQ) {
        state.displayStatus = 'LOW_SIGNAL_QUALITY';
        state.validStreak = 0;
      }
    } else {
      state.displayStatus = adequate ? 'VALID' : 'LOW_SIGNAL_QUALITY';
    }

    if (hard === 'MOTION_ARTIFACT' && state.displayStatus === 'VALID') {
      return 'MOTION_ARTIFACT';
    }

    return state.displayStatus;
  }
}
