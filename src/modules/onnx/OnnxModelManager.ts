import * as ort from 'onnxruntime-web';
import type { OnnxModelInfo, OnnxModelType } from './types';
import { getModelPath, getModelVersion } from './modelPaths';

export class OnnxModelManager {
  private sessions = new Map<OnnxModelType, ort.InferenceSession>();
  private loading = new Set<OnnxModelType>();

  async loadModel(type: OnnxModelType): Promise<ort.InferenceSession> {
    const existing = this.sessions.get(type);
    if (existing) return existing;
    if (this.loading.has(type)) {
      while (this.loading.has(type)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const loaded = this.sessions.get(type);
      if (loaded) return loaded;
    }

    this.loading.add(type);
    try {
      const path = getModelPath(type);
      const session = await ort.InferenceSession.create(path, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      this.sessions.set(type, session);
      return session;
    } finally {
      this.loading.delete(type);
    }
  }

  async runInference(
    type: OnnxModelType,
    feeds: Record<string, ort.Tensor>,
  ): Promise<Record<string, ort.Tensor>> {
    const session = await this.loadModel(type);
    return session.run(feeds);
  }

  isLoaded(type: OnnxModelType): boolean {
    return this.sessions.has(type);
  }

  isLoading(type: OnnxModelType): boolean {
    return this.loading.has(type);
  }

  unloadModel(type: OnnxModelType): void {
    const session = this.sessions.get(type);
    if (session) {
      session.release?.();
      this.sessions.delete(type);
    }
  }

  getModelInfo(type: OnnxModelType): OnnxModelInfo {
    const path = getModelPath(type);
    const genericInfo: Record<OnnxModelType, OnnxModelInfo> = {
      peak_scorer: {
        type,
        path,
        inputNames: ['signal', 'features'],
        outputNames: ['score', 'confidence'],
        inputShape: [1, 256, 4],
        version: getModelVersion(type),
      },
      sqi_refiner: {
        type,
        path,
        inputNames: ['signal_embed', 'metadata'],
        outputNames: ['refined_sqi', 'reliability'],
        inputShape: [1, 64],
        version: getModelVersion(type),
      },
      denoiser: {
        type,
        path,
        inputNames: ['noisy_signal'],
        outputNames: ['denoised_signal'],
        inputShape: [1, 1, 512],
        version: getModelVersion(type),
      },
    };
    return genericInfo[type];
  }
}
