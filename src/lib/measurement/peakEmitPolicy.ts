/**
 * Política única de emisión de picos PPG — ponderación + anti falsos positivos.
 */
import type { PeakDetectionResult } from '@/types/measurements';
import { PEAK_DETECTION_DEFAULTS } from '@/config/signalProcessing';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import {
  PEAK_SCORE_THRESHOLDS,
  rrMedianMs,
  scorePeakCandidate,
} from './peakScoring';

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
    emittedPeakCount = 0,
    peakStallMs = 0,
    reacquireMode = false,
    recentRrMs = [],
    sqi = 0,
    perfusionIndex = 0,
  } = input;

  const stallReacquire =
    reacquireMode ||
    (fingerContactConfirmed && peakStallMs >= 1800);

  const elConf = (ens.diagnostics as { elgendiConfidence?: number }).elgendiConfidence ?? 0;
  const prevRrMed = rrMedianMs(recentRrMs);

  // Refractario adaptativo: bloquea muesca dícrota y doble conteo a HR bajas,
  // sin frenar latidos reales a HR altas (RR > 300 ms hasta ~200 bpm).
  const minGap =
    prevRrMed > 0
      ? Math.max(
          PEAK_DETECTION_DEFAULTS.peakEmitRefractoryMinMs,
          prevRrMed * PEAK_DETECTION_DEFAULTS.peakEmitRefractoryFraction,
        )
      : PEAK_DETECTION_DEFAULTS.peakEmitRefractoryMinMs;

  let bestT = 0;
  let bestReason = '';
  let bestScore = 0;

  const liveEdgeMs = stallReacquire
    ? PEAK_DETECTION_DEFAULTS.peakEmitWindowMs * 1.25
    : PEAK_DETECTION_DEFAULTS.peakEmitWindowMs;
  const liveEdgeSamples = Math.max(6, Math.round(sampleRateHz * (liveEdgeMs / 1000)));
  const rrPlausibilityMaxDev =
    emittedPeakCount < 4
      ? PEAK_SCORE_THRESHOLDS.rrMedianMaxRelDev * 1.25
      : PEAK_SCORE_THRESHOLDS.rrMedianMaxRelDev;

  for (let i = 0; i < ens.peakTimes.length; i++) {
    const t = ens.peakTimes[i] ?? 0;
    if (t <= 0 || t < lastEmittedPeakMs + minGap) continue;

    if (nowMs != null && t < nowMs - liveEdgeMs) continue;

    const idx = ens.peaks[i] ?? -1;
    if (nowMs == null) {
      const samplesFromLive = idx >= 0 ? windowSamples - 1 - idx : 999;
      if (samplesFromLive > liveEdgeSamples) continue;
    }

    const rrMs = lastEmittedPeakMs > 0 ? t - lastEmittedPeakMs : undefined;
    if (
      rrMs != null &&
      prevRrMed > 0 &&
      Math.abs(rrMs - prevRrMed) / prevRrMed > rrPlausibilityMaxDev
    ) {
      continue;
    }

    if (!fingerContactConfirmed) continue;

    if (ens.confidence < minPeakConf) continue;

    const weightedScore =
      ens.peakScores?.[i] ??
      scorePeakCandidate({
        elConf,
        ensConf: ens.confidence,
        sqi,
        perfusionIndex,
        rrMs,
        prevRrMedianMs: prevRrMed > 0 ? prevRrMed : undefined,
      });

    const minScore = PEAK_SCORE_THRESHOLDS.minScore * (stallReacquire ? 0.9 : 0.96);
    if (weightedScore < minScore) continue;

    if (
      bestT === 0 ||
      t > bestT ||
      (t === bestT && weightedScore > bestScore)
    ) {
      bestT = t;
      bestReason = 'PEAK_DETECTED';
      bestScore = weightedScore;
    }
  }

  if (bestT > 0) {
    return { emit: true, peakTimeMs: bestT, reason: bestReason, weightedScore: bestScore };
  }

  // Respaldo: mejor candidato en borde vivo por índice
  let fbT = 0;
  let fbScore = 0;
  for (let i = 0; i < ens.peakTimes.length; i++) {
    const t = ens.peakTimes[i] ?? 0;
    if (t <= 0 || t < lastEmittedPeakMs + minGap) continue;
    const idx = ens.peaks[i] ?? -1;
    const nearLive =
      nowMs == null
        ? idx >= 0 && windowSamples - 1 - idx <= liveEdgeSamples
        : t >= (nowMs ?? t) - liveEdgeMs;
    if (!nearLive) continue;
    // El respaldo relaja el score, pero NO la plausibilidad de RR: así no
    // re-admite picos con intervalo implausible que el bucle principal rechazó.
    const fbRrMs = lastEmittedPeakMs > 0 ? t - lastEmittedPeakMs : undefined;
    if (
      fbRrMs != null &&
      prevRrMed > 0 &&
      Math.abs(fbRrMs - prevRrMed) / prevRrMed > rrPlausibilityMaxDev
    ) {
      continue;
    }
    const score =
      ens.peakScores?.[i] ??
      scorePeakCandidate({
        elConf,
        ensConf: ens.confidence,
        sqi,
        perfusionIndex,
      });
    if (score < PEAK_SCORE_THRESHOLDS.minScore * 0.94 || !fingerContactConfirmed) continue;
    if (t > fbT || (t === fbT && score > fbScore)) {
      fbT = t;
      fbScore = score;
    }
  }
  if (fbT > 0) {
    return {
      emit: true,
      peakTimeMs: fbT,
      reason: 'PEAK_DETECTED_FB',
      weightedScore: fbScore,
    };
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
