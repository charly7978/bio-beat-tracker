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
  
  // BLOOD OXYGEN (SpO2) — modelo ratio-of-ratios cámara+flash (verde como proxy IR)
  SPO2: {
    MIN_VALID: 88,
    MAX_VALID: 98,
    CRITICAL_LOW: 90,
    R_VALUE_MIN: 0.1,
    R_VALUE_MAX: 2.5,
    /** SpO2 = intercept − slope × R_mediana (calibración smartphone) */
    R_MODEL_INTERCEPT: 101,
    R_MODEL_SLOPE: 10,
    DISPLAY_CAP: 99,
    R_HISTORY_SAMPLES: 7,
    MIN_PI_PERCENT: 0.02,
    MIN_RED_DC: 10,
    MIN_GREEN_DC: 5,
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

  // BLOOD PRESSURE — rangos fisiológicos (AHA / supervivencia) + normalización morfológica PPG
  BP: {
    SYSTOLIC_MIN: 20,
    SYSTOLIC_MAX: 280,
    DIASTOLIC_MIN: 40,
    DIASTOLIC_MAX: 130,
    MAP_MIN: 50,
    MAP_MAX: 150,
    PP_MIN: 15,
    PP_MAX: 110,
    MIN_PP: 15,
    MAX_PP: 110,
    DIA_SYS_RATIO_MIN: 0.30,
    DIA_SYS_RATIO_MAX: 0.90,
    /** Fracción de PP atribuible a reflexión de onda (índice 0–1) */
    REFLECTION_PP_FRAC: 0.22,
    MIN_CYCLES: 3,
    MIN_CYCLE_QUALITY: 0.28,
    MIN_BUFFER_SAMPLES: 120,
    STABILITY_FRAMES_HIGH: 30,
    STABILITY_FRAMES_MEDIUM: 20,
    FEATURE_QUALITY_HIGH: 72,
    FEATURE_QUALITY_MEDIUM: 48,
    MIN_RR_CONFIDENCE: 0.08,
    /** Límites de forma de pulso (adimensional / ms) — no mmHg */
    FEATURE_NORM: {
      K_VALUE: [0.22, 0.58] as const,
      AREA_RATIO: [0.65, 2.5] as const,
      DECAY_LAMBDA: [0.0004, 0.006] as const,
      B_DIV_A: [-1.2, 1.4] as const,
      D_DIV_A: [-1.0, 0.85] as const,
      AGI: [-0.9, 2.2] as const,
      STIFFNESS_INDEX: [0.5, 24] as const,
      AUGMENTATION_INDEX: [3, 42] as const,
      V_MAX: [15, 120] as const,
      SUT_CYCLE_RATIO: [0.05, 0.42] as const,
      DIA_PHASE_RATIO: [0.15, 0.82] as const,
      PW50_CYCLE_RATIO: [0.1, 0.58] as const,
      DICROTIC_DEPTH: [0.05, 0.55] as const,
      RMSSD: [8, 120] as const,
    },
    WEIGHTS: {
      RESISTANCE: { k: 0.15, ipa: 0.40, decay: 0.45 },
      COMPLIANCE: { stiff: 0.10, si: 0.30, aix: 0.28, vMax: 0.02, sutRatio: 0.30 },
      REFLECTION: { dDivA: 0.30, agi: 0.20, dicroticDepth: 0.30, stiffnessIndex: 0.20 },
      FUSION: { hemodynamic: 0.52, morphology: 0.48 },
      MORPHOLOGY: {
        sbp: { sut: 0.30, stiff: 0.28, dicrotic: 0.22, aix: 0.12, hr: 0.08 },
        dbp: { pw50: 0.26, diaPhase: 0.24, decay: 0.20, dicrotic: 0.12, hrv: 0.08, ipa: 0.10 },
      },
    },
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
    /** Acuerdo Elgendi mínimo para alimentar arritmias */
    MIN_DETECTOR_AGREEMENT_ARRHYTHMIA: 0.55,
    MIN_FOR_CLINICAL: 55,
    /** PI (AC/DC) mínimo para marcar contacto STABLE — cámara suele dar 0.001–0.008 al inicio */
    MIN_PI: 0.0009,
    MAX_MOTION: 0.75,
    MAX_JITTER_MS: 55,
    /** Frames con dedo candidato antes de STABLE (≈0,53 s @ 30 fps) */
    STABLE_FRAMES_REQ: 16,
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

  /**
   * Arrhythmia / AF detection via weighted scoring over a multi-feature set.
   *
   * Sub-scores: clamp01((value - LO) / (HI - LO)) → [0,1].
   * Overall: weighted average of sub-scores.
   * Confidence: score ≥ MILD → "mild", ≥ MODERATE → "moderate", ≥ SEVERE → "severe".
   * Binary detection (callback): score ≥ DETECTION_THRESHOLD.
   */
  ARRHYTHMIA: {
    RR_WINDOW_SIZE: 10,
    MIN_INTERVALS: 9,
    MIN_SQI: 55,
    LEARNING_PERIOD_MS: 12_000,
    MIN_EVENT_INTERVAL_MS: 6000,
    OUTLIER_RATIO: 0.16,
    ABRUPT_RR_FRAC: 0.16,
    IRREGULAR_DIFF_MS: 165,

    // ── Sub-score thresholds (LO = normal ceiling, HI = strong AF floor)
    RMSSD_LO: 28,
    RMSSD_HI: 80,
    CV_LO: 0.07,
    CV_HI: 0.18,
    PNN31_LO: 0.18,
    PNN31_HI: 0.50,
    PNN325_LO: 0.14,
    PNN325_HI: 0.40,
    PNN50_LO: 0.08,
    PNN50_HI: 0.30,
    TPR_TARGET: 0.67,
    SHANNON_LO: 1.80,
    SHANNON_HI: 3.50,
    SAMPEN_LO: 0.50,
    SAMPEN_HI: 1.50,
    OUTLIER_LO: 1,
    OUTLIER_HI: 5,
    ABRUPT_LO: 1,
    ABRUPT_HI: 5,
    RRVAR_LO: 0.07,
    RRVAR_HI: 0.25,

    // ── Feature weights (must sum ≅ 1.0)
    W_RMSSD: 0.15,
    W_CV: 0.10,
    W_PNN31: 0.20,
    W_PNN325: 0.20,
    W_PNN50: 0.05,
    W_TPR: 0.05,
    W_SHANNON: 0.05,
    W_SAMPEN: 0.10,
    W_OUTLIER: 0.05,
    W_ABRUPT: 0.03,
    W_RRVAR: 0.02,

    // ── Score cutoffs
    MILD_THRESHOLD: 0.30,
    MODERATE_THRESHOLD: 0.45,
    SEVERE_THRESHOLD: 0.65,
    DETECTION_THRESHOLD: 0.45,
  },

  // FINGER + ROI (cámara trasera + dedo; hemoglobina + pulsación temporal)
  // NOTA: umbrales relajados para tolerar dedo no perfectamente centrado
  // (ROI más grande, centerBias más plano, tiles más permisivos)
  FINGER: {
    /** Fracción del lado corto del frame usada como ROI cuadrado central (0.99 = máximo dedo visible, mayor estabilidad espacial) */
    ROI_SIZE_FRACTION: 0.99,
    /** Penalización radial en tiles: menor = más tolerante si el dedo no está perfectamente centrado */
    ROI_CENTER_BIAS_MULT: 0.50,
    ROI_CENTER_BIAS_MIN: 0.50,
    /** Brillo mínimo en score de tile (total RGB medio por celda) */
    TILE_BRIGHTNESS_OFFSET: 82,
    MIN_RED_INTENSITY: 36,
    MIN_RED_DOMINANCE: 7,
    MIN_RG_RATIO: 1.04,
    MIN_COVERAGE: 0.10,
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
    MAINTAIN_MIN_RED: 28,
    MAINTAIN_RG: 1.03,
    MAINTAIN_RB: 1.10,
    MAINTAIN_DOMINANCE: 5.0,
    MAINTAIN_COVERAGE: 0.065,
    /** Mantener por PI cuando la firma RGB falla un frame */
    PULSE_HOLD_MIN_PI: 0.00030,
    PULSE_HOLD_MIN_RED: 28,
    PULSE_HOLD_RG: 1.03,
    PULSE_HOLD_RB: 1.05,
    PULSE_HOLD_COVERAGE: 0.080,
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
    /** Clasificación por tile (ROI 5×5) — umbrales relajados para tolerar dedo parcial/ladeado */
    TILE_MIN_RED: 24,
    TILE_MIN_TOTAL: 44,
    TILE_MIN_DOMINANCE: 3,
    TILE_MIN_RG: 1.04,
    TILE_MIN_COMBINED_SCORE: 0.21,
    TILE_DOMINANCE_SCORE_OFFSET: 5,
    MIN_FINGER_TILES_FOR_WEIGHTING: 2,
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
