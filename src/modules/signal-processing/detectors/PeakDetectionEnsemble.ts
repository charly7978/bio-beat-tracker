/**
 * Detección de picos PPG con Elgendi optimizado.
 */
import type { PeakDetectionResult } from '../../../types/measurements';
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { clamp } from '../../../utils/math';
import { median } from '../../../utils/stats';
import { isPhysiologicalRR } from '../../../utils/physio';
import { computeDetectorCalibration } from '../../../lib/measurement/detectorCalibration';
import { scorePeakCandidate } from '../../../lib/measurement/peakScoring';
import { ElgendiPeakDetector } from './ElgendiPeakDetector';

export interface PeakDetectionEnsembleInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  sqi?: number;
  perfusionIndex?: number;
  /** Beat-window adaptativo (ms) según ritmo detectado; default Elgendi si se omite. */
  beatWindowMs?: number;
  legacyPeakIndices?: number[];
}

export class PeakDetectionEnsemble {
  static analyze(input: PeakDetectionEnsembleInput): PeakDetectionResult {
    const log: PeakDetectionResult['rejectedPeaks'] = [];
    const { signal, timestampsMs, samplingRateHz, sqi, perfusionIndex = 0 } = input;

    if (signal.length < PEAK_DETECTION_DEFAULTS.minSamplesEnsemble || signal.length !== timestampsMs.length) {
      return {
        peaks: [],
        peakTimes: [],
        rrIntervalsMs: [],
        bpmInstant: null,
        bpmStable: null,
        confidence: 0,
        agreement: { elgendi: 0 },
        rejectedPeaks: [],
        diagnostics: { reason: 'INSUFFICIENT_WINDOW' },
      };
    }

    const gaps: number[] = [];
    for (let i = 1; i < timestampsMs.length; i++) {
      const d = timestampsMs[i] - timestampsMs[i - 1];
      if (d > 0 && d < 500) gaps.push(d);
    }
    let fsEffective = samplingRateHz;
    let fsAdapted = false;
    if (gaps.length >= 8) {
      const sorted = [...gaps].sort((a, b) => a - b);
      const medDt = sorted[Math.floor(sorted.length / 2)] ?? 1000 / samplingRateHz;
      const fsFromTs = 1000 / medDt;
      if (
        fsFromTs >= 5 && fsFromTs <= 240 &&
        Math.abs(fsFromTs - samplingRateHz) / samplingRateHz > 0.1
      ) {
        fsEffective = fsFromTs;
        fsAdapted = true;
      }
    }

    const calibration = computeDetectorCalibration(
      signal,
      fsEffective,
      sqi,
      perfusionIndex,
    );

    const el = ElgendiPeakDetector.detect({
      signal,
      timestampsMs,
      samplingRateHz: fsEffective,
      sqi,
      minProminence: calibration.elgendiMinProminence,
      beatOffset: calibration.elgendiOffsetWeight,
      beatWindowMs: input.beatWindowMs,
    });

    const elTimeAt = (j: number): number => {
      const ie = el.peaks[j] ?? 0;
      return el.peakTimes[j] ?? timestampsMs[ie] ?? 0;
    };

    const peakIdx: number[] = [];
    const peakTimes: number[] = [];

    for (let j = 0; j < el.peaks.length; j++) {
      const ie = el.peaks[j]!;
      const te = elTimeAt(j);
      peakIdx.push(clamp(ie, 0, signal.length - 1));
      peakTimes.push(te);
      log.push({ index: ie, reason: 'ELGENDI', detector: 'Elgendi' });
    }

    const order = peakTimes
      .map((t, i) => ({ t, i }))
      .sort((a, b) => a.t - b.t)
      .map((o) => o.i);
    const sortedIdx = order.map((i) => peakIdx[i]!);
    const sortedTimes = order.map((i) => peakTimes[i]!);

    const rr: number[] = [];
    for (let i = 1; i < sortedTimes.length; i++) {
      const d = sortedTimes[i] - sortedTimes[i - 1];
      if (isPhysiologicalRR(d)) rr.push(d);
    }

    const bpmInstant: number | null = rr.length ? 60000 / median(rr.slice(-4)) : null;

    const nE = el.peaks.length || 1;
    const agreeEl = clamp(sortedTimes.length / nE, 0, 1);

    let confidence =
      agreeEl * 0.50 +
      clamp(el.confidence, 0, 1) * 0.50;

    if (typeof sqi === 'number' && sqi < PEAK_DETECTION_DEFAULTS.minSQI) {
      confidence *= 0.8;
    }
    if (sortedIdx.length > 0) {
      confidence = clamp(confidence + 0.08, 0, 1);
    }

    // SQI por skewness (Elgendi 2016): penalización SUAVE de confianza. PPG limpio
    // (skew alta) → factor 1; ruido simétrico/corrupción (skew baja/negativa) →
    // factor hasta FLOOR. Reduce FP de ventanas no-pulsátiles sin bloquear latidos
    // reales (un latido genuino tiene skewness positiva → nunca se penaliza).
    const skew = (el.diagnostics as { signalSkewness?: number }).signalSkewness;
    if (typeof skew === 'number' && Number.isFinite(skew)) {
      const Q = VITAL_THRESHOLDS.QUALITY;
      const skewFactor =
        Q.SKEWNESS_SQI_FLOOR +
        (1 - Q.SKEWNESS_SQI_FLOOR) *
          clamp((skew - Q.SKEWNESS_SQI_LOW) / (Q.SKEWNESS_SQI_HIGH - Q.SKEWNESS_SQI_LOW), 0, 1);
      confidence *= skewFactor;
    }

    const sqiVal = sqi ?? 0;
    const peakScores: number[] = [];
    for (let i = 0; i < sortedTimes.length; i++) {
      const rrMs = i > 0 ? sortedTimes[i]! - sortedTimes[i - 1]! : undefined;
      let prevMed = 0;
      if (i > 1) {
        const rrSlice: number[] = [];
        for (let k = 1; k < i; k++) {
          const d = sortedTimes[k]! - sortedTimes[k - 1]!;
          if (isPhysiologicalRR(d)) rrSlice.push(d);
        }
        if (rrSlice.length) prevMed = median(rrSlice);
      }
      peakScores.push(
        scorePeakCandidate({
          elConf: el.confidence,
          ensConf: confidence,
          sqi: sqiVal,
          perfusionIndex,
          rrMs,
          prevRrMedianMs: prevMed > 0 ? prevMed : undefined,
        }),
      );
    }

    return {
      peaks: sortedIdx,
      peakTimes: sortedTimes,
      peakScores,
      rrIntervalsMs: rr,
      bpmInstant,
      bpmStable: bpmInstant,
      confidence: clamp(confidence, 0, 1),
      agreement: {
        elgendi: agreeEl,
      },
      rejectedPeaks: log,
      diagnostics: {
        elgendi: el.diagnostics,
        elgendiReason: el.reason,
        fusedCount: sortedIdx.length,
        detectorCalibration: calibration,
        elgendiConfidence: el.confidence,
        fusedPeakTimes: sortedTimes,
        elgendiPeakTimes: el.peakTimes,
        fsDeclared: samplingRateHz,
        fsEffective,
        fsAdapted,
      },
    };
  }
}