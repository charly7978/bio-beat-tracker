/**
 * Enganche de sesión solo con latidos reales (picos del ensemble).
 * Evita SpO2/BP cortados por parpadeos de contacto sin inventar BPM.
 */
export interface MeasurementSessionLatch {
  established: boolean;
  goodStreak: number;
  lastBpm: number;
  lastContactMs: number;
  lastPeakMs: number;
}

export const SESSION_LATCH = {
  /** Picos reales acumulados (no frames consecutivos) antes de alimentar SpO2/BP */
  ESTABLISH_STREAK: 3,
  CONTACT_GRACE_MS: 3500,
  /** Sin picos reales durante este tiempo, la sesión no alimenta vitales */
  MAX_PEAK_GAP_MS: 3200,
  MIN_BPM: 35,
  /** Alineado con arranque de SQI en cámara (HR puede mostrarse antes que SpO2) */
  MIN_SQI: 4,
} as const;

export function createMeasurementSessionLatch(): MeasurementSessionLatch {
  return {
    established: false,
    goodStreak: 0,
    lastBpm: 0,
    lastContactMs: 0,
    lastPeakMs: 0,
  };
}

export function updateMeasurementSessionLatch(
  latch: MeasurementSessionLatch,
  hasUsableContact: boolean,
  bpm: number,
  rawSqi: number,
  nowMs: number,
  isPeak: boolean,
): MeasurementSessionLatch {
  const peakStale =
    latch.lastPeakMs > 0 && nowMs - latch.lastPeakMs > SESSION_LATCH.MAX_PEAK_GAP_MS;

  if (!hasUsableContact) {
    return {
      ...latch,
      goodStreak: 0,
      established:
        latch.established &&
        !peakStale &&
        nowMs - latch.lastContactMs < SESSION_LATCH.CONTACT_GRACE_MS,
    };
  }

  if (peakStale) {
    return {
      established: false,
      goodStreak: 0,
      lastBpm: latch.lastBpm,
      lastContactMs: nowMs,
      lastPeakMs: latch.lastPeakMs,
    };
  }

  const nextBpm = bpm > 0 ? bpm : latch.lastBpm;
  const lastPeakMs = isPeak ? nowMs : latch.lastPeakMs;
  const peakBpm = bpm > 0 ? bpm : latch.lastBpm;

  if (isPeak && peakBpm >= SESSION_LATCH.MIN_BPM && rawSqi >= SESSION_LATCH.MIN_SQI) {
    const goodStreak = latch.goodStreak + 1;
    return {
      established: latch.established || goodStreak >= SESSION_LATCH.ESTABLISH_STREAK,
      goodStreak,
      lastBpm: nextBpm,
      lastContactMs: nowMs,
      lastPeakMs,
    };
  }

  // No decrementar goodStreak entre picos: a ~30 fps hay decenas de frames sin isPeak
  // entre latidos y el contador nunca llegaba a ESTABLISH_STREAK.
  return {
    ...latch,
    lastBpm: nextBpm,
    lastContactMs: nowMs,
    lastPeakMs,
    goodStreak: latch.goodStreak,
  };
}

export function isMeasurementPipelineLive(
  latch: MeasurementSessionLatch,
  hasUsableContact: boolean,
  rawSqi: number,
  nowMs: number,
): boolean {
  const peakRecent =
    latch.lastPeakMs > 0 &&
    nowMs - latch.lastPeakMs < SESSION_LATCH.MAX_PEAK_GAP_MS;

  if (hasUsableContact) {
    return latch.established && peakRecent && rawSqi >= 2;
  }
  if (!latch.established) return false;
  return (
    nowMs - latch.lastContactMs < SESSION_LATCH.CONTACT_GRACE_MS &&
    peakRecent &&
    rawSqi >= 2
  );
}
