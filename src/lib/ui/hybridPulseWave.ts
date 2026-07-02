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

  const realContribution = cleanSignal * qualityWeight * 0.75;
  const templateContribution = Math.max(0, Math.sin((elapsedSinceLastPeakMs / Math.max(1, rrMs)) * Math.PI * 2));

  const base = realContribution + templateContribution * (1 - qualityWeight) * 0.4;

  if (isPeak) {
    return base + 0.6 * (1 - Math.min(1, qualityWeight));
  }

  return base * (0.85 + 0.15 * rrWeight);
}
