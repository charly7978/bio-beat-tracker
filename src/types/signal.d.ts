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
  /**
   * Evidencia de que hay hemoglobina pulsando en el camino óptico.
   *
   * Es la ÚNICA fuente de verdad sobre si hay algo que medir, y viaja en la
   * señal para que todos los consumidores compartan el mismo reloj. Antes cada
   * capa decidía por su cuenta —el router con `fingerConfirmed`, la presión con
   * un contador de frames propio, la saturación sin criterio alguno— y por eso
   * podían contradecirse: al retirar el dedo la pantalla mostraba tres valores
   * de tres instantes distintos.
   *
   * `state` responde si hay sangre; `logOdds` es la evidencia acumulada, y su
   * signo y magnitud sirven de confianza sin necesidad de inventar una escala.
   */
  perfusion?: {
    state: 'PERFUSED' | 'NOT_PERFUSED' | 'UNDECIDED';
    logOdds: number;
    /** Ángulo con el eje acromático, en grados. Diagnóstico. */
    chromaticAngleDeg: number;
    /** Por qué el detector no pudo decidir, cuando aplica. */
    reason: string;
  };
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
