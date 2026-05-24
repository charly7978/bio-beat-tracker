import type { RgbFrame, RppgConfig } from './types';

const DEFAULT_CONFIG: RppgConfig = {
  windowSize: 150,
  sampleRate: 30,
  chromAlpha: 1.0,
  posThreshold: 0.1,
};

export class PosRppg {
  private buffer: RgbFrame[] = [];
  private config: RppgConfig;
  private posSignal: number[] = [];
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

  process(): { pulse: number; bpm: number; confidence: number } {
    const n = this.buffer.length;
    if (n < 30) {
      return { pulse: 0, bpm: 0, confidence: 0 };
    }

    const r = this.buffer.map((f) => f.r);
    const g = this.buffer.map((f) => f.g);
    const b = this.buffer.map((f) => f.b);

    // Normalize each channel (zero mean, unit variance)
    const rNorm = this.normalize(r);
    const gNorm = this.normalize(g);
    const bNorm = this.normalize(b);

    // POS projection
    // X = 0*R + 1*G - 1*B = G - B
    // Y = -2*R + 1*G + 1*B = -2R + G + B
    const X = rNorm.map((_, i) => gNorm[i] - bNorm[i]);
    const Y = rNorm.map((v, i) => -2 * v + gNorm[i] + bNorm[i]);

    // Standard deviations
    const stdX = this.std(X);
    const stdY = this.std(Y);

    // POS = X + alpha * Y where alpha = stdX / stdY
    const alpha = stdY > 0 ? stdX / stdY : 1;
    const pos = X.map((v, i) => v + alpha * Y[i]);

    this.posSignal = pos;

    // Estimate heart rate from POS signal
    const bpm = this.estimateHeartRate(pos, this.config.sampleRate);
    this.lastBpm = bpm;

    // Confidence based on signal quality
    const confidence = this.calculateConfidence(pos);
    this.lastConfidence = confidence;

    return {
      pulse: pos[pos.length - 1] ?? 0,
      bpm,
      confidence,
    };
  }

  getLastBpm(): number {
    return this.lastBpm;
  }

  getLastConfidence(): number {
    return this.lastConfidence;
  }

  getSignal(): number[] {
    return [...this.posSignal];
  }

  reset(): void {
    this.buffer = [];
    this.posSignal = [];
    this.lastBpm = 0;
    this.lastConfidence = 0;
  }

  private normalize(signal: number[]): number[] {
    const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
    const std = this.std(signal);
    return std > 0 ? signal.map((v) => (v - mean) / std) : signal.map((v) => v - mean);
  }

  private std(signal: number[]): number {
    const n = signal.length;
    if (n < 2) return 0;
    const mean = signal.reduce((a, b) => a + b, 0) / n;
    const variance = signal.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
    return Math.sqrt(variance);
  }

  private estimateHeartRate(signal: number[], fs: number): number {
    const n = signal.length;
    if (n < fs * 2) return 0;

    const recent = signal.slice(-Math.min(n, fs * 8));
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const centered = recent.map((v) => v - mean);

    // Autocorrelation for periodicity
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

  private calculateConfidence(signal: number[]): number {
    const signalEnergy = signal.reduce((a, b) => a + b * b, 0);
    const dcRemoved = signal.reduce((a, b) => a + b, 0) / signal.length;
    const acEnergy = signal.reduce((a, b) => a + Math.pow(b - dcRemoved, 2), 0);
    const snr = acEnergy > 0 ? signalEnergy / acEnergy : 0;

    const peakRatio = Math.min(1, snr * 0.1);
    const periodicity = this.estimateHeartRate(signal, this.config.sampleRate) > 0 ? 0.7 : 0;

    return Math.min(1, peakRatio * 0.6 + periodicity * 0.4);
  }
}
