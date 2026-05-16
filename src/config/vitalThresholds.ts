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
  
  // BLOOD PRESSURE (mmHg)
  BP: {
    SYSTOLIC_MIN: 75,
    SYSTOLIC_MAX: 250,
    DIASTOLIC_MIN: 35,
    DIASTOLIC_MAX: 150,
    MIN_PP: 18, // Pulse Pressure mínima
    MAX_PP: 110, // Pulse Pressure máxima
  },
  
  // SIGNAL QUALITY (SQI)
  QUALITY: {
    MIN_FOR_HR: 15,
    MIN_FOR_CLINICAL: 55,
    /** PI (AC/DC) mínimo para marcar contacto STABLE — cámara suele dar 0.001–0.008 al inicio */
    MIN_PI: 0.0012,
    MAX_MOTION: 0.6,
    MAX_JITTER_MS: 50,
    /** Frames con dedo candidato antes de STABLE (≈1 s @ 30 fps) */
    STABLE_FRAMES_REQ: 22,
  },
  
  // FINGER + ROI (cámara trasera + dedo; hemoglobina + pulsación temporal)
  FINGER: {
    MIN_RED_INTENSITY: 40,
    MIN_RED_DOMINANCE: 8,
    MIN_RG_RATIO: 1.05,
    MIN_COVERAGE: 0.14,
    SOFT_COVERAGE_MULT: 0.88,
    /** Adquisición estricta */
    ACQUIRE_RB_STRICT: 1.2,
    ACQUIRE_INTENSITY_MIN: 68,
    ACQUIRE_INTENSITY_MAX: 780,
    ACQUIRE_SMOOTHED_FINGER_MIN: 0.17,
    ACQUIRE_MAX_MOTION_STRICT: 1.75,
    /** Adquisición suave (parcial / flash desigual) */
    ACQUIRE_SOFT_MIN_RED: 31,
    ACQUIRE_SOFT_RG: 1.03,
    ACQUIRE_SOFT_RB: 1.12,
    ACQUIRE_SOFT_DOMINANCE: 5.2,
    ACQUIRE_SOFT_INTENSITY_MIN: 58,
    ACQUIRE_SOFT_INTENSITY_MAX: 830,
    ACQUIRE_SOFT_FINGER_SCORE_ROI: 0.18,
    ACQUIRE_SOFT_SMOOTHED_FINGER: 0.125,
    ACQUIRE_MAX_MOTION_SOFT: 1.9,
    /** Mantener contacto */
    MAINTAIN_MIN_RED: 38,
    MAINTAIN_RG: 1.04,
    MAINTAIN_RB: 1.16,
    MAINTAIN_DOMINANCE: 7.5,
    MAINTAIN_COVERAGE: 0.11,
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
    ROI_RED_CV_MIN: 0.026,
    PULSATILE_ACQUIRE_MIN_RED: 28,
    PULSATILE_ACQUIRE_RG: 1.025,
    PULSATILE_ACQUIRE_RB: 1.06,
    PULSATILE_ACQUIRE_COVERAGE: 0.09,
    PULSATILE_ACQUIRE_FINGER_ROI: 0.14,
    PULSATILE_ACQUIRE_MAX_MOTION: 2.1,
    PULSATILE_ACQUIRE_MIN_DOMINANCE: 4.4,
    /** Clasificación por tile (ROI 5×5) */
    TILE_MIN_RED: 32,
    TILE_MIN_TOTAL: 62,
    TILE_MIN_DOMINANCE: 5,
    TILE_MIN_RG: 1.03,
    TILE_MIN_COMBINED_SCORE: 0.26,
    MIN_FINGER_TILES_FOR_WEIGHTING: 4,
    /** softHold al perder instantáneo */
    SOFT_HOLD_COVERAGE: 0.12,
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
