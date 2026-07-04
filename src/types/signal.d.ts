export type ContactState = 'NO_CONTACT' | 'UNSTABLE_CONTACT' | 'STABLE_CONTACT';

export type FingerPlacementMode = 'tip' | 'pad' | 'hybrid';

export interface ProcessedSignal {
  timestamp: number;
  rawValue: number;
  filteredValue: number;
  /** Señal verde suavizada para morfología PA (menos AGC que HR) */
  morphologyValue?: number;
  /** Canal 3 del banco de filtros: morfología con Bessel de fase lineal (preserva fiduciales) */
  morphologyFiltered?: number;
  /** Canal 4 del banco de filtros: señal de modulación lenta para estimación de FR */
  respirationFiltered?: number;
  /** Canal 5 del banco de filtros: señal limpia para detección de intervalos RR / arritmias */
  arrhythmiaFiltered?: number;
  /** Canal 2 del banco de filtros: componentes AC y DC separados por canal para ratio SpO2 */
  spo2Channels?: {
    acRed: number;
    dcRed: number;
    acGreen: number;
    dcGreen: number;
    acBlue?: number;
    dcBlue?: number;
  };
  placementMode?: FingerPlacementMode;
  quality: number;
  fingerDetected: boolean;
  contactState: ContactState;
  motionArtifact?: boolean;
  roi: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  perfusionIndex?: number;
  rawRed?: number;
  rawGreen?: number;
  rawBlue?: number;
  /**
   * Respiración derivada del acelerómetro (IMU), modalidad NO-óptica que se
   * fusiona con las ópticas (RIAV/RIIV/RIFV) en la Smart Fusion respiratoria.
   * Pre-estimada en el procesador porque vive con el listener DeviceMotion.
   */
  accelRespiration?: { rpm: number; quality: number };
  diagnostics?: {
    message: string;
    hasPulsatility: boolean;
    pulsatilityValue: number;
    /** Cobertura del ROI por tiles “dedo” (0–1) */
    coverageRatio?: number;
    placementMode?: FingerPlacementMode;
    placementHint?: string;
    fingerPressure?: 'LIGHT' | 'IDEAL' | 'HEAVY';
    status?: import('./measurements').MeasurementStatus;
    sqm?: Partial<import('./measurements').SignalQualityMetrics>;
    /** Estado de la estabilización de adquisición (fase inicial de colocación). */
    acquisitionStage?: import('../lib/acquisition/AcquisitionStabilizer').AcquisitionStage;
    /** Confianza de adquisición suavizada [0..1]. */
    acquisitionConfidence?: number;
    /** Progreso monótono de estabilización [0..1] para la UI. */
    acquisitionProgress?: number;
    /** Cobertura buena [0..1] del buffer elástico de colocación (tolerante a
     * microdescuadres). Solo UX de colocación; no gatea detección ni pulso. */
    placementCoverage?: number;
    /** La colocación se sostiene estable según el buffer elástico. */
    placementStable?: boolean;
    /**
     * Puntaje de contacto universal [0..1] (rojo profundo y uniforme sobre la
     * lente). Alimenta el medidor de proximidad "caliente/frío" de la guía de
     * colocación. Independiente de la firma de color estricta.
     */
    contactScore?: number;
    /** Hint de colocación accionable (dirección/presión) derivado del contacto. */
    contactHint?: import('../lib/finger/fingerContactScore').ContactHintKind;
    /** Sesgo de cobertura [-1..1]: dirección para centrar el dedo. */
    coverageBiasX?: number;
    coverageBiasY?: number;
  };
}

export interface ProcessingError {
  code: string;
  message: string;
  timestamp: number;
}

export interface SignalProcessor {
  initialize: () => Promise<void>;
  start: () => void;
  stop: () => void;
  calibrate: () => Promise<boolean>;
  onSignalReady?: (signal: ProcessedSignal) => void;
  onError?: (error: ProcessingError) => void;
}
