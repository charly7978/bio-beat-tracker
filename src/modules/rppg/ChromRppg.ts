import type { RgbFrame, RppgConfig } from './types';

const DEFAULT_CONFIG: RppgConfig = {
  windowSize: 150,
  sampleRate: 30,
  chromAlpha: 1.0,
  posThreshold: 0.1,
};

export class ChromRppg {
  private buffer: RgbFrame[] = [];
  private config: RppgConfig;
  private chromSignal: number[] = [];
  private lastBpm = 0;
  private lastConfidence = 0;

  constructor(config?: Partial<RppgConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  feed(frame: RgbFrame): void {
    this.buffer.push(frame);
    if (this.buffer.length > this.config.windowSize) {
      this.buffer.shift();
    }
  }

  process(): { pulse: number; bpm: number; confidence: number; chrom: number[] } {
    const n = this.buffer.length;
    if (n < 30) {
      return { pulse: 0, bpm: 0, confidence: 0, chrom: [] };
    }

    const r = this.buffer.map((f) => f.r);
    const g = this.buffer.map((f) => f.g);
    const b = this.buffer.map((f) => f.b);

    // Normalize by DC
    const rMean = r.reduce((a, v) => a + v, 0) / n;
    const gMean = g.reduce((a, v) => a + v, 0) / n;
    const bMean = b.reduce((a, v) => a + v, 0) / n;

    const rNorm = r.map((v) => v / rMean);
    const gNorm = g.map((v) => v / gMean);
    const bNorm = b.map((v) => v / bMean);

    // CHROM projection
    // S1 = rNorm - gNorm
    // S2 = rNorm + gNorm - 2 * bNorm
    const s1 = rNorm.map((v, i) => v - gNorm[i]);
    const s2 = rNorm.map((v, i) => v + gNorm[i] - 2 * bNorm[i]);

    // Bandpass filter (simple detrend + BP)
    const filtered1 = this.bandpassFilter(s1);
    const filtered2 = this.bandpassFilter(s2);

    // Alpha: ratio of standard deviations (minimizes motion)
    const std1 = this.std(filtered1);
    const std2 = this.std(filtered2);
    const alpha = std2 > 0 ? std1 / std2 : 1;

    // Pulse = S1 - alpha * S2
    const pulse = filtered1.map((v, i) => v - alpha * filtered2[i]);

    this.chromSignal = pulse;

    // Estimate heart rate from last 256 samples of pulse
    const bpm = this.estimateHeartRate(pulse, this.config.sampleRate);
    this.lastBpm = bpm;

    // Confidence based on pulse quality
    const confidence = this.calculateConfidence(pulse, filtered1, filtered2);
    this.lastConfidence = confidence;

    return {
      pulse: pulse[pulse.length - 1] ?? 0,
      bpm,
      confidence,
      chrom: pulse,
    };
  }

  getLastBpm(): number {
    return this.lastBpm;
  }

  getLastConfidence(): number {
    return this.lastConfidence;
  }

  getSignal(): number[] {
    return [...this.chromSignal];
  }

  reset(): void {
    this.buffer = [];
    this.chromSignal = [];
    this.lastBpm = 0;
    this.lastConfidence = 0;
  }

  private bandpassFilter(signal: number[]): number[] {
    const fs = this.config.sampleRate;
    const detrended = this.detrend(signal);
    const smoothed = this.movingAverage(detrended, Math.round(fs / 8));
    return smoothed;
  }

  private detrend(signal: number[]): number[] {
    const n = signal.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const xMean = x.reduce((a, v) => a + v, 0) / n;
    const yMean = signal.reduce((a, v) => a + v, 0) / n;

    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (x[i] - xMean) * (signal[i] - yMean);
      den += (x[i] - xMean) ** 2;
    }

    const slope = den > 0 ? num / den : 0;
    const intercept = yMean - slope * xMean;

    return signal.map((v, i) => v - (slope * x[i] + intercept));
  }

  private movingAverage(signal: number[], window: number): number[] {
    if (window < 2) return [...signal];
    const result: number[] = [];
    let sum = 0;
    for (let i = 0; i < signal.length; i++) {
      sum += signal[i]!;
      if (i >= window) sum -= signal[i - window]!;
      if (i >= window - 1) result.push(sum / window);
    }
    return result;
  }

  private std(signal: number[]): number {
    const n = signal.length;
    if (n < 2) return 0;
    const mean = signal.reduce((a, v) => a + v, 0) / n;
    const variance = signal.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
    return Math.sqrt(variance);
  }

  private estimateHeartRate(pulse: number[], fs: number): number {
    const n = pulse.length;
    if (n < fs * 2) return 0;

    const recent = pulse.slice(-Math.min(n, fs * 8));
    const mean = recent.reduce((a, v) => a + v, 0) / recent.length;
    const centered = recent.map((v) => v - mean);

    // Autocorrelation
    const minLag = Math.max(4, Math.round(fs * 60 / 200));
    const maxLag = Math.min(centered.length - 1, Math.round(fs * 60 / 38));

    let bestLag = 0;
    let bestScore = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0;
      let eA = 0;
      let eB = 0;
      for (let i = lag; i < centered.length; i++) {
        cross += centered[i] * centered[i - lag];
        eA += centered[i] ** 2;
        eB += centered[i - lag] ** 2;
      }
      if (eA === 0 || eB === 0) continue;
      const corr = cross / Math.sqrt(eA * eB);
      if (corr > bestScore) {
        bestScore = corr;
        bestLag = lag;
      }
    }

    if (bestLag === 0 || bestScore < 0.15) return 0;
    return Math.round((60 * fs) / bestLag);
  }

  private calculateConfidence(pulse: number[], s1: number[], _s2: number[]): number {
    const pulseEnergy = pulse.reduce((a, v) => a + v * v, 0);
    const s1Energy = s1.reduce((a, v) => a + v * v, 0) + 1e-8;
    const snr = pulseEnergy / s1Energy;

    const peakRatio = Math.min(1, snr * 5);
    const periodicity = this.estimateHeartRate(pulse, this.config.sampleRate) > 0 ? 0.6 : 0;

    return Math.min(1, peakRatio * 0.6 + periodicity * 0.4);
  }
}
