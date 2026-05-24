export type OnnxModelType = 'peak_scorer' | 'sqi_refiner' | 'denoiser';

export interface OnnxModelInfo {
  type: OnnxModelType;
  path: string;
  inputNames: string[];
  outputNames: string[];
  inputShape: number[];
  version: number;
}

export interface PeakScorerInput {
  signalWindow: Float32Array;
  candidateIndex: number;
  sqi: number;
  perfusionIndex: number;
}

export interface PeakScorerOutput {
  score: number;
  confidence: number;
}

export interface SqiRefinerInput {
  signalWindow: Float32Array;
  rawSqi: number;
  rrStability: number;
  periodicityScore: number;
  perfusionIndex: number;
}

export interface SqiRefinerOutput {
  refinedSqi: number;
  reliability: number;
}

export interface DenoiserInput {
  noisySignal: Float32Array;
}

export interface DenoiserOutput {
  denoisedSignal: Float32Array;
}
