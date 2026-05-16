/**
 * Configuración centralizada de DSP y detección de picos PPG.
 * Los límites fisiológicos se reutilizan desde `vitalThresholds` (una sola fuente).
 */
import { VITAL_THRESHOLDS } from './vitalThresholds';

export const PEAK_DETECTION_DEFAULTS = {
  minBpm: VITAL_THRESHOLDS.HR.MIN,
  maxBpm: VITAL_THRESHOLDS.HR.MAX,
  minPeakDistanceMs: VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS,
  maxPeakDistanceMs: VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS,
  /** Ventana corta tipo Elgendi (~111 ms @ fs nominal) */
  peakWindowMs: 111,
  /** Ventana larga tipo Elgendi (~667 ms) */
  beatWindowMs: 667,
  /** Peso del offset adaptativo sobre la energía de MA_peak */
  offsetWeight: 0.35,
  /** Picos débiles en cámara móvil: prominencia mínima algo más baja (literatura Elgendi usa umbral adaptativo vía MA) */
  minProminence: 0.056,
  /** Factor mínimo del RR fisiológico entre emisiones de pico (anti-doble latido) */
  peakEmitRefractoryFactor: 0.82,
  minSQI: 10,
  /** Ventana para emitir pico respecto al frame actual (ms) */
  peakEmitWindowMs: 380,
  /** Acuerdo espectral mínimo antes de penalizar BPM instantáneo */
  spectralAgreementMin: 0.38,
  /** Mínimo de muestras en ventana para correr ensemble */
  minSamplesEnsemble: 72,
  /** Integración Pan–Tompkins PPG (~180 ms de pulso sistólico típico a 30 Hz) */
  integrationWindowMs: 180,
  /** Refractario máximo derivado de maxBpm */
  refractoryMsFromMaxBpm: 60000 / VITAL_THRESHOLDS.HR.MAX,
} as const;

export const RESPIRATION_DEFAULTS = {
  /** Banda respiratoria típica 8–30 rpm → 0.13–0.5 Hz */
  minRpm: 6,
  maxRpm: 40,
  minStableFrames: 90,
  minBuffer: 240,
} as const;
