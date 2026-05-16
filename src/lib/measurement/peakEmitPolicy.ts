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
  } = input;

  const padRelaxed = placementMode === 'pad';
  const minGap =
    VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS *
    PEAK_DETECTION_DEFAULTS.peakEmitRefractoryFactor *
    0.88;

  const diag = ens.diagnostics as {
    elgendiConfidence?: number;
    panTompkinsConfidence?: number;
  };
  const elConf = diag.elgendiConfidence ?? 0;
  const detectorConsensus =
    (ens.agreement.elgendi + ens.agreement.panTompkins) / 2;

  let bestT = 0;
  let bestReason = '';

  const liveEdgeMax = Math.max(3, Math.round(sampleRateHz * 0.42));

  for (let i = 0; i < ens.peakTimes.length; i++) {
    const t = ens.peakTimes[i] ?? 0;
    if (t <= 0 || t <= lastEmittedPeakMs + minGap * 0.45) continue;

    const idx = ens.peaks[i] ?? -1;
    const samplesFromLive = idx >= 0 ? windowSamples - 1 - idx : 999;
    if (samplesFromLive > liveEdgeMax) continue;

    const src = ens.peakSources?.[i];
    const dual =
      src === 'dual' &&
      detectorConsensus >= consensusMin * 0.75 &&
      ens.confidence >= minPeakConf * 0.85;
    const solo =
      allowSoloElgendi &&
      src === 'solo_elgendi' &&
      elConf >= (padRelaxed ? 0.09 : 0.12) &&
      ens.confidence >= minPeakConf * (padRelaxed ? 0.58 : 0.65);

    if (dual || solo) {
      if (t >= bestT) {
        bestT = t;
        bestReason = dual ? 'DUAL_FUSED' : 'SOLO_ELGENDI';
      }
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
