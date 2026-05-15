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
    MIN_PI: 0.002,
    MAX_MOTION: 0.6,
    MAX_JITTER_MS: 50,
    STABLE_FRAMES_REQ: 30,
  },
  
  // FINGER DETECTION (Hemoglobin Signature)
  FINGER: {
    MIN_RED_INTENSITY: 40,
    MIN_RED_DOMINANCE: 8,
    MIN_RG_RATIO: 1.05,
    MIN_COVERAGE: 0.20,
  }
};

export const CALIBRATION_CONFIG = {
  SPO2_REQUIRED_SAMPLES: 15,
  BP_REQUIRED_SAMPLES: 25,
  EXPIRATION_DAYS: 30,
};
