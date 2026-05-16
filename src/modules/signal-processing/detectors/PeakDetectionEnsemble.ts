/**
 * Ensemble de picos PPG: Elgendi + Pan–Tompkins PPG + autocorrelación espectral.
 * Fusión bidireccional con tolerancia temporal (no solo Elgendi → Pan).
 */
import type { PeakDetectionResult } from '../../../types/measurements';
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { clamp } from '../../../utils/math';
import { isPhysiologicalRR } from '../../../utils/physio';
import { bpmFromAutocorr } from '../shared/dsp';
import { scorePeakCandidate } from '../../../lib/measurement/peakScoring';
import { ElgendiPeakDetector } from './ElgendiPeakDetector';
import { PanTompkinsPPGDetector } from './PanTompkinsPPGDetector';

export interface PeakDetectionEnsembleInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  sqi?: number;
  perfusionIndex?: number;
  legacyPeakIndices?: number[];
  allowSoloElgendiFusion?: boolean;
}

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}

type PeakSource = 'dual' | 'solo_elgendi' | 'solo_pan';

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
        agreement: { elgendi: 0, panTompkins: 0, spectral: 0, autocorrelation: 0 },
        rejectedPeaks: [],
        diagnostics: { reason: 'INSUFFICIENT_WINDOW' },
      };
    }

    const el = ElgendiPeakDetector.detect({
      signal,
      timestampsMs,
      samplingRateHz,
      sqi,
    });
    const pt = PanTompkinsPPGDetector.detect({
      signal,
      timestampsMs,
      samplingRateHz,
      sqi,
    });

    const spec = bpmFromAutocorr(signal, samplingRateHz);
    const tolMs = PEAK_DETECTION_DEFAULTS.fusionToleranceMs;
    const allowSolo = allowSoloElgendiFusion !== false;

    const fusedIdx: number[] = [];
    const fusedTimes: number[] = [];
    const peakSources: PeakSource[] = [];
    const usedPan = new Set<number>();
    const usedEl = new Set<number>();
    let dualFused = 0;

    const panTimeAt = (k: number): number => {
      const ip = pt.peaks[k] ?? 0;
      return pt.peakTimes[k] ?? timestampsMs[ip] ?? 0;
    };

    const elTimeAt = (j: number): number => {
      const ie = el.peaks[j] ?? 0;
      return el.peakTimes[j] ?? timestampsMs[ie] ?? 0;
    };

    // Paso 1: picos Elgendi (sistólicos) — emparejar Pan en ventana ±tolMs
    for (let j = 0; j < el.peaks.length; j++) {
      const ie = el.peaks[j]!;
      const te = elTimeAt(j);
      let bestK = -1;
      let bestD = tolMs + 1;
      for (let k = 0; k < pt.peaks.length; k++) {
        if (usedPan.has(k)) continue;
        const d = Math.abs(panTimeAt(k) - te);
        if (d < bestD) {
          bestD = d;
          bestK = k;
        }
      }
      if (bestK >= 0 && bestD <= tolMs) {
        usedPan.add(bestK);
        usedEl.add(j);
        dualFused++;
        fusedIdx.push(clamp(ie, 0, signal.length - 1));
        fusedTimes.push(te);
        peakSources.push('dual');
      } else if (allowSolo && el.confidence >= 0.2) {
        usedEl.add(j);
        fusedIdx.push(clamp(ie, 0, signal.length - 1));
        fusedTimes.push(te);
        peakSources.push('solo_elgendi');
        rejected.push({ index: ie, reason: 'SOLO_ELGENDI_RELAXED', detector: 'Elgendi' });
      } else {
        rejected.push({ index: ie, reason: 'NO_PAN_MATCH', detector: 'Elgendi' });
      }
    }

    // Paso 2: picos Pan sin pareja Elgendi (derivada / pendiente)
    for (let k = 0; k < pt.peaks.length; k++) {
      if (usedPan.has(k)) continue;
      const ip = pt.peaks[k]!;
      const tp = panTimeAt(k);
      let nearEl = false;
      for (let j = 0; j < el.peaks.length; j++) {
        if (Math.abs(elTimeAt(j) - tp) <= tolMs) {
          nearEl = true;
          break;
        }
      }
      if (nearEl) {
        rejected.push({ index: ip, reason: 'ELGENDI_ALREADY_USED', detector: 'PanTompkinsPPG' });
        continue;
      }
      if (allowSolo && pt.confidence >= 0.26 && el.confidence >= 0.08) {
        usedPan.add(k);
        fusedIdx.push(clamp(ip, 0, signal.length - 1));
        fusedTimes.push(tp);
        peakSources.push('solo_pan');
        rejected.push({ index: ip, reason: 'SOLO_PAN_RELAXED', detector: 'PanTompkinsPPG' });
      } else {
        rejected.push({ index: ip, reason: 'NO_ELGENDI_MATCH', detector: 'PanTompkinsPPG' });
      }
    }

    // Orden temporal para RR
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
    const nP = pt.peaks.length || 1;
    const soloEl = sortedSources.filter((s) => s === 'solo_elgendi').length;
    const soloPan = sortedSources.filter((s) => s === 'solo_pan').length;
    const agreeEl = clamp((dualFused * 2 + soloEl) / (nE + nP), 0, 1);
    const agreePan = clamp((dualFused * 2 + soloPan) / (nE + nP), 0, 1);
    const agreeAuto = spec.score;

    let confidence =
      agreeEl * 0.26 +
      agreePan * 0.26 +
      clamp(el.confidence, 0, 1) * 0.2 +
      clamp(pt.confidence, 0, 1) * 0.18 +
      spectralAgreement * 0.1;

    if (typeof sqi === 'number' && sqi < PEAK_DETECTION_DEFAULTS.minSQI) {
      confidence *= 0.8;
    }
    if (dualFused > 0) {
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
          panConf: pt.confidence,
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
        panTompkins: agreePan,
        spectral: spectralAgreement,
        autocorrelation: clamp(spec.score, 0, 1),
      },
      rejectedPeaks: rejected,
      diagnostics: {
        elgendi: el.diagnostics,
        panTompkins: pt.diagnostics,
        elgendiReason: el.reason,
        spectralBpm: specBpm,
        fusedCount: sortedIdx.length,
        dualFused,
        soloEl,
        soloPan,
        fusionToleranceMs: tolMs,
        elgendiConfidence: el.confidence,
        panTompkinsConfidence: pt.confidence,
        fusedPeakTimes: sortedTimes,
        elgendiPeakTimes: el.peakTimes,
        panTompkinsPeakTimes: pt.peakTimes,
      },
    };
  }
}
