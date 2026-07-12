/**
 * ADAPTIVE STATE TRACKER — filtro de Kalman escalar adaptativo para HR.
 *
 * Rastrea la frecuencia cardíaca como un estado latente continuo con
 * incertidumbre cuantificada (no un número por frame). El ruido de medición se
 * adapta a la calidad de la observación y el ruido de proceso se adapta a la
 * innovación (si el HR real cambia rápido, el filtro se destraba para seguirlo).
 * Esto da un intervalo de confianza para el HR e informa cuándo la creencia
 * CONVERGIÓ (baja incertidumbre sostenida) — el análogo analítico de la
 * incertidumbre calibrada de BeliefPPG.
 *
 * Ref.: filtro de Kalman adaptativo cardiorrespiratorio con covarianzas
 * auto-adaptadas (BMC Med Inform Decis Mak, 2014) — deployable en tiempo real.
 */
import { clamp } from '../../utils/math';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import type { HeartRateBelief } from './types';

const HR_MIN = VITAL_THRESHOLDS.HR.MIN;
const HR_MAX = VITAL_THRESHOLDS.HR.MAX;

/** Ruido de proceso base (bpm²/paso): cuánto puede derivar el HR entre ventanas. */
const Q_BASE = 0.8;
/** Ruido de medición base (bpm²) con observación de máxima calidad. */
const R_BASE = 4;
/** Varianza inicial de la creencia (alta = sin información). */
const P_INIT = 400;
/** Varianza por debajo de la cual la creencia se considera convergida. */
const CONVERGED_VAR = 16; // std ≤ 4 bpm

export class AdaptiveStateTracker {
  private hr = 0;
  private variance = P_INIT;
  private initialized = false;
  private convergedStreak = 0;

  reset(): void {
    this.hr = 0;
    this.variance = P_INIT;
    this.initialized = false;
    this.convergedStreak = 0;
  }

  /**
   * Actualiza la creencia de HR con una observación.
   * @param observedBpm  BPM observado (0 o fuera de rango → sin observación válida).
   * @param quality      Calidad de la observación (0–1): escala el ruido de medición.
   */
  update(observedBpm: number, quality: number): HeartRateBelief {
    const validObs = Number.isFinite(observedBpm) && observedBpm >= HR_MIN && observedBpm <= HR_MAX;
    const q = clamp(quality, 0, 1);

    if (!this.initialized) {
      if (!validObs) return this.belief();
      this.hr = observedBpm;
      this.variance = P_INIT * 0.5;
      this.initialized = true;
      return this.belief();
    }

    // --- Predicción: el HR persiste; el ruido de proceso se adapta a la innovación. ---
    const innovation = validObs ? observedBpm - this.hr : 0;
    // Innovación grande sostenida → el HR real cambió → destrabar (más Q).
    const adaptiveQ = Q_BASE * (1 + clamp(Math.abs(innovation) / 12, 0, 4));
    this.variance += adaptiveQ;

    if (!validObs) {
      // Sin observación: solo crece la incertidumbre (predicción pura).
      this.convergedStreak = 0;
      return this.belief();
    }

    // --- Actualización: ruido de medición inversamente proporcional a la calidad. ---
    const measurementNoise = R_BASE / Math.max(0.05, q * q);
    const gain = this.variance / (this.variance + measurementNoise);
    this.hr = clamp(this.hr + gain * innovation, HR_MIN, HR_MAX);
    this.variance = (1 - gain) * this.variance;

    if (this.variance <= CONVERGED_VAR) this.convergedStreak = Math.min(this.convergedStreak + 1, 30);
    else this.convergedStreak = 0;

    return this.belief();
  }

  private belief(): HeartRateBelief {
    if (!this.initialized) {
      return { bpm: 0, std: 0, low: 0, high: 0, converged: false };
    }
    const std = Math.sqrt(Math.max(0, this.variance));
    const margin = 1.96 * std;
    return {
      bpm: this.hr,
      std,
      low: clamp(this.hr - margin, HR_MIN, HR_MAX),
      high: clamp(this.hr + margin, HR_MIN, HR_MAX),
      converged: this.convergedStreak >= 3,
    };
  }
}
