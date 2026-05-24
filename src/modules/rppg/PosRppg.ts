import type { RgbFrame, RppgConfig } from './types';
import { ChromRppg } from './ChromRppg';

const DEFAULT_CONFIG: RppgConfig = {
  windowSize: 150,
  sampleRate: 30,
  chromAlpha: 1.0,
  posThreshold: 0.1,
};

export class PosRppg {
  private chrom: ChromRppg;
  private config: RppgConfig;

  constructor(config?: Partial<RppgConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.chrom = new ChromRppg(config);
  }

  feed(frame: RgbFrame): void {
    this.chrom.feed(frame);
  }

  process(): { pulse: number; bpm: number; confidence: number } {
    return this.chrom.process();
  }

  getLastBpm(): number {
    return this.chrom.getLastBpm();
  }

  getLastConfidence(): number {
    return this.chrom.getLastConfidence();
  }

  reset(): void {
    this.chrom.reset();
  }
}
