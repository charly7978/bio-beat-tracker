import { pipeline, type ImageClassificationPipeline } from '@huggingface/transformers';
import { createLogger } from '@/utils/logger';

const log = createLogger('VisionAgent');

export interface VisionReport {
  scene: 'human_tissue' | 'inert_object' | 'air' | 'uncertain';
  confidence: number;
  transparency?: number;
  redIntensity: number;
}

/**
 * AGENTE CENTINELA (Visión Biológica)
 *
 * Se sienta "detrás de la puerta de la cámara" y clasifica la escena.
 * Informa al Orquestador sobre la naturaleza de lo que hay en el lente.
 */
export class VisionAgent {
  private classifier: ImageClassificationPipeline | null = null;
  private isInitializing = false;

  async initialize() {
    if (this.classifier || this.isInitializing) return;
    this.isInitializing = true;

    try {
      // Usamos un modelo ligero para clasificación continua de frames
      this.classifier = await pipeline('image-classification', 'onnx-community/mobilenetv4_tiny_v2', {
        device: 'webgpu',
      }) as ImageClassificationPipeline;
      log.info('VisionAgent: MobilenetV4 Tiny Loaded');
    } catch (e) {
      log.error('VisionAgent: Failed to load', e);
    } finally {
      this.isInitializing = false;
    }
  }

  async analyzeFrame(videoElement: HTMLVideoElement, redLevel: number): Promise<VisionReport> {
    if (!this.classifier) {
      return { scene: 'uncertain', confidence: 0, redIntensity: redLevel };
    }

    try {
      const output = await this.classifier(videoElement);
      const top = output[0];

      // Lógica de mapeo de clases a biología (simulada aquí, se entrenaría con el tiempo)
      let scene: VisionReport['scene'] = 'uncertain';
      if (redLevel > 150 && top.label.includes('skin')) {
        scene = 'human_tissue';
      } else if (redLevel < 20) {
        scene = 'air';
      } else if (top.label.includes('apple') || top.label.includes('object')) {
        scene = 'inert_object';
      }

      return {
        scene,
        confidence: top.score,
        redIntensity: redLevel,
        transparency: redLevel / 255
      };
    } catch (e) {
      log.warn('Vision analysis failed', e);
      return { scene: 'uncertain', confidence: 0, redIntensity: redLevel };
    }
  }
}

export const visionAgent = new VisionAgent();
