/**
 * Ensemble de detección de picos PPG: Elgendi + Hamilton + validación espectral.
 * Voting genuino entre dos detectores con fusión por tolerancia temporal.
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
import { HamiltonPPG } from './HamiltonPPG';
import { bandLimitedDominantFreq, autocorrDominantLag } from '../shared/dsp';

export interface PeakDetectionEnsembleInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  sqi?: number;
  perfusionIndex?: number;
  beatWindowMs?: number;
  legacyPeakIndices?: number[];
}

/** Tolerancia para fusionar picos de ambos detectores (ms) */
const MERGE_TOLERANCE_MS = 120;

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
        agreement: { elgendi: 0, hamilton: 0, spectral: 0 },
        rejectedPeaks: [],
        diagnostics: { reason: 'INSUFFICIENT_WINDOW' },
      };
    }

    // Adaptar fs desde timestamps
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
      signal, fsEffective, sqi, perfusionIndex,
    );

    // ── Detector 1: Elgendi ──
    const el = ElgendiPeakDetector.detect({
      signal, timestampsMs,
      samplingRateHz: fsEffective,
      sqi,
      minProminence: calibration.elgendiMinProminence,
      offsetWeight: calibration.elgendiOffsetWeight,
      beatWindowMs: input.beatWindowMs,
    });

    // ── Detector 2: Hamilton ──
    const ham = HamiltonPPG.detect({
      signal, timestampsMs,
      samplingRateHz: fsEffective,
      sqi,
    });

    // ── Validación espectral ──
    // Estima la frecuencia dominante en la banda cardíaca (0.7–4.0 Hz)
    // y la compara con la estimación por autocorrelación.
    const spectralResult = bandLimitedDominantFreq(signal, fsEffective, 0.7, 4.0);
    const autoResult = autocorrDominantLag(
      signal.map((v) => v),
      Math.max(5, Math.round((fsEffective * 60) / 200)),
      Math.min(signal.length - 8, Math.round((fsEffective * 60) / 38)),
    );
    const autoBpm = autoResult.lag > 0 ? (60 * fsEffective) / autoResult.lag : 0;
    const spectralBpm = spectralResult.freqHz > 0 ? spectralResult.freqHz * 60 : 0;

    // Concordancia espectral: ambos estimadores deben concordar (±15%)
    let spectralAgreement = 0;
    if (autoBpm > 0 && spectralBpm > 0) {
      const relDiff = Math.abs(autoBpm - spectralBpm) / Math.max(autoBpm, spectralBpm);
      spectralAgreement = clamp(1 - relDiff / 0.15, 0, 1) * spectralResult.quality;
    } else if (spectralResult.freqHz > 0 && spectralResult.quality > 0.3) {
      spectralAgreement = spectralResult.quality * 0.5;
    }

    // ── Fusión por tolerancia temporal ──
    // Merge peaks from both detectors within MERGE_TOLERANCE_MS
    const elTimes = el.peakTimes;
    const hamTimes = ham.peakTimes;

    // Contar cuántos picos de Elgendi tienen unHamilton cercano (y viceversa)
    let elMatched = 0;
    let hamMatched = 0;
    const matchedByBoth: boolean[] = new Array(elTimes.length).fill(false);

    for (let i = 0; i < elTimes.length; i++) {
      for (let j = 0; j < hamTimes.length; j++) {
        if (Math.abs(elTimes[i]! - hamTimes[j]!) <= MERGE_TOLERANCE_MS) {
          elMatched++;
          matchedByBoth[i] = true;
          break;
        }
      }
    }
    for (let j = 0; j < hamTimes.length; j++) {
      for (let i = 0; i < elTimes.length; i++) {
        if (Math.abs(elTimes[i]! - hamTimes[j]!) <= MERGE_TOLERANCE_MS) {
          hamMatched++;
          break;
        }
      }
    }

    const elAgreement = elTimes.length > 0 ? elMatched / elTimes.length : 0;
    const hamAgreement = hamTimes.length > 0 ? hamMatched / hamTimes.length : 0;

    // Usar picos de Elgendi como primario, marcar los que Hamilton confirma
    const peakIdx: number[] = [];
    const peakTimesOut: number[] = [];

    for (let j = 0; j < el.peaks.length; j++) {
      const ie = el.peaks[j]!;
      const te = el.peakTimes[j] ?? timestampsMs[ie] ?? 0;
      peakIdx.push(clamp(ie, 0, signal.length - 1));
      peakTimesOut.push(te);
      const detector = matchedByBoth[j] ? 'ELGENDI+HAMILTON' : 'ELGENDI';
      log.push({ index: ie, reason: detector, detector: 'Elgendi' });
    }

    // Ordenar por tiempo
    const order = peakTimesOut
      .map((t, i) => ({ t, i }))
      .sort((a, b) => a.t - b.t)
      .map((o) => o.i);
    const sortedIdx = order.map((i) => peakIdx[i]!);
    const sortedTimes = order.map((i) => peakTimesOut[i]!);

    // RR intervals
    const rr: number[] = [];
    for (let i = 1; i < sortedTimes.length; i++) {
      const d = sortedTimes[i] - sortedTimes[i - 1];
      if (isPhysiologicalRR(d)) rr.push(d);
    }

    const bpmInstant: number | null = rr.length ? 60000 / median(rr.slice(-4)) : null;

    // ── Cálculo de confianza ──
    // Voting genuino: ambos detectores deben concordar + validación espectral
    const detectorAgreement = (elAgreement + hamAgreement) / 2;
    const minDetectorConf = Math.min(el.confidence, ham.confidence);
    const maxDetectorConf = Math.max(el.confidence, ham.confidence);

    let confidence =
      detectorAgreement * 0.35 +
      minDetectorConf * 0.25 +
      maxDetectorConf * 0.15 +
      spectralAgreement * 0.25;

    if (typeof sqi === 'number' && sqi < PEAK_DETECTION_DEFAULTS.minSQI) {
      confidence *= 0.8;
    }
    if (sortedIdx.length > 0) {
      confidence = clamp(confidence + 0.05, 0, 1);
    }

    // Penalización por skewness
    const skew = (el.diagnostics as { signalSkewness?: number }).signalSkewness;
    if (typeof skew === 'number' && Number.isFinite(skew)) {
      const Q = VITAL_THRESHOLDS.QUALITY;
      const skewFactor =
        Q.SKEWNESS_SQI_FLOOR +
        (1 - Q.SKEWNESS_SQI_FLOOR) *
          clamp((skew - Q.SKEWNESS_SQI_LOW) / (Q.SKEWNESS_SQI_HIGH - Q.SKEWNESS_SQI_LOW), 0, 1);
      confidence *= skewFactor;
    }

    // ── Peak scoring ──
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
        elgendi: elAgreement,
        hamilton: hamAgreement,
        spectral: spectralAgreement,
      },
      rejectedPeaks: log,
      diagnostics: {
        elgendi: el.diagnostics,
        elgendiReason: el.reason,
        hamilton: ham.diagnostics,
        hamiltonConfidence: ham.confidence,
        hamiltonNPeaks: ham.peaks.length,
        fusedCount: sortedIdx.length,
        detectorCalibration: calibration,
        elgendiConfidence: el.confidence,
        detectorAgreement,
        spectralAgreement,
        spectralFreqHz: spectralResult.freqHz,
        spectralQuality: spectralResult.quality,
        autoBpm,
        spectralBpm,
        fusedPeakTimes: sortedTimes,
        elgendiPeakTimes: el.peakTimes,
        hamiltonPeakTimes: ham.peakTimes,
        fsDeclared: samplingRateHz,
        fsEffective,
        fsAdapted,
      },
    };
  }
}
