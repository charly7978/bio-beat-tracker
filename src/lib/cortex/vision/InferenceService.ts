import { FrameCapture, getCameraVideoElement } from './FrameCapture';

export type ModelStatus = 'unloaded' | 'loading' | 'ready' | 'error';

export interface InferenceResult {
  label: string;
  state: string;
  confidence: number;
  guidance: string;
  frameRgb: string;
}

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

/**
 * Servicio de clasificación de colocación del dedo (CLIP zero-shot).
 *
 * La captura del frame (drawImage + getImageData de 224×224) vive en el hilo
 * principal porque es baratísima, pero TODA la ejecución del modelo CLIP corre
 * en un Web Worker dedicado. Así descargar/compilar/inferir el modelo pesado
 * jamás congela la cámara ni la UI. Un guard de concurrencia evita apilar
 * clasificaciones: si una está en vuelo, la siguiente devuelve null al instante.
 */
export class InferenceService {
  private worker: Worker | null = null;
  private frameCapture: FrameCapture;
  private status: ModelStatus = 'unloaded';
  private error: string | null = null;

  private inFlight = false;
  private reqId = 0;
  private pending: ((r: InferenceResult | null) => void) | null = null;
  private pendingRgb = '';

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
    if (typeof Worker === 'undefined') {
      this.status = 'error';
      this.error = 'Web Workers no disponibles en este entorno';
      return;
    }
    this.status = 'loading';
    try {
      this.worker = new Worker(
        new URL('../../../workers/clipInference.worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(e);
      this.worker.onerror = (e: ErrorEvent) => {
        this.status = 'error';
        this.error = e.message ?? 'worker error';
        this.resolvePending(null);
      };
      this.worker.postMessage({ type: 'load' });
    } catch (err: unknown) {
      this.status = 'error';
      this.error = (err as Error)?.message ?? String(err);
      console.error('[InferenceService] worker init failed:', err);
    }
  }

  private onWorkerMessage(e: MessageEvent): void {
    const msg = e.data;
    if (msg.type === 'loaded') {
      this.status = 'ready';
    } else if (msg.type === 'error') {
      this.status = 'error';
      this.error = msg.error ?? 'unknown worker error';
      this.resolvePending(null);
    } else if (msg.type === 'classifyResult') {
      this.inFlight = false;
      if (msg.ok) {
        this.resolvePending({
          label: msg.label,
          state: mapLabel(msg.label),
          confidence: msg.score,
          guidance: guidanceFor(msg.label, msg.score),
          frameRgb: this.pendingRgb,
        });
      } else {
        this.resolvePending(null);
      }
    }
  }

  private resolvePending(result: InferenceResult | null): void {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p(result);
    }
  }

  async classify(): Promise<InferenceResult | null> {
    if (this.status !== 'ready' || !this.worker) return null;
    if (this.inFlight) return null;
    const video = getCameraVideoElement();
    if (!video) return null;
    const imageData = this.frameCapture.capture(video);
    if (!imageData) return null;

    this.pendingRgb = this.frameCapture.getRgbSummary();
    this.inFlight = true;
    const id = ++this.reqId;

    // Copiamos los píxeles para poder transferirlos (zero-copy) al worker sin
    // invalidar el ImageData interno del canvas de captura.
    const pixels = new Uint8ClampedArray(imageData.data);

    return new Promise<InferenceResult | null>((resolve) => {
      this.pending = resolve;
      this.worker!.postMessage(
        { type: 'classify', id, width: imageData.width, height: imageData.height, pixels },
        [pixels.buffer]
      );
    });
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.status = 'unloaded';
    this.inFlight = false;
    this.resolvePending(null);
  }
}
