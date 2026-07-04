import { AutoProcessor, AutoModelForImageTextToText, RawImage } from '@huggingface/transformers';
import { createLogger } from '@/utils/logger';

const log = createLogger('VisionAgent');

export interface VisionReport {
  scene: 'human_tissue' | 'inert_object' | 'air' | 'uncertain';
  confidence: number;
  transparency?: number;
  redIntensity: number;
  description: string;
}

const SCENE_PROMPT =
  'You are a biomedical vision sentinel watching a phone camera lens during a fingertip pulse-oximetry measurement. ' +
  'In one short sentence, describe exactly what covers the lens right now: living human finger/skin with blood perfusion, ' +
  'an inert object (fruit, plastic, table, apple, etc.), open air/no contact, or something uncertain/occluded. ' +
  'Be blunt and specific, mention any signs of fraud or non-biological material.';

const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';

/**
 * AGENTE CENTINELA (Visión Biológica) — Vision-Language Model real.
 *
 * Se sienta "detrás de la puerta de la cámara" y describe en lenguaje natural
 * lo que ve en cada frame, en vez de clasificar contra 1000 etiquetas de ImageNet.
 * Esta descripción alimenta directamente el razonamiento del Orquestador.
 */
export class VisionAgent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private processor: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private model: any = null;
  private isInitializing = false;
  private ready = false;

  isReady() {
    return this.ready;
  }

  async initialize() {
    if (this.ready || this.isInitializing) return;
    this.isInitializing = true;

    try {
      this.processor = await AutoProcessor.from_pretrained(MODEL_ID);
      this.model = await AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
        dtype: 'q4',
        device: 'webgpu',
      });
      this.ready = true;
      log.info('VisionAgent: SmolVLM-256M-Instruct (WebGPU) Ready — true frame understanding online');
    } catch (e) {
      log.warn('VisionAgent: WebGPU VLM failed, falling back to WASM', e);
      try {
        this.processor = await AutoProcessor.from_pretrained(MODEL_ID);
        this.model = await AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
          dtype: 'q8',
          device: 'wasm',
        });
        this.ready = true;
        log.info('VisionAgent: SmolVLM-256M-Instruct (WASM) Ready');
      } catch (err) {
        log.error('VisionAgent: Total failure loading VLM', err);
      }
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Analiza el frame actual del video como haría un humano viendo la imagen:
   * captura pixel data real, la pasa por el VLM, y devuelve una descripción
   * en lenguaje natural + un veredicto biológico derivado de ella.
   */
  async analyzeFrame(videoElement: HTMLVideoElement, redLevel: number): Promise<VisionReport> {
    if (!this.ready || !this.model || !this.processor) {
      return { scene: 'uncertain', confidence: 0, redIntensity: redLevel, description: 'VLM not ready' };
    }

    try {
      const image = this.captureFrame(videoElement);
      if (!image) {
        return { scene: 'uncertain', confidence: 0, redIntensity: redLevel, description: 'no frame available' };
      }

      const messages = [
        {
          role: 'user',
          content: [{ type: 'image' }, { type: 'text', text: SCENE_PROMPT }],
        },
      ];

      const text = this.processor.apply_chat_template(messages, { add_generation_prompt: true });
      const inputs = await this.processor(text, [image], { return_tensors: 'pt' });

      const outputIds = await this.model.generate({
        ...inputs,
        max_new_tokens: 60,
        do_sample: false,
      });

      const generated = this.processor.batch_decode(
        outputIds.slice(null, [inputs.input_ids.dims[1], null]),
        { skip_special_tokens: true },
      );
      const description: string = (Array.isArray(generated) ? generated[0] : String(generated)).trim();

      const scene = this.classifyFromDescription(description, redLevel);

      return {
        scene,
        confidence: scene === 'uncertain' ? 0.3 : 0.85,
        redIntensity: redLevel,
        transparency: redLevel / 255,
        description,
      };
    } catch (e) {
      log.warn('VisionAgent: frame analysis failed', e);
      return { scene: 'uncertain', confidence: 0, redIntensity: redLevel, description: 'analysis error' };
    }
  }

  private captureFrame(videoElement: HTMLVideoElement): RawImage | null {
    const w = videoElement.videoWidth;
    const h = videoElement.videoHeight;
    if (!w || !h) return null;

    // Downscale agresivo: el VLM no necesita resolución nativa, y esto mantiene
    // la latencia de inferencia baja para poder correr por frame reciente.
    const targetW = 224;
    const targetH = Math.round((h / w) * targetW);

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(videoElement, 0, 0, targetW, targetH);
    const imageData = ctx.getImageData(0, 0, targetW, targetH);
    return new RawImage(imageData.data, targetW, targetH, 4);
  }

  /**
   * El VLM ya hizo el razonamiento semántico en texto libre; aquí solo
   * lo mapeamos a un veredicto discreto que necesita el Orquestador y las
   * gates biológicas aguas abajo.
   */
  private classifyFromDescription(description: string, redLevel: number): VisionReport['scene'] {
    const d = description.toLowerCase();

    const inertSignals = ['apple', 'fruit', 'plastic', 'object', 'table', 'inanimate', 'not a finger', 'no skin', 'fraud', 'fake'];
    const humanSignals = ['finger', 'skin', 'blood', 'perfusion', 'human', 'flesh', 'tissue'];
    const airSignals = ['no contact', 'empty', 'nothing', 'air', 'no lens coverage', 'dark', 'black frame'];

    if (inertSignals.some((s) => d.includes(s))) return 'inert_object';
    if (humanSignals.some((s) => d.includes(s)) && redLevel > 40) return 'human_tissue';
    if (airSignals.some((s) => d.includes(s)) || redLevel < 20) return 'air';
    return 'uncertain';
  }
}

export const visionAgent = new VisionAgent();
