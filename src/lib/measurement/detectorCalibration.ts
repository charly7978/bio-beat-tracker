/**
 * Calibración adaptativa Elgendi + Pan–Tompkins por ventana de señal.
 * Escala umbrales desde dinámica PPG, SQI, PI y BPM espectral — sin valores fijos en mmHg.
 */
import { PEAK_DETECTION_DEFAULTS } from '@/config/signalProcessing';
import { clamp } from '@/utils/math';
import { bpmFromAutocorr } from '@/modules/signal-processing/shared/dsp';

export interface DetectorCalibration {
  elgendiMinProminence: number;
  elgendiOffsetWeight: number;
  panThresholdFactor: number;
  panSearchbackFactor: number;
  fusionToleranceMs: number;
  soloElgendiMinConf: number;
  soloPanMinConf: number;
  estimatedBpm: number | null;
  spectralScore: number;
  signalDynamicRange: number;
}

function robustDynamicRange(signal: number[]): number {
  if (signal.length < 8) return 0;
  const sorted = [...signal].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  return Math.max(0.008, p90 - p10);
}

/** Calibra detectores para la ventana actual. */
export function computeDetectorCalibration(
  signal: number[],
  samplingRateHz: number,
  sqi?: number,
  perfusionIndex?: number,
): DetectorCalibration {
  const cfg = PEAK_DETECTION_DEFAULTS;
  const cal = cfg.CALIBRATION;
  const dyn = robustDynamicRange(signal);

  const promScale = clamp(
    dyn / cal.TARGET_DYNAMIC_RANGE,
    cal.PROMINENCE_SCALE_MIN,
    cal.PROMINENCE_SCALE_MAX,
  );
  const elgendiMinProminence = cfg.minProminence * promScale;

  const sqiNorm =
    typeof sqi === 'number' && sqi > 0
      ? clamp(sqi / cal.SQI_REFERENCE, 0.55, 1.25)
      : 1;
  const piNorm =
    typeof perfusionIndex === 'number' && perfusionIndex > 0
      ? clamp(perfusionIndex / cal.TARGET_PI, 0.65, 1.2)
      : 1;

  const qualityBlend = (sqiNorm + piNorm) / 2;
  const elgendiOffsetWeight = clamp(
    cfg.offsetWeight * (1.08 - qualityBlend * 0.12) * (piNorm < 0.8 ? 0.92 : 1),
    cal.OFFSET_WEIGHT_MIN,
    cal.OFFSET_WEIGHT_MAX,
  );

  const panThresholdFactor = clamp(
    cal.PAN_THRESHOLD_BASE *
      (0.9 + (1 - qualityBlend) * 0.14) *
      (promScale < 0.8 ? 0.9 : 1),
    cal.PAN_THRESHOLD_MIN,
    cal.PAN_THRESHOLD_MAX,
  );

  const spec = bpmFromAutocorr(signal, samplingRateHz);
  const estimatedBpm = spec.bpm > 0 ? spec.bpm : null;
  const rrMs =
    estimatedBpm != null && estimatedBpm >= cfg.minBpm && estimatedBpm <= cfg.maxBpm
      ? 60000 / estimatedBpm
      : 60000 / 72;

  const fusionToleranceMs = clamp(
    rrMs * cal.FUSION_TOLERANCE_RR_FRAC,
    cal.FUSION_TOLERANCE_MS_MIN,
    cal.FUSION_TOLERANCE_MS_MAX,
  );

  const soloElgendiMinConf = clamp(
    cal.SOLO_ELGENDI_BASE + (1 - qualityBlend) * 0.03 - (spec.score > 0.35 ? 0.02 : 0),
    cal.SOLO_ELGENDI_MIN,
    cal.SOLO_ELGENDI_MAX,
  );

  const soloPanMinConf = clamp(
    cal.SOLO_PAN_BASE + (1 - qualityBlend) * 0.04 - (spec.score > 0.4 ? 0.025 : 0),
    cal.SOLO_PAN_MIN,
    cal.SOLO_PAN_MAX,
  );

  return {
    elgendiMinProminence,
    elgendiOffsetWeight,
    panThresholdFactor,
    panSearchbackFactor: panThresholdFactor * cal.PAN_SEARCHBACK_RELAXED_FRAC,
    fusionToleranceMs,
    soloElgendiMinConf,
    soloPanMinConf,
    estimatedBpm,
    spectralScore: spec.score,
    signalDynamicRange: dyn,
  };
}
