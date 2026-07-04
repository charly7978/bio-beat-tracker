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
import { MsptdPeakDetector, type MsptdPeakDetectorOutput } from './MsptdPeakDetector';

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
    const elgendiIdx = order.map((i) => peakIdx[i]!);
    const elgendiTimes = order.map((i) => peakTimes[i]!);

    // === SEGUNDO DETECTOR DEL ENSEMBLE: MSPTD/AMPD ===
    // Corre en paralelo a Elgendi sobre la misma señal y se fusiona por consenso
    // temporal. Confirmación mutua ⇒ más precisión; rescate en huecos ⇒ más
    // recall (latidos que el umbral de Elgendi perdió). Ver PEAK_DETECTION_DEFAULTS.MSPTD.
    const M = PEAK_DETECTION_DEFAULTS.MSPTD;
    const ms = M.ENABLED
      ? MsptdPeakDetector.detect({ signal, timestampsMs, samplingRateHz: fsEffective, sqi })
      : null;
    const msTimes = ms?.peakTimes ?? [];

    let consensusCount = 0;
    if (msTimes.length && elgendiTimes.length) {
      for (const t of elgendiTimes) {
        if (msTimes.some((mt) => Math.abs(mt - t) <= M.FUSE_TOLERANCE_MS)) consensusCount++;
      }
    }
    const consensusRatio = elgendiTimes.length ? consensusCount / elgendiTimes.length : 0;

    const fused = fuseDetectors({ elgendiIdx, elgendiTimes, ms, timestampsMs, sqi: sqi ?? 0 });
    const sortedIdx = fused.fusedIdx;
    const sortedTimes = fused.fusedTimes;

    const rr: number[] = [];
    for (let i = 1; i < sortedTimes.length; i++) {
      const d = sortedTimes[i] - sortedTimes[i - 1];
      if (isPhysiologicalRR(d)) rr.push(d);
    }

    const bpmInstant: number | null = rr.length ? 60000 / median(rr.slice(-4)) : null;

    const nE = el.peaks.length || 1;
    const agreeEl = clamp(sortedTimes.length / nE, 0, 1);
    const agreeMs = msTimes.length ? clamp(consensusCount / Math.max(1, msTimes.length), 0, 1) : 0;

    let confidence =
      agreeEl * 0.50 +
      clamp(el.confidence, 0, 1) * 0.50;

    // Bonus por consenso: latidos vistos por AMBOS detectores son más fiables.
    // Sólo suma (nunca penaliza) → no degrada casos ya buenos ni el ruido.
    confidence = clamp(confidence + consensusRatio * M.CONSENSUS_CONF_BONUS, 0, 1);

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
        msptd: agreeMs,
        consensus: consensusRatio,
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
        msptd: ms?.diagnostics,
        msptdReason: ms?.reason,
        msptdPeakTimes: msTimes,
        msptdConfidence: ms?.confidence ?? 0,
        consensusCount,
        consensusRatio,
        recoveredBeats: fused.recovered,
        adoptedMsptd: fused.adopted,
        fsDeclared: samplingRateHz,
        fsEffective,
        fsAdapted,
      },
    };
  }
}

interface FuseInput {
  elgendiIdx: number[];
  elgendiTimes: number[];
  ms: MsptdPeakDetectorOutput | null;
  timestampsMs: number[];
  sqi: number;
}

interface FuseResult {
  fusedIdx: number[];
  fusedTimes: number[];
  /** Nº de latidos rescatados de huecos por MSPTD. */
  recovered: number;
  /** true si se adoptó el set de MSPTD (Elgendi demasiado débil). */
  adopted: boolean;
}

/**
 * Fusiona los picos de Elgendi (base) con los de MSPTD:
 *  - Elgendi débil (<2 picos) + MSPTD con set periódico fiable ⇒ ADOPTA MSPTD.
 *  - En huecos > 1.5× la mediana RR se RESCATA el pico de MSPTD mejor colocado
 *    (RR plausible con ambos vecinos, fuera de tolerancia de un pico ya presente).
 * Sin señal usable (SQI bajo) se devuelve Elgendi tal cual → nunca inventa picos.
 */
function fuseDetectors(input: FuseInput): FuseResult {
  const { elgendiIdx, elgendiTimes, ms, timestampsMs, sqi } = input;
  const base: FuseResult = {
    fusedIdx: [...elgendiIdx],
    fusedTimes: [...elgendiTimes],
    recovered: 0,
    adopted: false,
  };
  const M = PEAK_DETECTION_DEFAULTS.MSPTD;
  if (!ms || ms.peakTimes.length === 0 || sqi < PEAK_DETECTION_DEFAULTS.minSQI) return base;

  // Adopción: Elgendi casi no vio nada pero MSPTD sí (caso difícil).
  if (
    elgendiTimes.length < 2 &&
    ms.peakTimes.length >= 3 &&
    ms.confidence >= M.ADOPT_MIN_CONFIDENCE
  ) {
    return { fusedIdx: [...ms.peaks], fusedTimes: [...ms.peakTimes], recovered: 0, adopted: true };
  }

  if (elgendiTimes.length < 2) return base;

  // Rescate en huecos.
  const sortedRr = [...elgendiTimes]
    .slice(1)
    .map((t, i) => t - elgendiTimes[i])
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const medRr = sortedRr.length ? sortedRr[Math.floor(sortedRr.length / 2)]! : 0;
  if (medRr <= 0) return base;

  const minRr = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS;
  const outTimes = [...elgendiTimes];
  const outIdx = [...elgendiIdx];
  let recovered = 0;

  for (let i = 1; i < elgendiTimes.length; i++) {
    const tA = elgendiTimes[i - 1]!;
    const tB = elgendiTimes[i]!;
    if (tB - tA <= medRr * M.GAP_RECOVERY_RR_FACTOR) continue;

    // Mejor candidato MSPTD dentro del hueco, con RR plausible a ambos lados.
    let bestT = 0;
    let bestErr = Infinity;
    for (const mt of ms.peakTimes) {
      if (mt <= tA + minRr || mt >= tB - minRr) continue;
      if (Math.abs(mt - tA) < M.FUSE_TOLERANCE_MS || Math.abs(mt - tB) < M.FUSE_TOLERANCE_MS) continue;
      // Cercanía al latido esperado (tA + medianRR) → el más fisiológico.
      const err = Math.abs(mt - (tA + medRr));
      if (err < bestErr) {
        bestErr = err;
        bestT = mt;
      }
    }
    if (bestT > 0) {
      outTimes.push(bestT);
      outIdx.push(nearestIndexByTime(timestampsMs, bestT));
      recovered++;
    }
  }

  if (recovered === 0) return base;

  const ord = outTimes
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t - b.t)
    .map((o) => o.i);
  return {
    fusedIdx: ord.map((i) => outIdx[i]!),
    fusedTimes: ord.map((i) => outTimes[i]!),
    recovered,
    adopted: false,
  };
}

/** Índice de `timestamps` más cercano en tiempo a `t`. */
function nearestIndexByTime(timestamps: number[], t: number): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const d = Math.abs(timestamps[i] - t);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}