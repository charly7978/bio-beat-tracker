/**
 * Política única de emisión de picos PPG — ponderación + anti falsos positivos.
 */
import type { PeakDetectionResult } from '@/types/measurements';
import { PEAK_DETECTION_DEFAULTS } from '@/config/signalProcessing';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { FingerPlacementMode } from '@/types/signal';
import {
  PEAK_SCORE_THRESHOLDS,
  rrMedianMs,
  scorePeakCandidate,
} from './peakScoring';
import type { DetectorCalibration } from './detectorCalibration';

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
    consensusMin: _consensusMin,
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
    reacquireMode ||
    (fingerContactConfirmed && peakStallMs >= 1800);

  const minGap =
    VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS *
    PEAK_DETECTION_DEFAULTS.peakEmitRefractoryFactor;

  const diag = ens.diagnostics as {
    elgendiConfidence?: number;
    detectorCalibration?: DetectorCalibration;
  };
  const cal = diag.detectorCalibration;
  const elConf = diag.elgendiConfidence ?? 0;
  const soloElMin =
    cal?.soloElgendiMinConf ??
    (placementMode === 'hybrid' ? 0.15 : 0.17);
  const spectralAgreement = ens.agreement.spectral ?? 0;
  const prevRrMed = rrMedianMs(recentRrMs);

  let bestT = 0;
  let bestReason = '';
  let bestRank = 0;
  let bestScore = 0;

  const liveEdgeMs = stallReacquire
    ? PEAK_DETECTION_DEFAULTS.peakEmitWindowMs * 1.25
    : PEAK_DETECTION_DEFAULTS.peakEmitWindowMs;
  const liveEdgeSamples = Math.max(6, Math.round(sampleRateHz * (liveEdgeMs / 1000)));
  const rrPlausibilityMaxDev =
    emittedPeakCount < 4
      ? PEAK_SCORE_THRESHOLDS.rrMedianMaxRelDev * 1.25
      : PEAK_SCORE_THRESHOLDS.rrMedianMaxRelDev;

  const rankSource = (src: string | undefined): number => {
    if (src === 'dual') return 2;
    if (src === 'solo_elgendi') return 1;
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
    if (
      rrMs != null &&
      prevRrMed > 0 &&
      Math.abs(rrMs - prevRrMed) / prevRrMed > rrPlausibilityMaxDev
    ) {
      continue;
    }

    const dual =
      src === 'dual' &&
      ens.confidence >= minPeakConf * 0.65;
    const soloEl =
      fingerContactConfirmed &&
      allowSoloElgendi &&
      src === 'solo_elgendi' &&
      elConf >= soloElMin &&
      spectralAgreement >= (stallReacquire ? 0.08 : 0.12);

    if (!dual && !soloEl) continue;

    const weightedScore =
      ens.peakScores?.[i] ??
      scorePeakCandidate({
        source: src ?? 'solo_elgendi',
        elConf,
        ensConf: ens.confidence,
        spectralAgreement,
        sqi,
        perfusionIndex,
        rrMs,
        prevRrMedianMs: prevRrMed > 0 ? prevRrMed : undefined,
      });

    const minScore = dual
      ? PEAK_SCORE_THRESHOLDS.dualMin * (stallReacquire ? 0.9 : 0.96)
      : PEAK_SCORE_THRESHOLDS.soloMin * (stallReacquire ? 0.9 : 0.96);
    if (weightedScore < minScore) continue;

    const reason = dual ? 'DUAL_FUSED' : 'SOLO_ELGENDI';
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

  // Respaldo: mejor candidato en borde vivo por índice (timestamps a veces van rezagados)
  let fbT = 0;
  let fbReason = '';
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
    const src = ens.peakSources?.[i];
    const score =
      ens.peakScores?.[i] ??
      scorePeakCandidate({
        source: src ?? 'solo_elgendi',
        elConf,
        ensConf: ens.confidence,
        spectralAgreement,
        sqi,
        perfusionIndex,
      });
    const fbMin =
      src === 'dual'
        ? PEAK_SCORE_THRESHOLDS.dualMin * 0.92
        : PEAK_SCORE_THRESHOLDS.soloMin * 0.94;
    if (score < fbMin || !fingerContactConfirmed) continue;
    if (!stallReacquire && src !== 'dual' && score < PEAK_SCORE_THRESHOLDS.soloMin) {
      continue;
    }
    if (t > fbT || (t === fbT && score > fbScore)) {
      fbT = t;
      fbScore = score;
      fbReason = src === 'dual' ? 'DUAL_FUSED' : 'SOLO_ELGENDI';
    }
  }
  if (fbT > 0) {
    return {
      emit: true,
      peakTimeMs: fbT,
      reason: `${fbReason}_FB`,
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
