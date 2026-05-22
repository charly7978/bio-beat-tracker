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
      timestampJitterMs,
    } = metrics;

    // PPG por cámara: PI en AC/DC suele ser 1e-4–1e-2; no anular todo el SQI por debajo de 0.1 %.
    if (perfusionIndex < 0.00008) return 0;
    if (saturationRatio > 0.8) return 5;
    const under = metrics.underexposureRatio ?? 0;
    if (under > 0.82) return 4;

    let score = 0;

    // 1. Perfusión (32%) — curva ajustada: PI smartphone típico 0.001-0.002
    const piScore = clamp((perfusionIndex - 0.00012) / 0.002, 0, 1) * 32;
    score += piScore;

    // 2. SNR (24%) — `strength` del pipeline suele ser O(0.3–2)
    const snrVal = snr ?? 0;
    const snrScore = clamp((snrVal - 0.12) / 1.35, 0, 1) * 24;
    score += snrScore;

    // 3. Periodicidad (22%) — autocorrelación en ventana corta rara vez supera 0.5 estable
    const pVal = periodicity ?? 0;
    const pScore = clamp((pVal - 0.1) / 0.38, 0, 1) * 22;
    score += pScore;

    // 4. Penalizaciones acotadas (móvil: motion/jitter/drops son normales)
    const motion = motionScore ?? 0;
    const motionPenalty = clamp((motion - 0.22) / 0.55, 0, 1) * 14;
    const jitterPenalty = clamp((timestampJitterMs - 38) / 48, 0, 1) * 10;
    const dropPenalty = Math.min(14, (frameDropRatio ?? 0) * 42);
    const lowFpsPenalty = fpsEffective < 22 ? (22 - fpsEffective) * 3.5 : 0;

    const agree = metrics.detectorAgreement ?? 0;
    const agreeBonus = agree > 0 ? clamp(agree, 0, 1) * 10 : 0;

    score = Math.max(0, score - motionPenalty - jitterPenalty - dropPenalty - lowFpsPenalty) + agreeBonus;

    // 5. Bonus por consistencia (PI/SNR razonables en cámara)
    if (perfusionIndex > 0.0018 && snrVal > 0.55) score += 10;
    if (pVal > 0.22 && perfusionIndex > 0.0005) score += 6;

    return Math.round(clamp(score, 0, 100));
  }

  /** Fusiona métricas PPG con telemetría del ensemble (sin recalcular SQI en otro módulo). */
  static enrichMetrics(
    base: Partial<SignalQualityMetrics> & { sqi?: number },
    peak?: {
      elgendiConfidence?: number;
      agreement?: { elgendi?: number; spectral?: number };
    },
  ): SignalQualityMetrics {
    const el = peak?.elgendiConfidence ?? base.elgendiConfidence ?? null;
    const agreeRaw =
      peak?.agreement != null
        ? (peak.agreement.elgendi ?? 0) * 0.6 +
          (peak.agreement.spectral ?? 0) * 0.4
        : base.detectorAgreement ?? null;

    const merged: SignalQualityMetrics = {
      sqi: base.sqi ?? 0,
      perfusionIndex: base.perfusionIndex ?? 0,
      snr: base.snr ?? null,
      periodicity: base.periodicity ?? null,
      motionScore: base.motionScore ?? null,
      saturationRatio: base.saturationRatio ?? 0,
      underexposureRatio: base.underexposureRatio ?? 0,
      frameDropRatio: base.frameDropRatio ?? 0,
      fpsEffective: base.fpsEffective ?? 30,
      timestampJitterMs: base.timestampJitterMs ?? 0,
      elgendiConfidence: el,
      detectorAgreement: agreeRaw,
    };

    if (typeof base.sqi !== 'number' || base.sqi <= 0) {
      merged.sqi = this.calculate(merged);
    }
    return merged;
  }

  /**
   * SQI mostrado en UI: EMA del crudo, sin compresión por contacto inestable.
   */
  static smoothDisplayedSqi(
    prev: number,
    raw: number,
    contactState: ContactState,
    rejectionScale = 1,
  ): number {
    const alpha = VITAL_THRESHOLDS.QUALITY.DISPLAY_SQI_EMA_ALPHA;
    const scaled = raw * clamp(rejectionScale, 0.35, 1);

    if (contactState === 'NO_CONTACT') {
      return 0;
    }
    if (scaled <= 0) {
      return prev > 0 ? Math.round(prev * 0.92) : 0;
    }
    if (prev <= 0) return Math.round(clamp(scaled, 0, 100));
    const next = prev * (1 - alpha) + scaled * alpha;
    return Math.round(clamp(next, 0, 100));
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
