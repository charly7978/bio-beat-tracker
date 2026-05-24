import type { OnnxModelType } from './types';

const MODEL_VERSIONS: Record<OnnxModelType, number> = {
  peak_scorer: 1,
  sqi_refiner: 1,
  denoiser: 1,
};

const MODEL_BASE_URL = '/models';

export function getModelPath(type: OnnxModelType): string {
  const ver = MODEL_VERSIONS[type];
  return `${MODEL_BASE_URL}/${type}_v${ver}.onnx`;
}

export function getModelVersion(type: OnnxModelType): number {
  return MODEL_VERSIONS[type];
}
