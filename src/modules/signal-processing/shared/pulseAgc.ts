/**
 * AGC conservador para PPG: refuerza pulsos débiles periódicos sin inflar ruido amplio.
 * Inspirado en normalización robusta + gating por periodicidad (Elgendi / rPPG).
 */
import { clamp } from '../../../utils/math';

export interface PulseAgcState {
  scale: number;
  tail: number[];
  maxTail: number;
}

export interface PulseAgcConfig {
  targetPeak: number;
  minScale: number;
  maxScale: number;
  minRobustRange: number;
  tailSize: number;
}

export const DEFAULT_PULSE_AGC: PulseAgcConfig = {
  targetPeak: 22,
  minScale: 1.2,
  maxScale: 12,
  minRobustRange: 0.06,
  tailSize: 96,
};

export function createPulseAgcState(cfg: PulseAgcConfig = DEFAULT_PULSE_AGC): PulseAgcState {
  return { scale: 1, tail: [], maxTail: cfg.tailSize };
}

function robustRange(samples: number[]): number {
  if (samples.length < 12) return 0;
  const sorted = [...samples].map((v) => Math.abs(v)).sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  return Math.max(0, p90 - p10);
}

/**
 * @param filtered muestra tras bandpass
 * @param periodicity 0–1 (autocorrelación / SQI periódico)
 * @param motionScore 0–1 (mayor = más movimiento)
 */
export function applyPulseAgc(
  state: PulseAgcState,
  filtered: number,
  periodicity: number,
  motionScore: number,
  cfg: PulseAgcConfig = DEFAULT_PULSE_AGC,
): number {
  if (!Number.isFinite(filtered)) return 0;

  state.tail.push(filtered);
  if (state.tail.length > cfg.tailSize) {
    state.tail.splice(0, state.tail.length - cfg.tailSize);
  }

  if (state.tail.length < 24) {
    return clamp(filtered * state.scale, -cfg.targetPeak * cfg.maxScale, cfg.targetPeak * cfg.maxScale);
  }

  const rr = robustRange(state.tail);
  const periodGate = clamp((periodicity - 0.12) / 0.5, 0, 1);
  const motionGate = clamp(1 - motionScore * 1.15, 0.25, 1);
  const rangeGate = clamp(rr / cfg.minRobustRange, 0, 1);

  const desired =
    rr >= cfg.minRobustRange * 0.35
      ? clamp((cfg.targetPeak / Math.max(rr * 0.55, cfg.minRobustRange * 0.4)) * periodGate * motionGate, cfg.minScale, cfg.maxScale)
      : cfg.minScale;

  state.scale = state.scale * 0.78 + desired * 0.22;

  const out = filtered * state.scale;
  const cap = cfg.targetPeak * cfg.maxScale;
  return clamp(out, -cap, cap);
}

export function resetPulseAgc(state: PulseAgcState): void {
  state.scale = 1;
  state.tail.length = 0;
}
