/**
 * Suavizado sutil para displays en vivo (BPM, SpO2, PA).
 */
export function smoothDisplayValue(
  prev: number,
  next: number,
  alpha: number,
): number {
  const a = Math.min(1, Math.max(0.04, alpha));
  if (next <= 0) {
    return prev <= 0 ? 0 : prev + (0 - prev) * a * 0.65;
  }
  if (prev <= 0) return next;
  return prev + (next - prev) * a;
}

export function smoothDisplayPair(
  prev: { systolic: number; diastolic: number },
  next: { systolic: number; diastolic: number },
  alpha: number,
): { systolic: number; diastolic: number } {
  return {
    systolic: Math.round(smoothDisplayValue(prev.systolic, next.systolic, alpha)),
    diastolic: Math.round(smoothDisplayValue(prev.diastolic, next.diastolic, alpha)),
  };
}
