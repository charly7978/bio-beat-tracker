/**
 * Política única de emisión de picos PPG — sin metrónomo ni BPM sin latido.
 */
import type { PeakDetectionResult } from '@/types/measurements';
import { PEAK_DETECTION_DEFAULTS } from '@/config/signalProcessing';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { FingerPlacementMode } from '@/types/signal';

export interface PeakEmitDecision {
  emit: boolean;
  peakTimeMs: number;
  reason: string;
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
  /** Marco actual (performance.now) para ventana viva por tiempo */
  nowMs?: number;
}

export function decidePeakEmit(input: PeakEmitPolicyInput): PeakEmitDecision {
  const {
    ens,
    lastEmittedPeakMs,
    minPeakConf,
    consensusMin,
    allowSoloElgendi,
    sampleRateHz,
    windowSamples,
    placementMode = 'hybrid',
    fingerContactConfirmed = true,
    nowMs,
  } = input;

  const minGap =
    VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS *
    PEAK_DETECTION_DEFAULTS.peakEmitRefractoryFactor;

  const diag = ens.diagnostics as {
    elgendiConfidence?: number;
    panTompkinsConfidence?: number;
  };
  const elConf = diag.elgendiConfidence ?? 0;
  const panConf = diag.panTompkinsConfidence ?? 0;
  const detectorConsensus =
    (ens.agreement.elgendi + ens.agreement.panTompkins) / 2;

  let bestT = 0;
  let bestReason = '';
  let bestRank = 0;

  const liveEdgeMs = PEAK_DETECTION_DEFAULTS.peakEmitWindowMs;
  const liveEdgeSamples = Math.max(4, Math.round(sampleRateHz * (liveEdgeMs / 1000)));

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
    const dual =
      src === 'dual' &&
      detectorConsensus >= consensusMin * (fingerContactConfirmed ? 0.68 : 0.78) &&
      ens.confidence >= minPeakConf * (fingerContactConfirmed ? 0.72 : 0.88);
    const soloElMin =
      placementMode === 'pad' ? 0.14 : placementMode === 'tip' ? 0.16 : 0.18;
    const soloEl =
      fingerContactConfirmed &&
      allowSoloElgendi &&
      src === 'solo_elgendi' &&
      elConf >= soloElMin &&
      detectorConsensus >= consensusMin * 0.65 &&
      ens.confidence >= minPeakConf * 0.78;
    const soloPan =
      fingerContactConfirmed &&
      allowSoloElgendi &&
      src === 'solo_pan' &&
      panConf >= soloElMin &&
      detectorConsensus >= consensusMin * 0.65 &&
      ens.confidence >= minPeakConf * 0.78;

    if (!dual && !soloEl && !soloPan) continue;

    const reason = dual ? 'DUAL_FUSED' : src === 'solo_pan' ? 'SOLO_PAN' : 'SOLO_ELGENDI';
    const rank = rankSource(src);

    if (bestT === 0 || t > bestT || (t === bestT && rank > bestRank)) {
      bestT = t;
      bestReason = reason;
      bestRank = rank;
    }
  }

  if (bestT > 0) {
    return { emit: true, peakTimeMs: bestT, reason: bestReason };
  }

  return { emit: false, peakTimeMs: 0, reason: 'NO_NEW_PEAK' };
}

/** BPM solo desde intervalos RR de picos ya emitidos. */
export function bpmFromEmittedRr(rrMs: number[]): number {
  if (rrMs.length < 1) return 0;
  const tail = rrMs.slice(-4).filter(
    (d) =>
      d >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS &&
      d <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS,
  );
  if (!tail.length) return 0;
  const sorted = [...tail].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? sorted[0]!;
  return 60000 / med;
}
