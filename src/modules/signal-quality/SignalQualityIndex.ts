import { SignalQualityMetrics } from '../../types/measurements';
import { clamp } from '../../utils/math';

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
}
