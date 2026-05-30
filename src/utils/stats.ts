/**
 * Estadística robusta compartida (mediana, percentiles).
 */
import { clamp } from './math';

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function robustBounds(
  values: number[],
  lowQ = 0.1,
  highQ = 0.9,
): { low: number; high: number; range: number } {
  if (values.length === 0) return { low: 0, high: 0, range: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const lowIdx = clamp(Math.floor((sorted.length - 1) * lowQ), 0, sorted.length - 1);
  const highIdx = clamp(Math.floor((sorted.length - 1) * highQ), 0, sorted.length - 1);
  const low = sorted[lowIdx] ?? 0;
  const high = sorted[highIdx] ?? 0;
  return { low, high, range: Math.max(0, high - low) };
}

export function robustDynamicRange(values: number[], lowQ = 0.1, highQ = 0.9): number {
  const { range } = robustBounds(values, lowQ, highQ);
  return Math.max(0.008, range);
}

/**
 * Skewness (asimetría de Fisher-Pearson) de una ventana de señal.
 * SQI más fuerte para PPG (Elgendi 2016, "Optimal Signal Quality Index for
 * Photoplethysmogram Signals"): el PPG limpio tiene skewness POSITIVA (subida
 * sistólica abrupta + caída lenta → cola a la derecha); el ruido simétrico o la
 * señal corrupta por movimiento tiene skewness ≈ 0 o negativa. Devuelve 0 si la
 * varianza es nula (señal plana → sin información de asimetría).
 */
export function skewness(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i]!;
  mean /= n;
  let m2 = 0;
  let m3 = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i]! - mean;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  const sd = Math.sqrt(m2);
  if (sd < 1e-9) return 0;
  return m3 / (sd * sd * sd);
}
