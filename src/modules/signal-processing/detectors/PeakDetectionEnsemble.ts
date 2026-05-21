/**
 * Detección de picos PPG: Elgendi + autocorrelación espectral.
 * Validación cruzada espectral para reducir falsos positivos.
 */
import type { PeakDetectionResult } from '../../../types/measurements';
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { clamp } from '../../../utils/math';
import { median } from '../../../utils/stats';
import { isPhysiologicalRR } from '../../../utils/physio';
import { bpmFromAutocorr } from '../shared/dsp';
import { computeDetectorCalibration } from '../../../lib/measurement/detectorCalibration';
import { scorePeakCandidate } from '../../../lib/measurement/peakScoring';
import { ElgendiPeakDetector } from './ElgendiPeakDetector';

export interface PeakDetectionEnsembleInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  sqi?: number;
  perfusionIndex?: number;
  legacyPeakIndices?: number[];
  allowSoloElgendiFusion?: boolean;
}

type PeakSource = 'dual' | 'solo_elgendi';

export class PeakDetectionEnsemble {
  static analyze(input: PeakDetectionEnsembleInput): PeakDetectionResult {
    const rejected: PeakDetectionResult['rejectedPeaks'] = [];
    const { signal, timestampsMs, samplingRateHz, sqi, perfusionIndex = 0, allowSoloElgendiFusion } = input;

    if (signal.length < PEAK_DETECTION_DEFAULTS.minSamplesEnsemble || signal.length !== timestampsMs.length) {
      return {
        peaks: [],
        peakTimes: [],
        rrIntervalsMs: [],
        bpmInstant: null,
        bpmStable: null,
        confidence: 0,
        agreement: { elgendi: 0, spectral: 0, autocorrelation: 0 },
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
      offsetWeight: calibration.elgendiOffsetWeight,
    });

    const spec = bpmFromAutocorr(signal, fsEffective);
    const tolMs = calibration.fusionToleranceMs;
    const allowSolo = allowSoloElgendiFusion !== false;
    const soloElMin = calibration.soloElgendiMinConf;

    const fusedIdx: number[] = [];
    const fusedTimes: number[] = [];
    const peakSources: PeakSource[] = [];

    const elTimeAt = (j: number): number => {
      const ie = el.peaks[j] ?? 0;
      return el.peakTimes[j] ?? timestampsMs[ie] ?? 0;
    };

    for (let j = 0; j < el.peaks.length; j++) {
      const ie = el.peaks[j]!;
      const te = elTimeAt(j);
      if (allowSolo && el.confidence >= soloElMin) {
        fusedIdx.push(clamp(ie, 0, signal.length - 1));
        fusedTimes.push(te);
        peakSources.push('solo_elgendi');
        if (j > 0) {
          rejected.push({ index: ie, reason: 'SOLO_ELGENDI', detector: 'Elgendi' });
        }
      } else {
        rejected.push({ index: ie, reason: 'LOW_CONFIDENCE', detector: 'Elgendi' });
      }
    }

    const order = fusedTimes
      .map((t, i) => ({ t, i }))
      .sort((a, b) => a.t - b.t)
      .map((o) => o.i);
    const sortedIdx = order.map((i) => fusedIdx[i]!);
    const sortedTimes = order.map((i) => fusedTimes[i]!);
    const sortedSources = order.map((i) => peakSources[i]!);

    const rr: number[] = [];
    for (let i = 1; i < sortedTimes.length; i++) {
      const d = sortedTimes[i] - sortedTimes[i - 1];
      if (isPhysiologicalRR(d)) rr.push(d);
    }

    let bpmInstant: number | null = rr.length ? 60000 / median(rr.slice(-4)) : null;
    const specBpm = spec.bpm > 0 ? spec.bpm : null;

    if (bpmInstant && specBpm) {
      const half = bpmInstant * 2;
      const dbl = bpmInstant / 2;
      if (Math.abs(half - specBpm) < Math.abs(bpmInstant - specBpm) - 8) {
        bpmInstant = half;
      } else if (Math.abs(dbl - specBpm) < Math.abs(bpmInstant - specBpm) - 8) {
        bpmInstant = dbl;
      }
    } else if (!bpmInstant && specBpm) {
      bpmInstant = specBpm;
    }

    let spectralAgreement = 0;
    if (bpmInstant && specBpm) {
      spectralAgreement = clamp(1 - Math.abs(bpmInstant - specBpm) / Math.max(bpmInstant, specBpm), 0, 1);
      if (spectralAgreement < 0.12) {
        rejected.push({
          index: sortedIdx[sortedIdx.length - 1] ?? 0,
          reason: 'SPECTRAL_MISMATCH',
          detector: 'ensemble',
        });
        bpmInstant = null;
      }
    }

    const nE = el.peaks.length || 1;
    const soloEl = sortedSources.filter((s) => s === 'solo_elgendi').length;
    const agreeEl = clamp(soloEl / nE, 0, 1);

    let confidence =
      agreeEl * 0.35 +
      clamp(el.confidence, 0, 1) * 0.35 +
      spectralAgreement * 0.3;

    if (typeof sqi === 'number' && sqi < PEAK_DETECTION_DEFAULTS.minSQI) {
      confidence *= 0.8;
    }
    if (sortedIdx.length > 0) {
      confidence = clamp(confidence + 0.08, 0, 1);
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
          source: sortedSources[i]!,
          elConf: el.confidence,
          ensConf: confidence,
          spectralAgreement,
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
      peakSources: sortedSources,
      peakScores,
      rrIntervalsMs: rr,
      bpmInstant,
      bpmStable: bpmInstant,
      confidence: clamp(confidence, 0, 1),
      agreement: {
        elgendi: agreeEl,
        spectral: spectralAgreement,
        autocorrelation: clamp(spec.score, 0, 1),
      },
      rejectedPeaks: rejected,
      diagnostics: {
        elgendi: el.diagnostics,
        elgendiReason: el.reason,
        spectralBpm: specBpm,
        fusedCount: sortedIdx.length,
        soloEl,
        fusionToleranceMs: tolMs,
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