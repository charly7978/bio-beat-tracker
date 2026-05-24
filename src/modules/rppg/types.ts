export interface RppgConfig {
  windowSize: number;
  sampleRate: number;
  chromAlpha: number;
  posThreshold: number;
}

export interface RgbFrame {
  r: number;
  g: number;
  b: number;
  timestamp: number;
}

export interface RppgResult {
  pulseSignal: number;
  bpm: number;
  confidence: number;
  sqi: number;
  chromSignal: number[];
  posSignal?: number[];
}

export type RppgMethod = 'chrom' | 'pos';
