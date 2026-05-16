/**
 * Configuración centralizada de DSP y detección de picos PPG.
 * Los límites fisiológicos se reutilizan desde `vitalThresholds` (una sola fuente).
 */
import { VITAL_THRESHOLDS } from './vitalThresholds';

export const PEAK_DETECTION_DEFAULTS = {
  minBpm: VITAL_THRESHOLDS.HR.MIN,
  maxBpm: VITAL_THRESHOLDS.HR.MAX,
  minPeakDistanceMs: VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS,
  maxPeakDistanceMs: VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS,
  /** Ventana corta tipo Elgendi (~111 ms @ fs nominal) */
  peakWindowMs: 111,
  /** Ventana larga tipo Elgendi (~667 ms) */
  beatWindowMs: 667,
  /** Prominencia mínima (Elgendi): baja para latidos débiles en cámara móvil */
  minProminence: 0.019,
  /** Peso del offset adaptativo MA_beat (menor = bloques de interés más sensibles) */
  offsetWeight: 0.24,
  /** Factor mínimo del RR fisiológico entre emisiones de pico (anti-doble latido) */
  peakEmitRefractoryFactor: 0.72,
  /** Ventana de coincidencia Elgendi ↔ Pan–Tompkins (ms) */
  fusionToleranceMs: 280,
  minSQI: 10,
  /** Ventana para emitir pico respecto al frame actual (ms) */
  /** Debe cubrir ~½ RR a 45 BPM; 380 ms perdía latidos entre frames */
  peakEmitWindowMs: 680,
  /** Acuerdo espectral mínimo antes de penalizar BPM instantáneo */
  spectralAgreementMin: 0.28,
  /** Mínimo de muestras en ventana para correr ensemble */
  minSamplesEnsemble: 72,
  /** Integración Pan–Tompkins PPG (~180 ms de pulso sistólico típico a 30 Hz) */
  integrationWindowMs: 180,
  /** Refractario máximo derivado de maxBpm */
  refractoryMsFromMaxBpm: 60000 / VITAL_THRESHOLDS.HR.MAX,
} as const;

export const RESPIRATION_DEFAULTS = {
  /** Banda respiratoria típica 8–30 rpm → 0.13–0.5 Hz */
  minRpm: 6,
  maxRpm: 40,
  minStableFrames: 90,
  minBuffer: 240,
} as const;
