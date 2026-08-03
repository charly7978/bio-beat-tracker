import { clamp } from '../../../utils/math';
import { CardiacKnowledge } from './CardiacKnowledge';
import { SignalFeatures } from './SignalAnalyzer';

export interface ReasonedOutput {
  isViableSignal: boolean;
  confidence: number;
  heartRate: number;
  hrConfidence: number;
  arrhythmiaLikelihood: number;
  arrhythmiaType: string;
  signalQuality: string;
  context: ReasonerContext;
}

export interface ReasonerContext {
  featureMemory: FeatureSnapshot[];
  confidenceHistory: number[];
  dominantFreqHistory: number[];
  hrHistory: number[];
  arrhythmiaFlags: number;
  totalWindow: number;
}

interface FeatureSnapshot {
  time: number;
  confidence: number;
  perfusionIndex: number;
  cardiacPowerRatio: number;
  beatConsistency: number;
  hr: number;
}

interface PerfusionScore {
  score: number;
  reason: string;
}

interface FrequencyScore {
  score: number;
  reason: string;
  hr: number;
}

interface MorphologyScore {
  score: number;
  reason: string;
}

interface ArrhythmiaResult {
  likelihood: number;
  type: string;
}

export class CardiacReasoner {
  private context: ReasonerContext;
  private readonly MAX_WINDOW = 120;
  private readonly MIN_WINDOW_FOR_CONVERGENCE = 6;

  constructor() {
    this.context = {
      featureMemory: [],
      confidenceHistory: [],
      dominantFreqHistory: [],
      hrHistory: [],
      arrhythmiaFlags: 0,
      totalWindow: 0,
    };
  }

  reason(
    features: SignalFeatures,
    peakIndices: number[],
    timestamps: number[],
    currentTime: number,
  ): ReasonedOutput {
    const perfusion = this.scorePerfusion(features);
    const freq = this.scoreFrequency(features);
    const morphology = this.scoreMorphology(features, peakIndices, timestamps);
    const arrhythmia = this.scoreArrhythmia(peakIndices, timestamps);

    const hr = this.resolveHeartRate(features, freq.hr, peakIndices, timestamps);
    const hrConfidence = this.computeHrConfidence(features, hr, peakIndices, timestamps);

    const weights = this.computeAdaptiveWeights(features, timestamps);
    const rawConfidence =
      perfusion.score * weights.perfusion +
      freq.score * weights.frequency +
      morphology.score * weights.morphology +
      this.scoreCrossChannel(features) * weights.crossChannel;

    const confidence = clamp(rawConfidence, 0, 1);
    const isViableSignal = this.evaluateViability(confidence, features);

    this.accumulateContext({
      time: currentTime,
      confidence,
      perfusionIndex: features.perfusion.perfusionIndex,
      cardiacPowerRatio: features.frequency.cardiacPowerRatio,
      beatConsistency: features.morphology.beatConsistency,
      hr,
    });

    const signalQuality = this.assessSignalQuality(confidence);

    return {
      isViableSignal,
      confidence,
      heartRate: hr,
      hrConfidence,
      arrhythmiaLikelihood: arrhythmia.likelihood,
      arrhythmiaType: arrhythmia.type,
      signalQuality,
      context: this.context,
    };
  }

  private scorePerfusion(features: SignalFeatures): PerfusionScore {
    const pi = features.perfusion.perfusionIndex;
    const kn = CardiacKnowledge.PPG_SIGNAL.acDcRatio;

    if (pi <= 0) return { score: 0, reason: 'no_perfusion' };

    const piExpected = kn.min * 100;
    const piMax = kn.max * 100;

    if (pi >= piExpected && pi <= piMax) {
      return { score: 1.0, reason: 'normal_perfusion' };
    }

    if (pi < piExpected) {
      const score = clamp(pi / piExpected, 0, 0.9);
      return { score, reason: 'low_perfusion' };
    }

    const score = clamp(1 - (pi - piMax) / piMax, 0.1, 0.9);
    return { score, reason: 'high_perfusion' };
  }

  private scoreFrequency(features: SignalFeatures): FrequencyScore {
    const freq = features.frequency;

    if (freq.totalPower <= 0) {
      return { score: 0, reason: 'no_frequency_content', hr: 0 };
    }

    const cardiacRatio = freq.cardiacPowerRatio;

    if (cardiacRatio > 0.5) {
      const hr = freq.dominantFreqHz * 60;
      if (hr >= CardiacKnowledge.CARDIA_CYCLE.normalHeartRateBpm.min &&
          hr <= CardiacKnowledge.CARDIA_CYCLE.normalHeartRateBpm.max) {
        return { score: 1.0, reason: 'strong_cardiac_band', hr };
      }
      if (hr >= CardiacKnowledge.CARDIA_CYCLE.fullRangeBpm.min &&
          hr <= CardiacKnowledge.CARDIA_CYCLE.fullRangeBpm.max) {
        return { score: 0.8, reason: 'cardiac_band_extreme', hr };
      }
      return { score: 0.3, reason: 'cardiac_band_out_of_range', hr };
    }

    if (cardiacRatio > 0.2) {
      const hr = freq.dominantFreqHz * 60;
      return { score: 0.4, reason: 'moderate_cardiac_band', hr };
    }

    return { score: 0.15, reason: 'weak_cardiac_band', hr: 0 };
  }

  private scoreMorphology(
    features: SignalFeatures,
    peakIndices: number[],
    timestamps: number[],
  ): MorphologyScore {
    if (peakIndices.length < 3) {
      return { score: 0.1, reason: 'insufficient_beats' };
    }

    const consistency = features.morphology.beatConsistency;
    const template = features.morphology.templateMatch;

    if (consistency > 0.8 && template > 0.8) {
      return { score: 1.0, reason: 'highly_consistent' };
    }

    const avg = (consistency + template) / 2;

    if (avg > 0.6) return { score: 0.8, reason: 'moderately_consistent' };
    if (avg > 0.4) return { score: 0.5, reason: 'somewhat_consistent' };
    if (avg > 0.2) return { score: 0.3, reason: 'low_consistency' };

    return { score: 0.1, reason: 'no_consistency' };
  }

  private scoreCrossChannel(features: SignalFeatures): number {
    const cc = features.crossChannel;

    if (cc.rChannelCorrelation === 0 && cc.gChannelCorrelation === 0 && cc.bChannelCorrelation === 0) {
      return 0.5;
    }

    const avg = (Math.abs(cc.rChannelCorrelation) + Math.abs(cc.gChannelCorrelation) + Math.abs(cc.bChannelCorrelation)) / 3;
    return clamp(avg, 0, 1);
  }

  private scoreArrhythmia(peakIndices: number[], timestamps: number[]): ArrhythmiaResult {
    const minLen = CardiacKnowledge.ARRHYTHMIA.minIntervalsForDetection;
    if (peakIndices.length < minLen) {
      return { likelihood: 0, type: 'pending' };
    }

    const rrs: number[] = [];
    for (let i = 1; i < peakIndices.length; i++) {
      const pi = peakIndices[i] ?? 0;
      const pj = peakIndices[i - 1] ?? 0;
      const rr = (timestamps[pi] ?? 0) - (timestamps[pj] ?? 0);
      if (rr > 0) rrs.push(rr);
    }

    if (rrs.length < 4) return { likelihood: 0, type: 'pending' };

    const sorted = [...rrs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 1;
    if (median <= 0) return { likelihood: 0, type: 'pending' };

    let deviations = 0;
    let shortBeats = 0;
    let longBeats = 0;
    for (const rr of rrs) {
      const ratio = rr / median;
      if (Math.abs(ratio - 1) > CardiacKnowledge.ARRHYTHMIA.prematureBeatRrRatio) {
        deviations++;
      }
      if (ratio < CardiacKnowledge.ARRHYTHMIA.prematureBeatRrRatio) {
        shortBeats++;
      }
      if (ratio > CardiacKnowledge.ARRHYTHMIA.compensatoryPauseRatio) {
        longBeats++;
      }
    }

    const deviationRatio = deviations / rrs.length;

    const hrvStd = this.std(rrs);
    const hrvPercent = (hrvStd / median) * 100;

    if (hrvPercent > CardiacKnowledge.ARRHYTHMIA.atrialFibrillationThreshold * 100) {
      return { likelihood: 0.9, type: 'atrial_fibrillation' };
    }

    if (shortBeats > 0 && longBeats > 0 && deviationRatio > 0.2) {
      return { likelihood: 0.7, type: 'premature_complexes' };
    }

    if (hrvPercent > CardiacKnowledge.ARRHYTHMIA.normalHrvPercent.max) {
      return { likelihood: 0.4, type: 'irregular_rhythm' };
    }

    return { likelihood: 0, type: 'normal_sinus' };
  }

  private resolveHeartRate(
    features: SignalFeatures,
    freqHr: number,
    peakIndices: number[],
    timestamps: number[],
  ): number {
    const rrs: number[] = [];
    for (let i = 1; i < peakIndices.length; i++) {
      const pi = peakIndices[i] ?? 0;
      const pj = peakIndices[i - 1] ?? 0;
      const rr = (timestamps[pi] ?? 0) - (timestamps[pj] ?? 0);
      if (rr > 0) rrs.push(rr);
    }

    let peakHr = 0;
    if (rrs.length > 0) {
      const avgRr = rrs.reduce((a, b) => a + b, 0) / rrs.length;
      peakHr = avgRr > 0 ? 60000 / avgRr : 0;
    }

    if (freqHr > 0 && peakHr > 0) {
      const diff = Math.abs(freqHr - peakHr) / Math.max(freqHr, peakHr);
      if (diff < 0.15) {
        return Math.round((freqHr + peakHr) / 2);
      }
      if (features.frequency.cardiacPowerRatio > 0.5) {
        return Math.round(freqHr);
      }
      return Math.round(peakHr);
    }

    if (freqHr > 0) return Math.round(freqHr);
    if (peakHr > 0) return Math.round(peakHr);
    return 0;
  }

  private computeHrConfidence(
    features: SignalFeatures,
    hr: number,
    peakIndices: number[],
    timestamps: number[],
  ): number {
    if (hr <= 0) return 0;

    if (hr < CardiacKnowledge.CARDIA_CYCLE.fullRangeBpm.min ||
        hr > CardiacKnowledge.CARDIA_CYCLE.fullRangeBpm.max) {
      return 0;
    }

    let match = 0;
    const rrs: number[] = [];
    for (let i = 1; i < peakIndices.length; i++) {
      const pi = peakIndices[i] ?? 0;
      const pj = peakIndices[i - 1] ?? 0;
      const rr = (timestamps[pi] ?? 0) - (timestamps[pj] ?? 0);
      if (rr > 0) rrs.push(rr);
    }

    if (rrs.length > 1) {
      const hrvStd = this.std(rrs);
      const meanRr = rrs.reduce((a, b) => a + b, 0) / rrs.length;
      const hrvPercent = meanRr > 0 ? (hrvStd / meanRr) * 100 : 0;

      if (hrvPercent >= CardiacKnowledge.CARDIA_CYCLE.hrvPercent.min &&
          hrvPercent <= CardiacKnowledge.CARDIA_CYCLE.hrvPercent.max) {
        match = 1;
      } else if (hrvPercent < CardiacKnowledge.CARDIA_CYCLE.hrvPercent.min) {
        match = clamp(hrvPercent / CardiacKnowledge.CARDIA_CYCLE.hrvPercent.min, 0, 1);
      } else {
        match = clamp(1 - (hrvPercent - CardiacKnowledge.CARDIA_CYCLE.hrvPercent.max) / 30, 0, 1);
      }
    }

    const freqConfidence = features.frequency.cardiacPowerRatio;
    const combined = (freqConfidence * 0.5 + match * 0.3 + features.morphology.beatConsistency * 0.2);
    return clamp(combined, 0, 1);
  }

  private computeAdaptiveWeights(
    features: SignalFeatures,
    timestamps: number[],
  ): { perfusion: number; frequency: number; morphology: number; crossChannel: number } {
    const totalWindow = this.context.totalWindow;

    if (totalWindow < 10) {
      return { perfusion: 0.4, frequency: 0.4, morphology: 0.1, crossChannel: 0.1 };
    }

    const perfusionIsStable = this.isTrendStable(
      this.context.featureMemory.map(f => f.perfusionIndex),
    );

    const freqIsStable = this.isTrendStable(
      this.context.featureMemory.map(f => f.cardiacPowerRatio),
    );

    let wPerfusion = 0.25;
    let wFrequency = 0.35;
    let wMorphology = 0.25;
    let wCrossChannel = 0.15;

    if (perfusionIsStable < 0.5) wPerfusion *= 0.7;
    if (freqIsStable < 0.5) wFrequency *= 0.8;
    if (features.morphology.beatConsistency > 0.8) wMorphology *= 1.3;

    const total = wPerfusion + wFrequency + wMorphology + wCrossChannel;
    return {
      perfusion: wPerfusion / total,
      frequency: wFrequency / total,
      morphology: wMorphology / total,
      crossChannel: wCrossChannel / total,
    };
  }

  private evaluateViability(confidence: number, features: SignalFeatures): boolean {
    if (this.context.totalWindow < this.MIN_WINDOW_FOR_CONVERGENCE) {
      return false;
    }

    if (confidence > 0.6) return true;
    if (confidence > 0.35) {
      const trend = this.confidenceTrend();
      return trend > 0;
    }
    return false;
  }

  private assessSignalQuality(confidence: number): string {
    if (confidence > 0.8) return 'excellent';
    if (confidence > 0.6) return 'good';
    if (confidence > 0.4) return 'fair';
    if (confidence > 0.2) return 'poor';
    return 'unusable';
  }

  confidenceTrend(): number {
    const h = this.context.confidenceHistory;
    if (h.length < 4) return 0;
    const recent = h.slice(-4);
    const half = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, half);
    const secondHalf = recent.slice(half);
    const mean1 = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const mean2 = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    return mean2 - mean1;
  }

  private accumulateContext(snapshot: FeatureSnapshot): void {
    this.context.featureMemory.push(snapshot);
    this.context.confidenceHistory.push(snapshot.confidence);
    this.context.hrHistory.push(snapshot.hr);

    if (this.context.featureMemory.length > this.MAX_WINDOW) {
      this.context.featureMemory.shift();
      this.context.confidenceHistory.shift();
      this.context.dominantFreqHistory.shift();
      this.context.hrHistory.shift();
    }

    this.context.totalWindow++;
  }

  confidenceMean(window?: number): number {
    const h = this.context.confidenceHistory;
    if (h.length === 0) return 0;
    const slice = window ? h.slice(-window) : h;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  private isTrendStable(values: number[]): number {
    if (values.length < 4) return 0.5;
    const recent = values.slice(-8);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (mean === 0) return 0;
    const maxDev = Math.max(...recent.map(v => Math.abs(v - mean)));
    const stability = 1 - clamp(maxDev / mean, 0, 1);
    return stability;
  }

  private std(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sqDiffs = values.map(v => (v - mean) ** 2);
    return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / (values.length - 1));
  }

  reset(): void {
    this.context = {
      featureMemory: [],
      confidenceHistory: [],
      dominantFreqHistory: [],
      hrHistory: [],
      arrhythmiaFlags: 0,
      totalWindow: 0,
    };
  }
}
