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

  // Fase 0-3%: descanso en línea base (cero)
  // Fase 3-10%: ascenso vertical hasta el pico máximo
  // Fase 10-12%: meseta breve en el pico (para que el detector de máximos locales lo capture)
  // Fase 12-14%: descenso instantáneo y abrupto (latigazo) por debajo de la línea base
  // Fase 14-28%: retorno gradual a la línea base
  // Fase 28-100%: descanso en línea base

  const riseStart = 0.03;
  const riseEnd = 0.10;
  const plateauEnd = 0.12;
  const crashEnd = 0.14;
  const recoveryEnd = 0.28;

  let template = 0;
  if (phase < riseStart) {
    template = 0;
  } else if (phase < riseEnd) {
    const t = (phase - riseStart) / (riseEnd - riseStart);
    template = t * 2.0;
  } else if (phase < plateauEnd) {
    template = 2.0;
  } else if (phase < crashEnd) {
    const t = (phase - plateauEnd) / (crashEnd - plateauEnd);
    template = 2.0 - t * 3.0;
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
