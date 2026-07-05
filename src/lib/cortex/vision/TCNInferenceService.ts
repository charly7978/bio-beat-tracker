const FS = 30;
const WINDOW = 780;
const MODEL_URL = '/ppg_tcn.onnx';

export interface TCNResult {
  hr: number;
  beatProbability: number;
  confidence: number;
}

export type TCNModelStatus = 'unloaded' | 'loading' | 'ready' | 'error';

/**
 * Servicio de inferencia TCN.
 *
 * El buffer RGB vive en el hilo principal (push/trim baratísimos), pero TODA
 * la ejecución ONNX corre en un Web Worker dedicado. Así la cámara y la UI
 * nunca se bloquean mientras el modelo infiere. Un guard de concurrencia
 * garantiza que jamás se apilen inferencias: si una está en vuelo, la siguiente
 * llamada devuelve el último resultado en lugar de encolar trabajo.
 */
export class TCNInferenceService {
  private worker: Worker | null = null;
  private status: TCNModelStatus = 'unloaded';
  private error: string | null = null;

  private rBuffer: number[] = [];
  private gBuffer: number[] = [];
  private bBuffer: number[] = [];

  private inFlight = false;
  private reqId = 0;
  private pending: ((r: TCNResult | null) => void) | null = null;

  getStatus(): TCNModelStatus {
    return this.status;
  }

  getError(): string | null {
    return this.error;
  }

  getBufferFill(): number {
    return Math.min(this.rBuffer.length / WINDOW, 1);
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
        new URL('../../../workers/tcnInference.worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(e);
      this.worker.onerror = (e: ErrorEvent) => {
        this.status = 'error';
        this.error = e.message ?? 'worker error';
        this.resolvePending(null);
      };
      this.worker.postMessage({ type: 'load', modelUrl: MODEL_URL });
    } catch (err: unknown) {
      this.status = 'error';
      this.error = (err as Error)?.message ?? String(err);
      console.error('[TCNInference] worker init failed:', err);
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
    } else if (msg.type === 'inferResult') {
      this.inFlight = false;
      if (msg.ok) {
        const confidence = this.rBuffer.length >= WINDOW ? 1.0 : this.rBuffer.length / WINDOW;
        this.resolvePending({
          hr: Math.round(msg.hr * 10) / 10,
          beatProbability: msg.beatProb,
          confidence,
        });
      } else {
        this.resolvePending(null);
      }
    }
  }

  private resolvePending(result: TCNResult | null): void {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p(result);
    }
  }

  pushFrame(r: number, g: number, b: number): void {
    this.rBuffer.push(r);
    this.gBuffer.push(g);
    this.bBuffer.push(b);
    if (this.rBuffer.length > WINDOW + FS) {
      const excess = this.rBuffer.length - WINDOW;
      this.rBuffer.splice(0, excess);
      this.gBuffer.splice(0, excess);
      this.bBuffer.splice(0, excess);
    }
  }

  /**
   * Dispara una inferencia en el worker. Si ya hay una en vuelo, devuelve null
   * inmediatamente (sin encolar) — el llamador conserva su último resultado.
   */
  async infer(): Promise<TCNResult | null> {
    if (this.status !== 'ready' || !this.worker) return null;
    if (this.rBuffer.length < WINDOW) return null;
    if (this.inFlight) return null;

    const start = this.rBuffer.length - WINDOW;
    const win = new Float32Array(3 * WINDOW);
    for (let i = 0; i < WINDOW; i++) {
      win[i] = this.rBuffer[start + i];
      win[WINDOW + i] = this.gBuffer[start + i];
      win[2 * WINDOW + i] = this.bBuffer[start + i];
    }

    this.inFlight = true;
    const id = ++this.reqId;

    return new Promise<TCNResult | null>((resolve) => {
      this.pending = resolve;
      // Transferimos el buffer (zero-copy) al worker.
      this.worker!.postMessage({ type: 'infer', id, window: win }, [win.buffer]);
    });
  }

  reset(): void {
    this.rBuffer = [];
    this.gBuffer = [];
    this.bBuffer = [];
    this.inFlight = false;
    this.resolvePending(null);
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.status = 'unloaded';
    this.reset();
  }
}
