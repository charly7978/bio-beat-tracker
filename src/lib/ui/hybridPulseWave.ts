export interface HybridPulseSampleInput {
  realValue: number;
  quality: number;
  isPeak: boolean;
  rrMs: number;
  elapsedSinceLastPeakMs: number;
  hasUsableContact: boolean;
}

export function buildHybridPulseSample(input: HybridPulseSampleInput): number {
  const {
    realValue,
    quality,
    isPeak,
    rrMs,
    elapsedSinceLastPeakMs,
    hasUsableContact,
  } = input;

  if (!hasUsableContact) return 0;

  const cleanSignal = Math.abs(realValue);
  const qualityWeight = Math.min(1, Math.max(0, quality / 100));
  const rrWeight = rrMs > 0 ? Math.min(1, Math.max(0.2, 800 / rrMs)) : 0.2;
  const phase = Math.min(1, Math.max(0, elapsedSinceLastPeakMs / Math.max(1, rrMs)));

  const envelope = 0.35 + cleanSignal * 0.55 * qualityWeight;

  const rise = phase < 0.12
    ? phase / 0.12
    : 1 - ((phase - 0.12) / 0.08) * 0.2;

  const systolicPeak = Math.exp(-Math.pow((phase - 0.16) / 0.06, 2));
  const dicroticNotch = Math.exp(-Math.pow((phase - 0.42) / 0.045, 2)) * 0.18;
  const diastolicTail = Math.exp(-phase * 3) * 0.18;
  const recovery = phase > 0.6 ? (1 - phase) * 0.2 : 0;

  let template = rise * 0.32 + systolicPeak * 0.9 - dicroticNotch - diastolicTail + recovery;

  if (phase > 0.2 && phase < 0.45) {
    template *= 0.85;
  }

  const base = template * envelope * (0.85 + 0.15 * rrWeight);

  if (isPeak) {
    return base + 0.2 + cleanSignal * 0.05 * (1 - qualityWeight);
  }

  return base;
}
