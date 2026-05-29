export type ContactState = 'NO_CONTACT' | 'UNSTABLE_CONTACT' | 'STABLE_CONTACT';

export type FingerPlacementMode = 'tip' | 'pad' | 'hybrid';

export interface ProcessedSignal {
  timestamp: number;
  rawValue: number;
  filteredValue: number;
  /** Señal verde suavizada para morfología PA (menos AGC que HR) */
  morphologyValue?: number;
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
  diagnostics?: {
    message: string;
    hasPulsatility: boolean;
    pulsatilityValue: number;
    /** Cobertura del ROI por tiles “dedo” (0–1) */
    coverageRatio?: number;
    placementMode?: FingerPlacementMode;
    placementHint?: string;
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
