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
  /**
   * Offset β del umbral Elgendi canónico: THR1 = MA_beat + β·media(energía).
   * Valor validado en NeuroKit2/Elgendi 2013 = 0.02. La calibración por
   * SQI/PI lo escala vía `offsetWeight` (β_efectivo = beatOffset·offsetWeight/0.22).
   */
  beatOffset: 0.02,
  /**
   * Periodo refractario FIJO de EMISIÓN de pico (anti muesca dícrota / doble
   * conteo). 300 ms es el mínimo validado (HR máx ~200 bpm). Es FIJO (no escala
   * con la mediana RR) para no bloquear latidos prematuros en arritmias ni
   * frenar la detección tras un latido perdido.
   */
  peakEmitRefractoryMinMs: 300,
  /**
   * Guard "latido imposiblemente temprano": rechaza un pico cuyo RR sea menor
   * que esta fracción de la mediana RR reciente (probable muesca dícrota a HR
   * baja o doble conteo que superó el refractario fijo). Sólo actúa por el lado
   * bajo del RR → no bloquea pausas/arritmias (los PVC acoplan >0.5× la mediana)
   * ni se re-sincroniza mal tras un latido perdido (un RR largo siempre pasa), y
   * a HR altas queda por debajo del refractario (no recorta la frecuencia máxima).
   */
  peakEmitMinRrFrac: 0.45,
  /**
   * Movimiento (IMU, motionScore EMA) por encima del cual se SUPRIME la emisión
   * de latidos: durante un movimiento claro la señal está corrupta y los picos
   * son artefactos. Conservador (rest ≈ 0.1–0.3; artefacto duro = 0.75) → no
   * actúa en reposo. Degrada con gracia: sin permiso de IMU motionScore = 0.
   */
  peakEmitMotionSuppress: 0.6,
  /**
   * Rechazo relativo de amplitud en Elgendi: se descartan picos cuya prominencia
   * sea menor que esta fracción de la prominencia mediana (muesca dícrota/ruido
   * son de menor amplitud que el pico sistólico). Conservador para no perder
   * latidos reales con modulación respiratoria.
   */
  peakAmplitudeRejectFraction: 0.35,
  /**
   * Cota SUPERIOR de amplitud relativa: se descartan picos cuya prominencia
   * supere esta fracción × la mediana. El micro-movimiento del dedo produce
   * excursiones bruscas (picos de amplitud anómala) — un latido real no supera
   * ~2.6× la prominencia mediana ni con potenciación post-extrasístole. Relativo
   * → no afecta señales débiles; alto → no descarta latidos reales ni PVC.
   */
  peakAmplitudeRejectUpper: 2.6,
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
