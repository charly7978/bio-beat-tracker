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
  /** Prominencia mínima de referencia (Elgendi); se escala por calibración en ventana */
  minProminence: 0.019,
  /** Peso del offset adaptativo MA_beat (referencia; calibración ajusta por SQI/PI) */
  offsetWeight: 0.22,
  /** Factor mínimo del RR fisiológico entre emisiones de pico (anti-doble latido) */
  peakEmitRefractoryFactor: 0.80,
  minSQI: 10,
  /** Ventana para emitir pico respecto al frame actual (ms) — ~½ RR @ 45 BPM */
  peakEmitWindowMs: 720,
  /** Mínimo de muestras en ventana para correr ensemble */
  minSamplesEnsemble: 72,
  /** Ventana de integración para detección (~180 ms de pulso sistólico típico a 30 Hz) */
  integrationWindowMs: 180,
  /** Refractario máximo derivado de maxBpm */
  refractoryMsFromMaxBpm: 60000 / VITAL_THRESHOLDS.HR.MAX,
  /** Re-muestreo uniforme si jitter de timestamps supera este factor × mediana Δt */
  RESAMPLE_JITTER_FACTOR: 1.45,
  RESAMPLE_DT_MIN_MS: 5,
  RESAMPLE_DT_MAX_MS: 120,
  RESAMPLE_TARGET_MIN: 64,
  RESAMPLE_TARGET_MAX: 512,
  /** Normalización robusta del latido para ensemble (escala ±) */
  HEARTBEAT_NORM_SCALE: 120,
  HEARTBEAT_NORM_MIN_RANGE: 0.032,
  HEARTBEAT_NORM_FALLBACK_GAIN: 8,
  HEARTBEAT_WINDOW_WARMUP: 120,
  HEARTBEAT_WINDOW_STABLE: 180,
  /**
   * Anclas de calibración adaptativa (no mmHg): escalan umbrales Elgendi/Pan
   * según dinámica de la ventana, SQI, PI y BPM espectral.
   */
  CALIBRATION: {
    TARGET_DYNAMIC_RANGE: 0.55,
    PROMINENCE_SCALE_MIN: 0.55,
    PROMINENCE_SCALE_MAX: 1.45,
    OFFSET_WEIGHT_MIN: 0.14,
    OFFSET_WEIGHT_MAX: 0.32,
    TARGET_PI: 0.0045,
    SQI_REFERENCE: 48,
  },
} as const;

export const RESPIRATION_DEFAULTS = {
  /** Banda respiratoria típica 8–30 rpm → 0.13–0.5 Hz */
  minRpm: 6,
  maxRpm: 40,
  minStableFrames: 90,
  minBuffer: 240,
} as const;
