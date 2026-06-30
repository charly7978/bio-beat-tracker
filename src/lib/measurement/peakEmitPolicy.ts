/**
 * Política única de emisión de picos PPG.
 *
 * Diseño arritmia-tolerante (validado: detectores PPG en tiempo real detectan
 * latidos por umbral adaptativo + refractario, SIN asumir regularidad RR):
 *   - Refractario FIJO (~300 ms) contra doble conteo / muesca dícrota.
 *   - Sin gate de regularidad RR (permite arritmias y evita el bloqueo
 *     permanente tras un latido perdido).
 *   - La genuinidad del pico la dan Elgendi (umbral + cuadrado + rechazo de
 *     amplitud), el refractario y la confianza del ensemble.
 */
import type { PeakDetectionResult } from '@/types/measurements';
import { PEAK_DETECTION_DEFAULTS } from '@/config/signalProcessing';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { rrMedianMs, scorePeakCandidate, PEAK_SCORE_THRESHOLDS } from './peakScoring';

export interface PeakEmitDecision {
  emit: boolean;
  peakTimeMs: number;
  reason: string;
  weightedScore?: number;
}

export interface PeakEmitPolicyInput {
  ens: PeakDetectionResult;
  lastEmittedPeakMs: number;
  minPeakConf: number;
  sampleRateHz: number;
  windowSamples: number;
  fingerContactConfirmed?: boolean;
  nowMs?: number;
  emittedPeakCount?: number;
  /** Tiempo desde el último pico emitido (ms). */
  peakStallMs?: number;
  /** Tras stall prolongado: relajar arranque y ventana viva. */
  reacquireMode?: boolean;
  recentRrMs?: number[];
  sqi?: number;
  perfusionIndex?: number;
}

export function decidePeakEmit(input: PeakEmitPolicyInput): PeakEmitDecision {
  const {
    ens,
    lastEmittedPeakMs,
    minPeakConf,
    sampleRateHz,
    windowSamples,
    fingerContactConfirmed = true,
    nowMs,
    peakStallMs = 0,
    reacquireMode = false,
    recentRrMs = [],
    sqi = 0,
    perfusionIndex = 0,
  } = input;

  const stallReacquire =
    reacquireMode ||
    (fingerContactConfirmed && peakStallMs >= 1500);

  const elConf = (ens.diagnostics as { elgendiConfidence?: number }).elgendiConfidence ?? 0;

  // Refractario FIJO (~300 ms, validado): bloquea doble conteo y muesca dícrota
  // por tiempo SIN escalar con la mediana RR. Así no bloquea latidos prematuros
  // (arritmias) ni se alarga hasta frenar la detección. La dícrota de baja
  // amplitud la filtra Elgendi (cuadrado + rechazo de amplitud relativa).
  const minGap = PEAK_DETECTION_DEFAULTS.peakEmitRefractoryMinMs;

  // Guard "latido imposiblemente temprano" (anti-dícrota a HR baja / doble conteo):
  // sólo por el lado bajo del RR → no recorta HR altas ni bloquea arritmias.
  const prevRrMed = rrMedianMs(recentRrMs);
  const minRrAbs =
    prevRrMed > 0 ? prevRrMed * PEAK_DETECTION_DEFAULTS.peakEmitMinRrFrac : 0;

  const liveEdgeMs = stallReacquire
    ? PEAK_DETECTION_DEFAULTS.peakEmitWindowMs * 1.25
    : PEAK_DETECTION_DEFAULTS.peakEmitWindowMs;
  const liveEdgeSamples = Math.max(6, Math.round(sampleRateHz * (liveEdgeMs / 1000)));

  let bestT = 0;
  let bestScore = 0;

  for (let i = 0; i < ens.peakTimes.length; i++) {
    const t = ens.peakTimes[i] ?? 0;
    // Refractario: única restricción temporal (no asume regularidad → arritmias OK).
    if (t <= 0 || t < lastEmittedPeakMs + minGap) continue;
    // Latido imposiblemente temprano vs ritmo establecido (dícrota/doble conteo).
    // Sólo lado bajo: un RR largo (re-sync tras latido perdido) y los PVC pasan.
    if (minRrAbs > 0 && lastEmittedPeakMs > 0 && t - lastEmittedPeakMs < minRrAbs) continue;
    // Recencia respecto a "ahora" (borde vivo).
    if (nowMs != null && t < nowMs - liveEdgeMs) continue;
    const idx = ens.peaks[i] ?? -1;
    if (nowMs == null) {
      const samplesFromLive = idx >= 0 ? windowSamples - 1 - idx : 999;
      if (samplesFromLive > liveEdgeSamples) continue;
    }
    if (!fingerContactConfirmed) continue;
    // Confianza mínima del ensemble (calidad de señal) — NO regularidad RR.
    if (ens.confidence < minPeakConf) continue;

    const weightedScore =
      ens.peakScores?.[i] ??
      scorePeakCandidate({ elConf, ensConf: ens.confidence, sqi, perfusionIndex });

    // Enforce minimum score threshold to eliminate false positives from noise/distortion
    const minScoreReq = stallReacquire ? PEAK_SCORE_THRESHOLDS.minScore * 0.8 : PEAK_SCORE_THRESHOLDS.minScore;
    if (weightedScore < minScoreReq) continue;

    // Emite el pico genuino más reciente fuera del refractario.
    if (bestT === 0 || t > bestT || (t === bestT && weightedScore > bestScore)) {
      bestT = t;
      bestScore = weightedScore;
    }
  }

  if (bestT > 0) {
    return { emit: true, peakTimeMs: bestT, reason: 'PEAK_DETECTED', weightedScore: bestScore };
  }

  return { emit: false, peakTimeMs: 0, reason: 'NO_NEW_PEAK' };
}

/** BPM desde RR emitidos con mediana recortada (menos falsos por un outlier). */
export function bpmFromEmittedRr(rrMs: number[]): number {
  if (rrMs.length < 1) return 0;
  const tail = rrMs.slice(-5).filter(
    (d) =>
      d >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS &&
      d <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS,
  );
  if (!tail.length) return 0;
  const sorted = [...tail].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? sorted[0]!;
  const trimmed =
    tail.length >= 3
      ? tail.filter((d) => Math.abs(d - med) / med <= 0.22)
      : tail;
  const use = trimmed.length >= 2 ? trimmed : tail;
  const sortedUse = [...use].sort((a, b) => a - b);
  const finalMed = sortedUse[Math.floor(sortedUse.length / 2)] ?? sortedUse[0]!;
  return 60000 / finalMed;
}
