import { FEATURES } from '../../config/features';
import type { SqiRefinerInput, SqiRefinerOutput } from './types';
import { OnnxModelManager } from './OnnxModelManager';
import * as ort from 'onnxruntime-web';

export class SqiRefiner {
  private manager: OnnxModelManager;

  constructor(manager?: OnnxModelManager) {
    this.manager = manager ?? new OnnxModelManager();
  }

  async refine(input: SqiRefinerInput): Promise<SqiRefinerOutput | null> {
    if (!FEATURES.useNN) return null;

    try {
      const metadataTensor = new ort.Tensor('float32', new Float32Array([
        input.rawSqi,
        input.rrStability,
        input.periodicityScore,
        input.perfusionIndex,
      ]), [1, 4]);

      const result = await this.manager.runInference('sqi_refiner', {
        signal_embed: new ort.Tensor('float32', input.signalWindow, [1, 1, input.signalWindow.length]),
        metadata: metadataTensor,
      });

      const sqiData = result.refined_sqi?.data as Float32Array;
      const relData = result.reliability?.data as Float32Array;

      return {
        refinedSqi: sqiData?.[0] ?? input.rawSqi,
        reliability: relData?.[0] ?? 0.5,
      };
    } catch {
      return null;
    }
  }
}
