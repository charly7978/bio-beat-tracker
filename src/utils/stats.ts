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
