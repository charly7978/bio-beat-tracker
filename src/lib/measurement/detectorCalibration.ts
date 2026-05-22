/**
 * Calibración adaptativa Elgendi por ventana de señal.
 * Escala umbrales desde dinámica PPG, SQI y PI — sin valores fijos en mmHg.
 */
import { PEAK_DETECTION_DEFAULTS } from '@/config/signalProcessing';
import { clamp } from '@/utils/math';
import { robustDynamicRange } from '@/utils/stats';

export interface DetectorCalibration {
  elgendiMinProminence: number;
  elgendiOffsetWeight: number;
  signalDynamicRange: number;
}

/** Calibra detector Elgendi para la ventana actual. */
export function computeDetectorCalibration(
  signal: number[],
  _samplingRateHz: number,
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

  return {
    elgendiMinProminence,
    elgendiOffsetWeight,
    signalDynamicRange: dyn,
  };
}
