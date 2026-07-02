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

  // Fase 0-2%: descanso en línea base (cero)
  // Fase 2-6%: ascenso vertical rápido hasta el pico máximo (4% del ciclo)
  // Fase 6-8%: descenso instantáneo y abrupto (latigazo) por debajo de la línea base hasta el pico negativo
  // Fase 8-20%: ascenso de vuelta a la línea base
  // Fase 20-100%: descanso en línea base

  const riseStart = 0.02;
  const riseEnd = 0.06;
  const crashEnd = 0.08;
  const recoveryEnd = 0.20;

  let template = 0;
  if (phase < riseStart) {
    template = 0;
  } else if (phase < riseEnd) {
    const t = (phase - riseStart) / (riseEnd - riseStart);
    template = t * 1.5;
  } else if (phase < crashEnd) {
    const t = (phase - riseEnd) / (crashEnd - riseEnd);
    template = 1.5 - t * 2.5;
  } else if (phase < recoveryEnd) {
    const t = (phase - crashEnd) / (recoveryEnd - crashEnd);
    template = -1.0 + t * 1.0;
  } else {
    template = 0;
  }

  const base = template * envelope * (0.85 + 0.15 * rrWeight);

  if (isPeak) {
    return base + cleanSignal * 0.05 * (1 - qualityWeight);
  }

  return base;
}
