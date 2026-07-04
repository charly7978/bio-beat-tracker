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
  /** Ventana larga tipo Elgendi (~667 ms) — referencia del umbral MA_beat */
  beatWindowMs: 667,
  /**
   * Beat-window ADAPTATIVO a la frecuencia: a baja HR (RR largo) la ventana fija
   * de 667 ms es MÁS CORTA que un latido, así que el umbral no se asienta bajo el
   * pico sistólico lento/ancho y cuesta detectar latidos lentos/débiles. Se escala
   * `beatWindow = clamp(RR_mediana · factor, 667, max)`: a HR alta (RR<785 ms) queda
   * en 667 (no cambia lo que ya anda); a HR baja se ensancha → umbral suave bajo el
   * pico lento. FP-seguro: una ventana MAYOR baja el umbral entre latidos pero el
   * burst sistólico (energía cuadrada, MA_peak) y el ancho mínimo de bloque siguen
   * exigiendo un latido real; no crea picos espurios.
   */
  beatWindowRrFactor: 0.85,
  beatWindowMsMax: 1100,
  /** Prominencia mínima de referencia (Elgendi); se escala por calibración en ventana */
  minProminence: 0.019,
  /** Retardo mínimo entre picos Elgendi (ms). NeuroKit2: mindelay=0.3 */
  minDelayMs: 300,
  /** Peso del offset adaptativo MA_beat (referencia; calibración ajusta por SQI/PI) */
  offsetWeight: 0.22,
  /**
   * Offset β del umbral Elgendi canónico: THR1 = MA_beat + β·media(energía).
   * Valor exacto de NeuroKit2/Elgendi 2013 = 0.02.
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

/**
 * Constantes DSP centralizadas — única fuente de verdad.
 * Evita valores duplicados ({@link HeartBeatProcessor}, {@link PPGSignalProcessor}, etc.).
 */
export const DSP_CONSTANTS = {
  /** Tamaño de búfer para señal PPG cruda y filtrada (≈10 s @ 30 fps). */
  BUFFER_SIZE: 300,
  /** Frecuencia de muestreo nominal por defecto (fps). */
  DEFAULT_SAMPLE_RATE: 30,
  /** Número máximo de intervalos RR almacenados para análisis de variabilidad. */
  MAX_RR_INTERVALS: 30,
  /** Tamaño de búfer por fuente para ranking competitivo de canales. */
  SOURCE_BUFFER_SIZE: 120,
} as const;

export const RESPIRATION_DEFAULTS = {
  /** Banda respiratoria típica 8–30 rpm → 0.13–0.5 Hz */
  minRpm: 6,
  maxRpm: 40,
  minStableFrames: 90,
  minBuffer: 240,
} as const;

/**
 * Fusión multi-modalidad de respiración — "Smart Fusion" (Karlen et al. 2013,
 * IEEE TBME, "Multiparameter Respiratory Rate Estimation From the PPG"). Se
 * estima la frecuencia respiratoria de TRES modulaciones inducidas por la
 * respiración y se fusionan SOLO si concuerdan (alta especificidad):
 *   - RIAV: variación de amplitud del pulso (envolvente)
 *   - RIIV: variación de intensidad/baseline (canal LP respiratorio)
 *   - RIFV: variación de frecuencia (arritmia sinusal respiratoria, serie RR)
 */
export const RESP_SMART_FUSION = {
  /** Calidad (pico de autocorrelación 0–1) mínima para que una modalidad cuente */
  MIN_MODALITY_QUALITY: 0.30,
  /** Std máxima (rpm) entre modalidades para considerarlas en consenso (Karlen ~4 bpm) */
  AGREEMENT_STD_RPM: 4.0,
  /** Frecuencia de re-muestreo de la serie RR para RIFV (Hz) */
  RIFV_RESAMPLE_HZ: 4.0,
  /** Mínimo de intervalos RR para intentar la modalidad RIFV */
  RIFV_MIN_RR: 6,
  /** Escala de confianza cuando solo UNA modalidad está disponible */
  SINGLE_MODALITY_CONF_SCALE: 0.55,
  /** Escala de confianza cuando las modalidades DISCREPAN (especificidad Karlen) */
  DISAGREEMENT_CONF_SCALE: 0.30,
  /** Mínimo de muestras en una serie de modalidad para estimar */
  MIN_SERIES_SAMPLES: 24,
} as const;
