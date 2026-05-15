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
  | "INSUFFICIENT_WINDOW"
  | "NO_VALID_SIGNAL";

export interface SignalQualityMetrics {
  sqi: number;           // 0..100
  perfusionIndex: number; // 0..20
  snr: number | null;
  periodicity: number | null;
  motionScore: number | null;
  saturationRatio: number;
  frameDropRatio: number;
  fpsEffective: number;
  timestampJitterMs: number;
}

export interface CalibrationInfo {
  required: boolean;
  available: boolean;
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
  torchSupported: boolean;
  torchActive: boolean;
  fpsRequested: number;
  fpsEffective: number;
  resolution: { width: number; height: number };
  exposureMode?: string;
  whiteBalanceMode?: string;
  focusMode?: string;
}
