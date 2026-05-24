import { FEATURES } from '../../config/features';
import type { PeakScorerInput, PeakScorerOutput } from './types';
import { OnnxModelManager } from './OnnxModelManager';
import * as ort from 'onnxruntime-web';

export class PeakScorer {
  private manager: OnnxModelManager;

  constructor(manager?: OnnxModelManager) {
    this.manager = manager ?? new OnnxModelManager();
  }

  async evaluate(input: PeakScorerInput): Promise<PeakScorerOutput | null> {
    if (!FEATURES.useNN) return null;

    try {
      const signalTensor = new ort.Tensor('float32', input.signalWindow, [1, 1, input.signalWindow.length]);
      const featuresTensor = new ort.Tensor('float32', new Float32Array([
        input.candidateIndex,
        input.sqi,
        input.perfusionIndex,
        0,
      ]), [1, 4]);

      const result = await this.manager.runInference('peak_scorer', {
        signal: signalTensor,
        features: featuresTensor,
      });

      const scoreData = result.score?.data as Float32Array;
      const confData = result.confidence?.data as Float32Array;

      return {
        score: scoreData?.[0] ?? 0.5,
        confidence: confData?.[0] ?? 0.5,
      };
    } catch {
      return null;
    }
  }
}
