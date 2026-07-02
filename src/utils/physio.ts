/**
 * Constantes y utilidades fisiológicas.
 * Los rangos RR provienen de VITAL_THRESHOLDS (única fuente de verdad).
 */
import { VITAL_THRESHOLDS } from '../config/vitalThresholds';

export const RR_MIN_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS;
export const RR_MAX_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS;

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

/** HRV con media RR — núcleo único reutilizado por display y detección de arritmias. */
export interface RrHrvMetrics extends HRVMetrics {
  meanRR: number;
}

/**
 * Núcleo HRV (única fuente). Asume `valid` ya filtrado a RR fisiológicos.
 * SDNN poblacional (/n), RMSSD muestral (/(n−1)) — coherente con la literatura
 * y con ambos consumidores (display y detección de arritmias).
 */
export function computeRrHrv(valid: number[]): RrHrvMetrics {
  const n = valid.length;
  if (n < 2) {
    return { meanRR: n === 1 ? valid[0] : 0, sdnn: 0, rmssd: 0, pnn50: 0, cv: 0 };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += valid[i];
  const meanRR = sum / n;

  let sqSum = 0;
  for (let i = 0; i < n; i++) sqSum += (valid[i] - meanRR) ** 2;
  const sdnn = Math.sqrt(sqSum / n);

  let sumSqDiff = 0;
  let nn50count = 0;
  for (let i = 1; i < n; i++) {
    const diff = Math.abs(valid[i] - valid[i - 1]);
    sumSqDiff += diff * diff;
    if (diff > 50) nn50count++;
  }
  const rmssd = Math.sqrt(sumSqDiff / (n - 1));
  const pnn50 = nn50count / (n - 1);
  const cv = meanRR !== 0 ? sdnn / meanRR : 0;

  return { meanRR, sdnn, rmssd, pnn50, cv };
}

export function calculateHRV(intervals: number[]): HRVMetrics {
  const valid = intervals.filter(isPhysiologicalRR);
  const { sdnn, rmssd, pnn50, cv } = computeRrHrv(valid);
  return { sdnn, rmssd, pnn50, cv };
}

// API HRV avanzada: mantiene el motor full-spectrum conectado al grafo público
// sin ejecutarlo en el hot path del monitor cardíaco en tiempo real.
export { analyzeHrvWindow, computeFullHrvReport } from '../lib/hrv/hrvEngine';
export type {
  ArtifactStats,
  FrequencyDomainHRV,
  FullHrvReport,
  HrvWindowResult,
  NonLinearHRV,
  TimeDomainHRV,
} from '../lib/hrv/hrvEngine';
