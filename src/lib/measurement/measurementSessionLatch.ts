/**
 * Mantiene la medición viva aunque BPM/confianza fluctúen unos frames.
 * Evita que SpO2/BP dejen de acumularse por parpadeos de gates.
 */
export interface MeasurementSessionLatch {
  established: boolean;
  goodStreak: number;
  lastBpm: number;
  lastContactMs: number;
}

export const SESSION_LATCH = {
  /** Frames con buena señal para “enganchar” sesión (~0,3 s a 30 Hz efectivos) */
  ESTABLISH_STREAK: 8,
  /** Tras perder contacto, seguir pipeline este tiempo (ms) */
  CONTACT_GRACE_MS: 4000,
  /** BPM mínimo para considerar latido presente */
  MIN_BPM: 32,
  /** SQI mínimo para avanzar streak */
  MIN_SQI: 3,
} as const;

export function createMeasurementSessionLatch(): MeasurementSessionLatch {
  return { established: false, goodStreak: 0, lastBpm: 0, lastContactMs: 0 };
}

export function updateMeasurementSessionLatch(
  latch: MeasurementSessionLatch,
  hasUsableContact: boolean,
  bpm: number,
  rawSqi: number,
  nowMs: number,
): MeasurementSessionLatch {
  if (!hasUsableContact) {
    return {
      ...latch,
      goodStreak: 0,
      established:
        latch.established && nowMs - latch.lastContactMs < SESSION_LATCH.CONTACT_GRACE_MS,
    };
  }

  const bpmOk = bpm >= SESSION_LATCH.MIN_BPM || latch.lastBpm >= SESSION_LATCH.MIN_BPM;
  const nextBpm = bpm > 0 ? bpm : latch.lastBpm;

  if (bpmOk && rawSqi >= SESSION_LATCH.MIN_SQI) {
    const goodStreak = latch.goodStreak + 1;
    return {
      established: latch.established || goodStreak >= SESSION_LATCH.ESTABLISH_STREAK,
      goodStreak,
      lastBpm: nextBpm,
      lastContactMs: nowMs,
    };
  }

  return {
    ...latch,
    lastBpm: nextBpm,
    lastContactMs: nowMs,
  };
}

export function isMeasurementPipelineLive(
  latch: MeasurementSessionLatch,
  hasUsableContact: boolean,
  rawSqi: number,
  nowMs: number,
): boolean {
  if (hasUsableContact) return latch.established || latch.lastBpm >= SESSION_LATCH.MIN_BPM;
  if (!latch.established) return false;
  return nowMs - latch.lastContactMs < SESSION_LATCH.CONTACT_GRACE_MS && rawSqi >= 2;
}
