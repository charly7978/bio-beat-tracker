import { pipeline } from '@huggingface/transformers';
import { FrameCapture, getCameraVideoElement } from './FrameCapture';

export type ModelStatus = 'unloaded' | 'loading' | 'ready' | 'error';

export interface InferenceResult {
  label: string;
  state: string;
  confidence: number;
  guidance: string;
  frameRgb: string;
}

const CANDIDATE_LABELS = [
  'a finger completely covering the camera lens and flash, centered correctly',
  'a finger partially covering the camera lens, offset to one side',
  'empty camera lens with no finger, just bright light',
  'a finger pressing too hard on the camera, skin blanched',
  'a finger barely touching the camera surface, very light contact',
];

function mapLabel(label: string): string {
  if (label.includes('completely covering') || label.includes('centered correctly')) return 'CENTERED_GOOD';
  if (label.includes('partially covering') || label.includes('offset')) return 'PARTIAL_COVERAGE';
  if (label.includes('empty') || label.includes('no finger')) return 'NO_FINGER';
  if (label.includes('pressing too hard') || label.includes('blanched')) return 'CENTERED_HIGH_PRESSURE';
  if (label.includes('barely touching') || label.includes('light contact')) return 'CENTERED_LOW_PRESSURE';
  return 'UNKNOWN';
}

function guidanceFor(label: string, conf: number): string {
  if (label.includes('completely covering') || label.includes('centered')) {
    return conf > 0.7 ? 'Dedo bien colocado, mantenelo así' : 'Casi perfecto, sostené firme';
  }
  if (label.includes('partially covering')) {
    return 'Desplazá el dedo para cubrir toda la lente';
  }
  if (label.includes('empty')) {
    return 'Apoyá la yema del dedo sobre la cámara y el flash';
  }
  if (label.includes('pressing too hard')) {
    return 'Aflojá la presión, estás aplastando el dedo';
  }
  if (label.includes('barely touching')) {
    return 'Apoyá el dedo con más firmeza';
  }
  return 'Acomodá el dedo sobre la lente';
}

export class InferenceService {
  private classifier: ((canvas: HTMLCanvasElement, labels: string[]) => Promise<Array<{ label: string; score: number }>>) | null = null;
  private frameCapture: FrameCapture;
  private status: ModelStatus = 'unloaded';
  private error: string | null = null;

  constructor() {
    this.frameCapture = new FrameCapture();
  }

  getStatus(): ModelStatus {
    return this.status;
  }
  getError(): string | null {
    return this.error;
  }

  async load(): Promise<void> {
    if (this.status === 'loading' || this.status === 'ready') return;
    this.status = 'loading';
    try {
      this.classifier = await pipeline(
        'zero-shot-image-classification',
        'Xenova/clip-vit-base-patch32',
        { dtype: 'fp32', device: 'webgpu' }
      );
      this.status = 'ready';
    } catch (err: unknown) {
      this.status = 'error';
      this.error = (err as Error)?.message ?? String(err);
      console.error('[InferenceService] load failed:', err);
    }
  }

  async classify(): Promise<InferenceResult | null> {
    if (this.status !== 'ready' || !this.classifier) return null;
    const video = getCameraVideoElement();
    if (!video) return null;
    const imageData = this.frameCapture.capture(video);
    if (!imageData) return null;

    const frameRgb = this.frameCapture.getRgbSummary();
    const canvas = this.frameCapture.getCanvas();

    try {
      const results = await this.classifier(canvas, CANDIDATE_LABELS);
      if (!results || results.length === 0) return null;
      const top: { label: string; score: number } = results[0];
      return {
        label: top.label,
        state: mapLabel(top.label),
        confidence: top.score,
        guidance: guidanceFor(top.label, top.score),
        frameRgb,
      };
    } catch (err: unknown) {
      console.error('[InferenceService] classify failed:', err);
      return null;
    }
  }
}
