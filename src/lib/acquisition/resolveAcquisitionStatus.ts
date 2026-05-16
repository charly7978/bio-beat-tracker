import type { MeasurementStatus } from '@/types/measurements';
import type { ContactState } from '@/types/signal';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

export interface AcquisitionStatusInput {
  contactState: ContactState;
  fingerDetected: boolean;
  coverageRatio: number;
  perfusionIndex: number;
  motionScore: number;
  saturationRatio: number;
  underexposureRatio: number;
  fpsEffective: number;
  frameDropRatio: number;
  timestampJitterMs: number;
  torchActive?: boolean;
  torchSupported?: boolean;
}

/**
 * Estado técnico de adquisición (una sola función — no duplicar en UI/processors).
 */
export function resolveAcquisitionStatus(input: AcquisitionStatusInput): MeasurementStatus {
  const F = VITAL_THRESHOLDS.FINGER;
  const Q = VITAL_THRESHOLDS.QUALITY;

  if (input.torchSupported === false) return 'TORCH_UNAVAILABLE';
  if (input.torchSupported && input.torchActive === false) return 'TORCH_UNAVAILABLE';

  if (!input.fingerDetected || input.contactState === 'NO_CONTACT') {
    return 'NO_FINGER';
  }

  if (input.saturationRatio > 0.75) return 'SATURATED';
  if ((input.underexposureRatio ?? 0) > 0.82) return 'UNDEREXPOSED';
  if (input.motionScore > Q.MAX_MOTION) return 'MOTION_ARTIFACT';
  if (input.fpsEffective > 0 && input.fpsEffective < 20) return 'LOW_FPS';
  if (input.timestampJitterMs > Q.MAX_JITTER_MS) return 'LOW_FPS';

  if (input.perfusionIndex > 0 && input.perfusionIndex < Q.MIN_PI * 0.35) {
    return 'LOW_SIGNAL_QUALITY';
  }

  if (input.coverageRatio < F.MIN_COVERAGE * 0.7) {
    return 'LOW_SIGNAL_QUALITY';
  }

  if (input.coverageRatio > 0.55 && input.perfusionIndex < Q.MIN_PI * 0.5) {
    return 'LOW_SIGNAL_QUALITY';
  }

  if (input.frameDropRatio > 0.25) return 'LOW_FPS';

  return input.contactState === 'STABLE_CONTACT' ? 'VALID' : 'WARMUP';
}
