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
  
  // FINGER DETECTION (Hemoglobin Signature)
  FINGER: {
    MIN_RED_INTENSITY: 40,
    MIN_RED_DOMINANCE: 8,
    MIN_RG_RATIO: 1.05,
    /** ROI central: dedo pequeño o mal centrado suele dar cobertura bajo 20 % aun con señal usable */
    MIN_COVERAGE: 0.16,
  }
};

export const CALIBRATION_CONFIG = {
  SPO2_REQUIRED_SAMPLES: 15,
  BP_REQUIRED_SAMPLES: 25,
  EXPIRATION_DAYS: 30,
};
