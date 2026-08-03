import { clamp } from '../../../utils/math';
import { SignalFeatures } from './SignalAnalyzer';
import { CardiacKnowledge } from './CardiacKnowledge';

export interface TechnicalState {
  snr: number;
  motionLevel: number;
  lightingLevel: number;
  cameraStability: number;
  adaptationFactor: number;
  recommendations: string[];
}

export class TechnicalAdapter {
  private previousSignal: number[] = [];
  private motionHistory: number[] = [];
  private readonly MAX_HISTORY = 30;

  estimateState(
    signal: number[],
    features: SignalFeatures,
  ): TechnicalState {
    const snr = this.estimateSnr(signal, features);
    const motion = this.estimateMotion(signal);
    const lighting = this.estimateLighting(features);
    const stability = this.estimateCameraStability(features);
    const adaptation = this.computeAdaptation(snr, motion, lighting);

    return {
      snr,
      motionLevel: motion,
      lightingLevel: lighting,
      cameraStability: stability,
      adaptationFactor: adaptation,
      recommendations: this.generateRecommendations(snr, motion, lighting, stability),
    };
  }

  private estimateSnr(signal: number[], features: SignalFeatures): number {
    if (signal.length < 10) return 0;

    const cardiacPower = features.frequency.bandPower0_5_4Hz;
    const totalPower = features.frequency.totalPower;
    const noisePower = totalPower - cardiacPower;

    if (noisePower <= 0) return 20;

    const snrLinear = cardiacPower / noisePower;
    const snrDb = 10 * Math.log10(Math.max(snrLinear, 1e-10));
    return clamp(snrDb, -10, 40);
  }

  private estimateMotion(signal: number[]): number {
    if (this.previousSignal.length > 0 && signal.length > 0) {
      const len = Math.min(signal.length, this.previousSignal.length);
      let diffSum = 0;
      for (let i = 0; i < len; i++) {
        diffSum += Math.abs((signal[i] ?? 0) - (this.previousSignal[i] ?? 0));
      }
      const motion = diffSum / len;

      this.motionHistory.push(motion);
      if (this.motionHistory.length > this.MAX_HISTORY) {
        this.motionHistory.shift();
      }
    }

    this.previousSignal = [...signal];

    if (this.motionHistory.length < 2) return 0;

    const meanMotion = this.motionHistory.reduce((a, b) => a + b, 0) / this.motionHistory.length;
    const baseline = this.motionHistory[0] ?? meanMotion;
    const relativeMotion = baseline > 0 ? meanMotion / baseline : 1;

    return clamp(relativeMotion / 5, 0, 1);
  }

  private estimateLighting(features: SignalFeatures): number {
    const dc = features.perfusion.dcLevel;

    if (dc <= 0) return 0;

    if (dc > 0.3 && dc < 0.8) return 1;
    if (dc > 0.1 && dc < 0.95) return 0.7;
    if (dc > 0.05) return 0.4;
    if (dc > 0.02) return 0.2;

    return 0.1;
  }

  private estimateCameraStability(features: SignalFeatures): number {
    const crossChannelVariation =
      Math.abs(features.crossChannel.rChannelCorrelation) +
      Math.abs(features.crossChannel.gChannelCorrelation) +
      Math.abs(features.crossChannel.bChannelCorrelation);

    const stability = crossChannelVariation / 3;
    return clamp(stability, 0, 1);
  }

  private computeAdaptation(
    snr: number,
    motion: number,
    lighting: number,
  ): number {
    if (snr < 5) return 0.2;
    if (snr < 10) return 0.4;

    const motionPenalty = motion > 0.5 ? 0.5 : motion > 0.3 ? 0.75 : 1;
    const lightingBonus = lighting > 0.6 ? 1 : lighting > 0.3 ? 0.8 : 0.5;

    return clamp(0.5 * (snr / 20) * motionPenalty * lightingBonus, 0.1, 1);
  }

  private generateRecommendations(
    snr: number,
    motion: number,
    lighting: number,
    stability: number,
  ): string[] {
    const recs: string[] = [];

    if (snr < 10) recs.push('Increase lighting or reduce movement');
    if (motion > 0.5) recs.push('Hold device steady');
    if (lighting < 0.3) recs.push('Move to brighter area');
    if (stability < 0.3) recs.push('Improve finger placement on camera');

    return recs;
  }

  reset(): void {
    this.previousSignal = [];
    this.motionHistory = [];
  }
}
