/**
 * Ensemble de picos PPG: Elgendi + Pan–Tompkins PPG + autocorrelación espectral.
 * `legacyPeaks` opcional permite alinear con un detector previo sin duplicar lógica.
 */
import type { PeakDetectionResult } from '../../../types/measurements';
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';
import { clamp } from '../../../utils/math';
import { bpmFromAutocorr } from '../shared/dsp';
import { ElgendiPeakDetector } from './ElgendiPeakDetector';
import { PanTompkinsPPGDetector } from './PanTompkinsPPGDetector';

export interface PeakDetectionEnsembleInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  sqi?: number;
  /** Picos índice heredados (p.ej. morfología local) — opcional */
  legacyPeakIndices?: number[];
}

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export class PeakDetectionEnsemble {
  static analyze(input: PeakDetectionEnsembleInput): PeakDetectionResult {
    const rejected: PeakDetectionResult['rejectedPeaks'] = [];
    const { signal, timestampsMs, samplingRateHz, sqi } = input;

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

    const tolMs = 135;
    const fusedIdx: number[] = [];
    const fusedTimes: number[] = [];

    const usedPan = new Set<number>();
    for (const ie of el.peaks) {
      const te = timestampsMs[ie] ?? 0;
      let bestJ = -1;
      let bestD = tolMs + 1;
      for (let k = 0; k < pt.peaks.length; k++) {
        if (usedPan.has(k)) continue;
        const ip = pt.peaks[k];
        const tp = timestampsMs[ip] ?? 0;
        const d = Math.abs(tp - te);
        if (d < bestD) {
          bestD = d;
          bestJ = k;
        }
      }
      if (bestJ >= 0 && bestD <= tolMs) {
        usedPan.add(bestJ);
        const ip = pt.peaks[bestJ];
        const mid = Math.round((ie + ip) / 2);
        fusedIdx.push(clamp(mid, 0, signal.length - 1));
        fusedTimes.push((timestampsMs[ie]! + timestampsMs[ip]!) / 2);
      } else {
        rejected.push({ index: ie, reason: 'NO_PAN_MATCH', detector: 'Elgendi' });
      }
    }

    for (let k = 0; k < pt.peaks.length; k++) {
      if (usedPan.has(k)) continue;
      const ip = pt.peaks[k];
      rejected.push({ index: ip, reason: 'NO_ELGENDI_MATCH', detector: 'PanTompkinsPPG' });
    }

    const rr: number[] = [];
    for (let i = 1; i < fusedTimes.length; i++) {
      const d = fusedTimes[i] - fusedTimes[i - 1];
      if (d > 250 && d < 2200) rr.push(d);
    }

    let bpmInstant: number | null = rr.length ? 60000 / median(rr.slice(-4)) : null;
    const specBpm = spec.bpm > 0 ? spec.bpm : null;

    // Guarda anti-alias (½× o 2×) cuando la fusión estricta pierde latidos alternos
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
      if (spectralAgreement < PEAK_DETECTION_DEFAULTS.spectralAgreementMin) {
        if (bpmInstant) rejected.push({ index: fusedIdx[fusedIdx.length - 1] ?? 0, reason: 'SPECTRAL_MISMATCH', detector: 'ensemble' });
        bpmInstant = spectralAgreement > 0.18 ? bpmInstant : null;
      }
    }

    const nE = el.peaks.length || 1;
    const nP = pt.peaks.length || 1;
    const nF = fusedIdx.length || 1;
    const agreeEl = clamp((usedPan.size * 2) / (nE + nP), 0, 1);
    const agreePan = agreeEl;
    const agreeAuto = spec.score;

    let confidence =
      agreeEl * 0.28 +
      agreePan * 0.28 +
      clamp(el.confidence, 0, 1) * 0.18 +
      clamp(pt.confidence, 0, 1) * 0.16 +
      spectralAgreement * 0.1;

    if (typeof sqi === 'number' && sqi < PEAK_DETECTION_DEFAULTS.minSQI) {
      confidence *= 0.72;
    }

    const bpmStable = bpmInstant;

    return {
      peaks: fusedIdx,
      peakTimes: fusedTimes,
      rrIntervalsMs: rr,
      bpmInstant,
      bpmStable,
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
        fusedCount: fusedIdx.length,
        /** Tiempos (performance.now) para overlay en PPGSignalMeter */
        fusedPeakTimes: fusedTimes,
        elgendiPeakTimes: el.peakTimes,
        panTompkinsPeakTimes: pt.peakTimes,
      },
    };
  }
}
