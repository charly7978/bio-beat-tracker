/**
 * CVSI — Cardiovascular State Inference (orquestador).
 *
 * Motor de razonamiento fisiológico que reemplaza el gate binario "hay dedo /
 * no hay dedo" por una CREENCIA continua sobre el estado cardiovascular. Cada
 * ventana:
 *   1. Estima el periodo cardíaco (del pipeline o por periodograma).
 *   2. Corre el modelo generativo del pulso (predictive coding) → cuán bien se
 *      explica la señal como un latido repetible.
 *   3. Calcula la firma BVP multi-λ, la irregularidad RR y la ectopia.
 *   4. Rastrea el HR con un Kalman adaptativo (con incertidumbre).
 *   5. Propaga la creencia de régimen (switching state-space) con toda la
 *      evidencia → distribución sobre {sin perfusión, sinusal, taqui, bradi,
 *      irregular, ectópico, movimiento}.
 *   6. Emite el estado + una narrativa de razonamiento legible.
 *
 * `perfusionProbability = 1 − P(NO_PERFUSION)` es la medida honesta de "hay una
 * señal cardiovascular real", inferida (no un umbral de forma).
 */
import { clamp } from '../../utils/math';
import { bandLimitedDominantFreq } from '../../modules/signal-processing/shared/dsp';
import { GenerativePulseModel } from './generativePulseModel';
import { AdaptiveStateTracker } from './adaptiveStateTracker';
import { RegimeBeliefEngine, argmaxRegime, beliefEntropy } from './regimeBeliefEngine';
import { computeBvpCoherence, computeRrCv, computeEctopyScore } from './physiologicalPriors';
import { softAnd, smoothstep } from './scoring';
import { buildNarrative } from './reasoningNarrative';
import type { CvsiInput, CvsiState, RegimeEvidence } from './types';

/** Banda cardíaca para el periodograma de respaldo (42–240 bpm). */
const CARDIAC_FMIN_HZ = 0.7;
const CARDIAC_FMAX_HZ = 4.0;

export class CardiovascularStateInference {
  private readonly pulseModel = new GenerativePulseModel();
  private readonly hrTracker = new AdaptiveStateTracker();
  private readonly regimeEngine = new RegimeBeliefEngine();

  reset(): void {
    this.pulseModel.reset();
    this.hrTracker.reset();
    this.regimeEngine.reset();
  }

  /** Infiere el estado cardiovascular para la ventana actual. */
  update(input: CvsiInput): CvsiState {
    const { filtered, fs, timestampMs } = input;

    // --- 1. Periodo cardíaco (muestras): del BPM del pipeline o por periodograma. ---
    let periodSamples = 0;
    let dominantBpm = 0;
    if (input.bpm > 0 && fs > 0) {
      periodSamples = (fs * 60) / input.bpm;
      dominantBpm = input.bpm;
    } else if (filtered.length >= 16 && fs > 0) {
      const dom = bandLimitedDominantFreq(filtered, fs, CARDIAC_FMIN_HZ, CARDIAC_FMAX_HZ);
      if (dom.freqHz > 0) {
        periodSamples = fs / dom.freqHz;
        dominantBpm = dom.freqHz * 60;
      }
    }

    // --- 2. Modelo generativo del pulso (predictive coding). ---
    const generative = this.pulseModel.analyze(filtered, periodSamples);

    // --- 3. Evidencias fisiológicas. ---
    const bvpCoherence = computeBvpCoherence(input.spo2Channels);
    const rrCv = computeRrCv(input.rrIntervalsMs);
    const ectopyScore = computeEctopyScore(input.rrIntervalsMs);

    // --- 4. Rastreo de HR con incertidumbre (Kalman adaptativo). ---
    const observationQuality = softAnd(
      smoothstep(0.2, 0.6, generative.explainedVariance),
      smoothstep(0.25, 0.6, generative.morphologyLikelihood),
      smoothstep(0.12, 0.4, input.periodicity ?? 0),
    );
    const heartRate = this.hrTracker.update(dominantBpm, observationQuality);

    // --- 5. Propagación de creencia de régimen. ---
    const evidence: RegimeEvidence = {
      explainedVariance: generative.explainedVariance,
      morphologyLikelihood: generative.morphologyLikelihood,
      predictionError: generative.predictionError,
      bvpCoherence,
      skewness: input.skewness ?? 0,
      periodicity: input.periodicity ?? 0,
      perfusionIndex: input.perfusionIndex ?? 0,
      motionScore: input.motionScore ?? 0,
      bpm: dominantBpm,
      rrCv,
      ectopyScore,
      fingerDetectionScore: input.fingerDetectionScore ?? 0,
      liveFingerScore: input.liveFingerScore ?? 0,
      ensemblePeakScore: input.ensemblePeakScore ?? 0,
    };
    const regimeBelief = this.regimeEngine.update(evidence);
    const mostLikelyRegime = argmaxRegime(regimeBelief);
    const regimeEntropy = beliefEntropy(regimeBelief);
    const perfusionProbability = clamp(1 - regimeBelief.NO_PERFUSION, 0, 1);

    // --- 6. Estado + narrativa. ---
    const partial: Omit<CvsiState, 'narrative'> = {
      timestampMs,
      regimeBelief,
      mostLikelyRegime,
      regimeEntropy,
      perfusionProbability,
      heartRate,
      generative,
      bvpCoherence,
    };
    return { ...partial, narrative: buildNarrative(partial) };
  }
}

export type {
  CvsiInput,
  CvsiState,
  CardiovascularRegime,
  RegimeBelief,
  HeartRateBelief,
  GenerativePulseDiagnostics,
} from './types';
export { CARDIOVASCULAR_REGIMES } from './types';
export { regimeLabel } from './reasoningNarrative';
