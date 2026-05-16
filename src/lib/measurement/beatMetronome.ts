/** Emisión de latido “metrónomo” cuando el BPM es estable pero el ensemble no emite pico. */
export function shouldEmitMetronomeBeat(params: {
  nowMs: number;
  lastEmittedPeakMs: number;
  displayBpm: number;
  consecutivePeaks: number;
  lastGoodBpmAgeMs: number;
  minBpm: number;
  maxBpm: number;
  refractoryFactor?: number;
}): boolean {
  const {
    nowMs,
    lastEmittedPeakMs,
    displayBpm,
    consecutivePeaks,
    lastGoodBpmAgeMs,
    minBpm,
    maxBpm,
    refractoryFactor = 0.78,
  } = params;

  if (displayBpm < minBpm || displayBpm > maxBpm) return false;
  const trackActive = consecutivePeaks >= 2 || lastGoodBpmAgeMs < 5000;
  if (!trackActive) return false;

  const expectedMs = 60000 / displayBpm;
  const refractory = expectedMs * refractoryFactor;
  const since = lastEmittedPeakMs > 0 ? nowMs - lastEmittedPeakMs : refractory + 1;
  return since >= refractory;
}
