import { pipeline, env } from '@huggingface/transformers';

env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency || 4;

export interface PPGClassification {
  quality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | 'NOISE';
  confidence: number;
  arrhythmiaType?: 'NORMAL' | 'AFIB' | 'PVC' | 'PAC' | 'OTHER';
  signalToNoiseRatio: number;
  morphologyScore: number;
}

interface ClassificationCache {
  timestamp: number;
  result: PPGClassification;
}

export class PPGClassifier {
  private classifier: AWAITED<ReturnType<typeof pipeline>> | null = null;
  private cache: ClassificationCache | null = null;
  private readonly CACHE_TTL = 2000;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.classifier) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        this.classifier = await pipeline(
          'feature-extraction',
          'onnx-community/ppg-quality-classifier',
          { quantized: true },
        );
      } catch {
        this.classifier = null;
      }
    })();

    return this.initPromise;
  }

  get isAvailable(): boolean {
    return this.classifier !== null;
  }

  classify(
    signalBuffer: Float64Array,
    sampleRate: number,
    currentSQI: number,
  ): PPGClassification {
    const now = Date.now();
    if (this.cache && now - this.cache.timestamp < this.CACHE_TTL) {
      return this.cache.result;
    }

    const snr = this.computeSNR(signalBuffer);
    const morphologyScore = this.computeMorphologyScore(signalBuffer, sampleRate);

    let quality: PPGClassification['quality'];
    let confidence: number;

    const composite = (snr * 0.5 + morphologyScore * 0.3 + currentSQI / 100 * 0.2);
    if (composite > 0.85) { quality = 'EXCELLENT'; confidence = 0.92; }
    else if (composite > 0.70) { quality = 'GOOD'; confidence = 0.78; }
    else if (composite > 0.50) { quality = 'FAIR'; confidence = 0.60; }
    else if (composite > 0.25) { quality = 'POOR'; confidence = 0.35; }
    else { quality = 'NOISE'; confidence = 0.15; }

    const arrhythmiaType = this.detectArrhythmiaType(signalBuffer, sampleRate);

    const result: PPGClassification = {
      quality, confidence, signalToNoiseRatio: snr,
      morphologyScore, arrhythmiaType,
    };

    this.cache = { timestamp: now, result };
    return result;
  }

  private computeSNR(buffer: Float64Array): number {
    if (buffer.length < 30) return 0;
    const mean = buffer.reduce((a, b) => a + b, 0) / buffer.length;
    const deviations = new Float64Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) deviations[i] = buffer[i] - mean;
    const signalPower = deviations.reduce((a, b) => a + b * b, 0) / buffer.length;
    const ac = this.autocorrelate(deviations);
    const noisePower = Math.max(1e-10, ac[0] - (ac[1] || 0));
    return 10 * Math.log10(Math.max(1e-10, signalPower) / noisePower);
  }

  private computeMorphologyScore(buffer: Float64Array, sampleRate: number): number {
    if (buffer.length < sampleRate) return 0;
    const peaks: number[] = [];
    const threshold = 0.5;
    for (let i = 2; i < buffer.length - 2; i++) {
      if (buffer[i] > buffer[i - 1] && buffer[i] > buffer[i + 1] && buffer[i] > threshold) {
        peaks.push(i);
      }
    }
    if (peaks.length < 2) return 0;
    const intervals: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push((peaks[i] - peaks[i - 1]) / sampleRate * 1000);
    }
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const std = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length);
    const cv = mean > 0 ? std / mean : 1;
    const baseScore = Math.max(0, 1 - cv * 2);
    const amplitudeScore = Math.min(1, this.computePeakAmplitudeConsistency(buffer, peaks));
    return baseScore * 0.6 + amplitudeScore * 0.4;
  }

  private computePeakAmplitudeConsistency(buffer: Float64Array, peaks: number[]): number {
    if (peaks.length < 3) return 0;
    const amps = peaks.map(p => buffer[p]);
    const mean = amps.reduce((a, b) => a + b, 0) / amps.length;
    const cv = Math.sqrt(amps.reduce((a, b) => a + (b - mean) ** 2, 0) / amps.length) / (mean || 1);
    return Math.max(0, 1 - cv);
  }

  private autocorrelate(data: Float64Array): Float64Array {
    const n = data.length;
    const result = new Float64Array(n);
    for (let lag = 0; lag < n; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) sum += data[i] * data[i + lag];
      result[lag] = sum;
    }
    return result;
  }

  private detectArrhythmiaType(
    buffer: Float64Array,
    sampleRate: number,
  ): PPGClassification['arrhythmiaType'] {
    if (buffer.length < sampleRate * 3) return undefined;
    const intervals = this.extractRRIntervals(buffer, sampleRate);
    if (intervals.length < 8) return undefined;
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const std = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length);
    const cv = mean > 0 ? std / mean : 0;
    if (cv < 0.08) return 'NORMAL';
    const rmssd = Math.sqrt(intervals.slice(0, -1)
      .reduce((a, _, i) => a + (intervals[i + 1] - intervals[i]) ** 2, 0) / (intervals.length - 1));
    const afibScore = rmssd / (mean || 1);
    if (afibScore > 0.25 && cv > 0.15) return 'AFIB';
    const prematureCount = intervals.filter((v, i) => {
      if (i === 0 || i === intervals.length - 1) return false;
      return v < mean * 0.7 && Math.abs(intervals[i + 1] - v) > mean * 0.3;
    }).length;
    if (prematureCount >= 3 && (prematureCount / intervals.length) > 0.15) return 'PVC';
    if (prematureCount >= 2) return 'PAC';
    if (cv > 0.12) return 'OTHER';
    return 'NORMAL';
  }

  private extractRRIntervals(buffer: Float64Array, sampleRate: number): number[] {
    const peaks: number[] = [];
    for (let i = 4; i < buffer.length - 4; i++) {
      if (buffer[i] > buffer[i - 1] && buffer[i] > buffer[i + 1] &&
          buffer[i] > buffer[i - 2] && buffer[i] > buffer[i + 2] &&
          buffer[i] > 0.3) {
        peaks.push(i);
      }
    }
    const intervals: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
      const ms = (peaks[i] - peaks[i - 1]) / sampleRate * 1000;
      if (ms >= 300 && ms <= 2000) intervals.push(ms);
    }
    return intervals;
  }
}

export const ppgClassifier = new PPGClassifier();
