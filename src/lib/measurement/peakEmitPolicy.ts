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
  /** Si false, solo emite picos con fusión dual (anti–falso positivo sin dedo). */
  fingerContactConfirmed?: boolean;
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
  } = input;

  /** Refractario completo (~221 ms @ factor 0.82) — evita ráfagas >250 BPM por solo_elgendi. */
  const minGap =
    VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS *
    PEAK_DETECTION_DEFAULTS.peakEmitRefractoryFactor;
  const soloMinGap = minGap * 1.08;

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
    if (t <= 0 || t <= lastEmittedPeakMs) continue;

    const idx = ens.peaks[i] ?? -1;
    const samplesFromLive = idx >= 0 ? windowSamples - 1 - idx : 999;
    if (samplesFromLive > liveEdgeMax) continue;

    const src = ens.peakSources?.[i];
    const dual =
      src === 'dual' &&
      t >= lastEmittedPeakMs + minGap &&
      detectorConsensus >= consensusMin * (fingerContactConfirmed ? 0.82 : 0.9) &&
      ens.confidence >= minPeakConf * (fingerContactConfirmed ? 0.9 : 0.96);
    const soloElMin =
      placementMode === 'pad' ? 0.28 : placementMode === 'tip' ? 0.3 : 0.32;
    const solo =
      fingerContactConfirmed &&
      allowSoloElgendi &&
      src === 'solo_elgendi' &&
      t >= lastEmittedPeakMs + soloMinGap &&
      elConf >= soloElMin &&
      detectorConsensus >= consensusMin * (placementMode === 'hybrid' ? 0.82 : 0.8) &&
      ens.confidence >= minPeakConf * (placementMode === 'hybrid' ? 0.96 : 0.92);

    if (dual || solo) {
      // Primer pico nuevo en orden temporal (no el más reciente del buffer).
      if (bestT === 0 || t < bestT) {
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
