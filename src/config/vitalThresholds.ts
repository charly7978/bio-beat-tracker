/**
 * MEDICAL AND PHYSIOLOGICAL THRESHOLDS (Single Source of Truth)
 * 
 * Basado en estándares de la AHA (American Heart Association) 
 * y literatura de procesamiento de señales PPG.
 */

export const VITAL_THRESHOLDS = {
  // HEART RATE (BPM)
  HR: {
    MIN: 30,
    MAX: 220,
    PHYSIOLOGICAL_RR_MIN_MS: 270,
    PHYSIOLOGICAL_RR_MAX_MS: 2200,
  },
  
  // BLOOD OXYGEN (SpO2)
  SPO2: {
    MIN_VALID: 70,
    MAX_VALID: 100,
    CRITICAL_LOW: 90,
    R_VALUE_MIN: 0.1,
    R_VALUE_MAX: 2.5,
  },
  
  /** Geometría dedo: unificar punta (HR/SpO2) y almohadilla (PA) */
  PLACEMENT: {
    PAD_COVERAGE_MIN: 0.17,
    PAD_CV_MAX: 0.048,
    TIP_COVERAGE_MAX: 0.16,
    TIP_CV_MIN: 0.034,
    TIP_PI_MIN: 0.00045,
    BP_CYCLE_QUALITY_TIP: 0.24,
    BP_CYCLE_QUALITY_PAD: 0.28,
    BP_CYCLE_QUALITY_HYBRID: 0.26,
  },

  // BLOOD PRESSURE (mmHg + pipeline morfológico)
  BP: {
    /** Límites PPG cámara — evitar pisos que fijan DBP en un valor constante */
    SYSTOLIC_MIN: 75,
    SYSTOLIC_MAX: 250,
    DIASTOLIC_MIN: 50,
    DIASTOLIC_MAX: 130,
    MIN_PP: 20,
    MAX_PP: 110,
    MIN_CYCLES: 3,
    MIN_CYCLE_QUALITY: 0.28,
    MIN_BUFFER_SAMPLES: 120,
    STABILITY_FRAMES_HIGH: 45,
    STABILITY_FRAMES_MEDIUM: 28,
    FEATURE_QUALITY_HIGH: 72,
    FEATURE_QUALITY_MEDIUM: 48,
    MIN_RR_CONFIDENCE: 0.08,
  },
  
  // SIGNAL QUALITY (SQI)
  QUALITY: {
    /** SQI mínimo para publicar BPM en UI (la onda puede verse antes) */
    MIN_FOR_HR: 10,
    /** Confianza mínima del ensemble para mostrar BPM en contacto inestable */
    MIN_ENSEMBLE_CONF_UNSTABLE: 0.12,
    MIN_ENSEMBLE_CONF_STABLE: 0.09,
    /** Confianza mínima del ensemble para emitir pico audible/visual */
    MIN_ENSEMBLE_CONF_FOR_PEAK: 0.12,
    /** Acuerdo Elgendi+Pan mínimo para alimentar arritmias */
    MIN_DETECTOR_AGREEMENT_ARRHYTHMIA: 0.42,
    MIN_FOR_CLINICAL: 55,
    /** PI (AC/DC) mínimo para marcar contacto STABLE — cámara suele dar 0.001–0.008 al inicio */
    MIN_PI: 0.0009,
    MAX_MOTION: 0.75,
    MAX_JITTER_MS: 55,
    /** Frames con dedo candidato antes de STABLE (≈0,4 s @ 30 fps) */
    STABLE_FRAMES_REQ: 12,
    /** EMA del SQI mostrado en UI (0–1 por frame) */
    DISPLAY_SQI_EMA_ALPHA: 0.2,
    /** Solo vaciar buffers DSP tras este tiempo en NO_CONTACT (evita “todo/nada”) */
    BUFFER_RESET_AFTER_NO_CONTACT_FRAMES: 8,
    /** Overlay diagnóstico — evita parpadeo VALID ↔ LOW_SIGNAL_QUALITY */
    DIAG_SQI_EMA_ALPHA: 0.14,
    DIAG_ENTER_LOW_SQI: 22,
    DIAG_EXIT_VALID_SQI: 26,
    DIAG_LOW_FRAMES_REQ: 10,
    DIAG_VALID_FRAMES_REQ: 4,
  },

  /** Detección de irregularidad del ritmo (conservador — menos falsos positivos) */
  ARRHYTHMIA: {
    RR_WINDOW_SIZE: 10,
    RMSSD_THRESHOLD_MS: 68,
    MIN_INTERVALS: 9,
    MIN_SQI: 38,
    LEARNING_PERIOD_MS: 12_000,
    MIN_EVENT_INTERVAL_MS: 6000,
    PNNX_THRESHOLD: 0.42,
    SHANNON_ENTROPY_THRESHOLD: 2.15,
    SAMPLE_ENTROPY_THRESHOLD: 1.65,
    OUTLIER_RATIO: 0.16,
    ABRUPT_RR_FRAC: 0.16,
    IRREGULAR_DIFF_MS: 165,
  },

  // FINGER + ROI (cámara trasera + dedo; hemoglobina + pulsación temporal)
  FINGER: {
    /** Fracción del lado corto del frame usada como ROI cuadrado central (más = más dedo visible) */
    ROI_SIZE_FRACTION: 0.96,
    /** Penalización radial en tiles: menor = más tolerante si el dedo no está perfectamente centrado */
    ROI_CENTER_BIAS_MULT: 0.95,
    ROI_CENTER_BIAS_MIN: 0.35,
    /** Brillo mínimo en score de tile (total RGB medio por celda) */
    TILE_BRIGHTNESS_OFFSET: 82,
    MIN_RED_INTENSITY: 36,
    MIN_RED_DOMINANCE: 7,
    MIN_RG_RATIO: 1.04,
    MIN_COVERAGE: 0.12,
    /** R/B mínimo — dedo absorbe azul; flash sin dedo suele fallar esto */
    HEMOGLOBIN_MIN_RB: 1.22,
    SOFT_COVERAGE_MULT: 0.85,
    /** Adquisición estricta */
    ACQUIRE_RB_STRICT: 1.2,
    ACQUIRE_INTENSITY_MIN: 68,
    ACQUIRE_INTENSITY_MAX: 780,
    ACQUIRE_SMOOTHED_FINGER_MIN: 0.14,
    ACQUIRE_MAX_MOTION_STRICT: 1.85,
    /** Adquisición suave (parcial / flash desigual) */
    ACQUIRE_SOFT_MIN_RED: 28,
    ACQUIRE_SOFT_RG: 1.025,
    ACQUIRE_SOFT_RB: 1.16,
    ACQUIRE_SOFT_DOMINANCE: 8,
    ACQUIRE_SOFT_INTENSITY_MIN: 52,
    ACQUIRE_SOFT_INTENSITY_MAX: 850,
    ACQUIRE_SOFT_FINGER_SCORE_ROI: 0.18,
    ACQUIRE_SOFT_SMOOTHED_FINGER: 0.15,
    ACQUIRE_MAX_MOTION_SOFT: 1.9,
    /** Mantener contacto */
    MAINTAIN_MIN_RED: 34,
    MAINTAIN_RG: 1.03,
    MAINTAIN_RB: 1.14,
    MAINTAIN_DOMINANCE: 6.5,
    MAINTAIN_COVERAGE: 0.09,
    /** Mantener por PI cuando la firma RGB falla un frame */
    PULSE_HOLD_MIN_PI: 0.00038,
    PULSE_HOLD_MIN_RED: 34,
    PULSE_HOLD_RG: 1.03,
    PULSE_HOLD_RB: 1.1,
    PULSE_HOLD_COVERAGE: 0.095,
    PULSE_HOLD_MAX_MOTION: 1.85,
    /** Pulsación ROI (CV de rawRed) — tercera vía de adquisición */
    ROI_PULSE_BUFFER: 24,
    ROI_PULSE_MIN_SAMPLES: 12,
    /** Solo para mantener contacto ya adquirido (no adquisición inicial) */
    ROI_RED_CV_MIN: 0.036,
    PULSATILE_ACQUIRE_MIN_RED: 26,
    PULSATILE_ACQUIRE_RG: 1.02,
    PULSATILE_ACQUIRE_RB: 1.05,
    PULSATILE_ACQUIRE_COVERAGE: 0.075,
    PULSATILE_ACQUIRE_FINGER_ROI: 0.12,
    PULSATILE_ACQUIRE_MAX_MOTION: 2.1,
    PULSATILE_ACQUIRE_MIN_DOMINANCE: 4.4,
    /** Clasificación por tile (ROI 5×5) */
    TILE_MIN_RED: 28,
    TILE_MIN_TOTAL: 52,
    TILE_MIN_DOMINANCE: 4,
    TILE_MIN_RG: 1.06,
    TILE_MIN_COMBINED_SCORE: 0.26,
    TILE_DOMINANCE_SCORE_OFFSET: 5,
    MIN_FINGER_TILES_FOR_WEIGHTING: 3,
    FINGER_CONFIRM_FRAMES: 5,
    /** Tras perder firma instantánea: frames hasta degradar */
    INSTANT_LOST_TO_UNSTABLE: 2,
    INSTANT_LOST_TO_NO_CONTACT: 4,
    FINGER_LOST_FRAMES_UI: 6,
    UNSTABLE_GRACE_FRAMES: 0,
    /** softHold al perder instantáneo — solo si la firma RGB aún es válida */
    SOFT_HOLD_COVERAGE: 0.11,
    SOFT_HOLD_DOMINANCE_DELTA: 6,
    SOFT_HOLD_FINGER_SCORE: 0.14,
    SOFT_HOLD_RG: 1.04,
  },
};

export const CALIBRATION_CONFIG = {
  SPO2_REQUIRED_SAMPLES: 15,
  BP_REQUIRED_SAMPLES: 25,
  EXPIRATION_DAYS: 30,
};
