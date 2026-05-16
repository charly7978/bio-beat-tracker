/**
 * CONTRATO BIOMÉDICO GLOBAL DE RESULTADOS (v1.0)
 * 
 * Este contrato asegura que todas las mediciones producidas por el sistema
 * tengan metadatos de calidad, confianza y estado de adquisición.
 */

export type MeasurementStatus =
  | "VALID"
  | "WARMUP"
  | "LOW_SIGNAL_QUALITY"
  | "NO_FINGER"
  | "MOTION_ARTIFACT"
  | "SATURATED"
  | "UNDEREXPOSED"
  | "LOW_FPS"
  | "TORCH_UNAVAILABLE"
  | "REQUIRES_CALIBRATION"
  | "CALIBRATION_EXPIRED"
  | "INSUFFICIENT_WINDOW"
  | "NO_VALID_SIGNAL"
  | "ERROR";

export interface SignalQualityMetrics {
  sqi: number;           // 0..100
  perfusionIndex: number; // 0..20
  snr: number | null;
  periodicity: number | null;
  motionScore: number | null;
  saturationRatio: number;
  /** Fracción de frames con canal muy oscuro (subexposición) */
  underexposureRatio?: number;
  frameDropRatio: number;
  fpsEffective: number;
  timestampJitterMs: number;
  /** Confianza interna del detector Elgendi (0–1), si disponible */
  elgendiConfidence?: number | null;
  /** Confianza interna del detector Pan–Tompkins PPG (0–1) */
  panTompkinsConfidence?: number | null;
  /** Acuerdo entre detectores de picos (0–1) */
  detectorAgreement?: number | null;
}

export interface CalibrationInfo {
  required: boolean;
  available: boolean;
  expired?: boolean;
  profileId?: string;
  lastCalibrationAt?: number;
  expiresAt?: number;
  method?: string;
}

export interface VitalMeasurement<T> {
  name: string;
  value: T | null;
  unit: string;
  timestamp: number;
  confidence: number; // 0..1
  status: MeasurementStatus;
  reason: string;
  signalQuality: SignalQualityMetrics;
  diagnostics: Record<string, unknown>;
  calibration?: CalibrationInfo;
}

export interface DeviceCapabilityReport {
  browser: string;
  userAgent: string;
  supportedConstraints: string[];
  capabilities: MediaTrackCapabilities;
  settings: MediaTrackSettings;
  appliedConstraints?: MediaTrackConstraints;
  torchSupported: boolean;
  torchActive: boolean;
  torchApplyVerified?: boolean;
  fpsRequested: number;
  fpsEffective: number;
  fpsMeasured?: number;
  resolution: { width: number; height: number };
  exposureMode?: string;
  whiteBalanceMode?: string;
  focusMode?: string;
}

/** Resultado fusionado del ensemble de picos PPG (auditable). */
export interface PeakDetectionResult {
  peaks: number[];
  peakTimes: number[];
  /** Origen de cada pico fusionado (alineado con peakTimes). */
  peakSources?: Array<'dual' | 'solo_elgendi'>;
  rrIntervalsMs: number[];
  bpmInstant: number | null;
  bpmStable: number | null;
  confidence: number;
  agreement: {
    elgendi: number;
    panTompkins: number;
    spectral: number;
    autocorrelation: number;
  };
  rejectedPeaks: Array<{
    index: number;
    reason: string;
    detector: string;
  }>;
  diagnostics: Record<string, unknown>;
}
