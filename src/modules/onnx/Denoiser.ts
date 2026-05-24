import { FEATURES } from '../../config/features';
import type { DenoiserInput, DenoiserOutput } from './types';
import { OnnxModelManager } from './OnnxModelManager';
import * as ort from 'onnxruntime-web';

export class Denoiser {
  private manager: OnnxModelManager;

  constructor(manager?: OnnxModelManager) {
    this.manager = manager ?? new OnnxModelManager();
  }

  async denoise(input: DenoiserInput): Promise<DenoiserOutput | null> {
    if (!FEATURES.useNN) return null;

    try {
      const tensor = new ort.Tensor('float32', input.noisySignal, [1, 1, input.noisySignal.length]);

      const result = await this.manager.runInference('denoiser', {
        noisy_signal: tensor,
      });

      const denoised = result.denoised_signal?.data as Float32Array;
      if (!denoised) return null;

      return { denoisedSignal: denoised };
    } catch {
      return null;
    }
  }
}
