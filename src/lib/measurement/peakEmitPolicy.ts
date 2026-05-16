/**
 * Política única de emisión de picos PPG — ponderación + anti falsos positivos.
 */
import type { PeakDetectionResult } from '@/types/measurements';
import { PEAK_DETECTION_DEFAULTS } from '@/config/signalProcessing';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { FingerPlacementMode } from '@/types/signal';
import {
  PEAK_SCORE_THRESHOLDS,
  passesRrPlausibility,
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
  consensusMin: number;
  allowSoloElgendi: boolean;
  sampleRateHz: number;
  windowSamples: number;
  placementMode?: FingerPlacementMode;
  fingerContactConfirmed?: boolean;
  nowMs?: number;
  emittedPeakCount?: number;
  peakStallMs?: number;
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
    allowSoloElgendi,
    sampleRateHz,
    windowSamples,
    placementMode = 'hybrid',
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
    reacquireMode || (fingerContactConfirmed && peakStallMs >= 2400);

  const minGap =
    VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS *
    PEAK_DETECTION_DEFAULTS.peakEmitRefractoryFactor;

  const diag = ens.diagnostics as {
    elgendiConfidence?: number;
    panTompkinsConfidence?: number;
  };
  const elConf = diag.elgendiConfidence ?? 0;
  const panConf = diag.panTompkinsConfidence ?? 0;
  const spectralAgreement = ens.agreement.spectral ?? 0;
  const prevRrMed = rrMedianMs(recentRrMs);

  let bestT = 0;
  let bestReason = '';
  let bestRank = 0;
  let bestScore = 0;

  const liveEdgeMs = stallReacquire
    ? PEAK_DETECTION_DEFAULTS.peakEmitWindowMs * 1.15
    : PEAK_DETECTION_DEFAULTS.peakEmitWindowMs * 0.92;
  const liveEdgeSamples = Math.max(6, Math.round(sampleRateHz * (liveEdgeMs / 1000)));

  const rankSource = (src: string | undefined): number => {
    if (src === 'dual') return 3;
    if (src === 'solo_elgendi') return 2;
    if (src === 'solo_pan') return 1;
    return 0;
  };

  for (let i = 0; i < ens.peakTimes.length; i++) {
    const t = ens.peakTimes[i] ?? 0;
    if (t <= 0 || t < lastEmittedPeakMs + minGap) continue;
    if (nowMs != null && t < nowMs - liveEdgeMs) continue;

    const idx = ens.peaks[i] ?? -1;
    if (nowMs == null) {
      const samplesFromLive = idx >= 0 ? windowSamples - 1 - idx : 999;
      if (samplesFromLive > liveEdgeSamples) continue;
    }

    const src = ens.peakSources?.[i];
    const rrMs = lastEmittedPeakMs > 0 ? t - lastEmittedPeakMs : undefined;
    if (rrMs != null && prevRrMed > 0 && !passesRrPlausibility(rrMs, prevRrMed)) {
      continue;
    }

    const weightedScore =
      ens.peakScores?.[i] ??
      scorePeakCandidate({
        source: src ?? 'solo_elgendi',
        elConf,
        panConf,
        ensConf: ens.confidence,
        spectralAgreement,
        sqi,
        perfusionIndex,
        rrMs,
        prevRrMedianMs: prevRrMed > 0 ? prevRrMed : undefined,
      });

    const dual =
      src === 'dual' &&
      ens.confidence >= minPeakConf * 0.72 &&
      weightedScore >= PEAK_SCORE_THRESHOLDS.dualMin;

    const soloEl =
      fingerContactConfirmed &&
      allowSoloElgendi &&
      emittedPeakCount >= 1 &&
      src === 'solo_elgendi' &&
      elConf >= (placementMode === 'hybrid' ? 0.2 : 0.22) &&
      spectralAgreement >= 0.2 &&
      weightedScore >= PEAK_SCORE_THRESHOLDS.soloMin;

    const soloPan =
      fingerContactConfirmed &&
      allowSoloElgendi &&
      emittedPeakCount >= 2 &&
      src === 'solo_pan' &&
      panConf >= 0.28 &&
      elConf >= 0.14 &&
      spectralAgreement >= 0.24 &&
      weightedScore >= PEAK_SCORE_THRESHOLDS.soloMin + 0.04;

    const bootOk =
      emittedPeakCount >= 2 ||
      stallReacquire ||
      dual ||
      (soloEl && weightedScore >= PEAK_SCORE_THRESHOLDS.soloMin + 0.06);

    if (!bootOk) continue;
    if (!dual && !soloEl && !soloPan) continue;

    const reason = dual ? 'DUAL_FUSED' : src === 'solo_pan' ? 'SOLO_PAN' : 'SOLO_ELGENDI';
    const rank = rankSource(src);

    if (
      bestT === 0 ||
      t > bestT ||
      (t === bestT && (rank > bestRank || weightedScore > bestScore))
    ) {
      bestT = t;
      bestReason = reason;
      bestRank = rank;
      bestScore = weightedScore;
    }
  }

  if (bestT > 0) {
    return { emit: true, peakTimeMs: bestT, reason: bestReason, weightedScore: bestScore };
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
      ? tail.filter((d) => Math.abs(d - med) / med <= 0.18)
      : tail;
  const use = trimmed.length >= 2 ? trimmed : tail;
  const sortedUse = [...use].sort((a, b) => a - b);
  const finalMed = sortedUse[Math.floor(sortedUse.length / 2)] ?? sortedUse[0]!;
  return 60000 / finalMed;
}
