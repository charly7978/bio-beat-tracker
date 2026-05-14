/**
 * Constantes y utilidades fisiológicas centralizadas.
 * Única fuente de verdad para rangos RR, cálculos HRV, umbrales y helpers temporales.
 */

// Rango fisiológico único para intervalos RR (ms)
export const RR_MIN_MS = 270;
export const RR_MAX_MS = 2200;

/** Timestamp monotónico de alta resolución (sin riesgo de saltos de reloj). */
export const getMonotonicNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

export function isPhysiologicalRR(ms: number): boolean {
  return ms >= RR_MIN_MS && ms <= RR_MAX_MS;
}

// Cálculos HRV (SDNN, RMSSD, pNN50, CV)
export interface HRVMetrics {
  sdnn: number;
  rmssd: number;
  pnn50: number;
  cv: number;
}

export function calculateHRV(intervals: number[]): HRVMetrics {
  const valid = intervals.filter(isPhysiologicalRR);
  if (valid.length < 2) {
    return { sdnn: 0, rmssd: 0, pnn50: 0, cv: 0 };
  }

  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((sum, i) => sum + Math.pow(i - mean, 2), 0) / valid.length;
  const sdnn = Math.sqrt(variance);

  let sumSqDiff = 0;
  let nn50count = 0;
  for (let i = 1; i < valid.length; i++) {
    const diff = Math.abs(valid[i] - valid[i - 1]);
    sumSqDiff += diff * diff;
    if (diff > 50) nn50count++;
  }
  const rmssd = Math.sqrt(sumSqDiff / (valid.length - 1));
  const pnn50 = nn50count / (valid.length - 1);
  const cv = mean !== 0 ? sdnn / mean : 0;

  return { sdnn, rmssd, pnn50, cv };
}
