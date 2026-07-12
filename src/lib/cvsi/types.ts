/**
 * CVSI — Cardiovascular State Inference
 *
 * Tipos del motor de razonamiento fisiológico. En vez de un gate binario
 * "hay dedo / no hay dedo", el motor mantiene una CREENCIA continua sobre el
 * estado cardiovascular latente y explica la señal con un modelo generativo del
 * pulso. La ausencia de señal cardíaca es una INFERENCIA (el modelo no puede
 * explicar la señal como un corazón), no una prohibición.
 *
 * Base científica (verificada, 2013–2026):
 *  - BeliefPPG (Bieri et al., PMLR 2023): HR como proceso estocástico con
 *    propagación de creencias e incertidumbre calibrada.
 *  - Switching (Linear) Dynamical Systems / DSLDS: régimen fisiológico como
 *    estado latente discreto que separa eventos reales de artefactos.
 *  - Modelado predictivo pulso-a-pulso (predictive coding): comprensión de la
 *    señal por error de predicción (la señal se "explica" o "sorprende").
 *  - SQI por skewness (Elgendi 2016) y firma de volumen sanguíneo multi-λ
 *    (de Haan): evidencias de perfusión real de tejido vivo.
 */

/** Régimen cardiovascular latente inferido por el motor. */
export type CardiovascularRegime =
  | 'NO_PERFUSION' // la señal no es explicable como pulso de tejido perfundido
  | 'SINUS_NORMAL' // ritmo regular en rango normal (~50–100 bpm)
  | 'TACHYCARDIA' // ritmo regular acelerado (>100 bpm)
  | 'BRADYCARDIA' // ritmo regular lento (<50 bpm)
  | 'IRREGULAR' // pulso presente pero muy irregular (fibrilación-like)
  | 'ECTOPIC' // pulso con latidos prematuros (patrón corto-largo)
  | 'MOTION'; // pulsatilidad contaminada por movimiento

export const CARDIOVASCULAR_REGIMES: readonly CardiovascularRegime[] = [
  'NO_PERFUSION',
  'SINUS_NORMAL',
  'TACHYCARDIA',
  'BRADYCARDIA',
  'IRREGULAR',
  'ECTOPIC',
  'MOTION',
] as const;

/** Distribución de probabilidad sobre los regímenes (suma ≈ 1). */
export type RegimeBelief = Record<CardiovascularRegime, number>;

/**
 * Entrada por ventana al motor. Reutiliza magnitudes que el pipeline YA calcula
 * (SQI/PI/periodicidad/RR/canales SpO2) — el motor razona sobre ellas, no las
 * recomputa.
 */
export interface CvsiInput {
  /** Ventana reciente de PPG filtrada en banda cardíaca (más nueva al final). */
  filtered: number[];
  /** Frecuencia de muestreo efectiva (Hz). */
  fs: number;
  /** Marca temporal del frame actual (ms). */
  timestampMs: number;
  /** Intervalos RR recientes (ms) del detector de picos. */
  rrIntervalsMs: number[];
  /** BPM instantáneo estimado por el pipeline (0 si no hay). */
  bpm: number;
  /** Índice de perfusión (AC/DC) del pipeline. */
  perfusionIndex?: number;
  /** Skewness de la ventana (SQI óptimo de Elgendi). */
  skewness?: number;
  /** Periodicidad por autocorrelación (0–1) del pipeline. */
  periodicity?: number;
  /** Movimiento (0–1) del IMU + señal. */
  motionScore?: number;
  /** Componentes AC/DC por canal para la firma BVP multi-longitud de onda. */
  spo2Channels?: {
    acRed: number;
    dcRed: number;
    acGreen: number;
    dcGreen: number;
  };
}

/** Diagnóstico del modelo generativo del pulso (predictive coding). */
export interface GenerativePulseDiagnostics {
  /** RMS del residuo de predicción normalizado (bajo = explicable como latido). */
  predictionError: number;
  /** Varianza de la señal explicada por el modelo de pulso (0–1). */
  explainedVariance: number;
  /** Consistencia morfológica entre ciclos y plantilla (Pearson medio, 0–1). */
  morphologyLikelihood: number;
  /** Nº de ciclos cardíacos observados en la ventana. */
  cycleCount: number;
  /** Estabilidad de la forma de pulso aprendida entre ventanas (0–1). */
  templateStability: number;
}

/** Creencia sobre la frecuencia cardíaca con incertidumbre (Kalman adaptativo). */
export interface HeartRateBelief {
  /** Estimación puntual (bpm); 0 si no hay creencia sostenida. */
  bpm: number;
  /** Desvío estándar de la creencia (bpm). */
  std: number;
  /** Límite inferior del IC ~95% (bpm). */
  low: number;
  /** Límite superior del IC ~95% (bpm). */
  high: number;
  /** true cuando la creencia convergió (baja incertidumbre sostenida). */
  converged: boolean;
}

/** Estado completo inferido por el motor en una ventana. */
export interface CvsiState {
  timestampMs: number;
  /** Distribución de creencia sobre el régimen cardiovascular. */
  regimeBelief: RegimeBelief;
  /** Régimen más probable. */
  mostLikelyRegime: CardiovascularRegime;
  /** Entropía de la creencia (0 = certeza, alto = ambigüedad). */
  regimeEntropy: number;
  /**
   * Probabilidad de que la señal represente perfusión cardiovascular real
   * = 1 − P(NO_PERFUSION). Reemplaza al gate binario "fingerDetected".
   */
  perfusionProbability: number;
  /** Creencia de frecuencia cardíaca con incertidumbre. */
  heartRate: HeartRateBelief;
  /** Diagnóstico del modelo generativo del pulso. */
  generative: GenerativePulseDiagnostics;
  /** Coherencia pulsátil multi-longitud de onda (firma BVP, 0–1). */
  bvpCoherence: number;
  /** Razonamiento en texto legible (debug + UI). */
  narrative: string;
}

/** Vector de evidencia derivado que alimenta el modelo de emisión del régimen. */
export interface RegimeEvidence {
  explainedVariance: number;
  morphologyLikelihood: number;
  predictionError: number;
  bvpCoherence: number;
  skewness: number;
  periodicity: number;
  perfusionIndex: number;
  motionScore: number;
  bpm: number;
  /** Coeficiente de variación de los RR (irregularidad del ritmo). */
  rrCv: number;
  /** Evidencia de latidos prematuros (patrón corto-largo), 0–1. */
  ectopyScore: number;
}
