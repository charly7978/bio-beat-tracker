import { createLogger } from '../../utils/logger';

const log = createLogger('ModelService');

export interface InferenceRequest {
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
}

export type ModelStatus = 'idle' | 'loading' | 'loaded' | 'error';

interface PendingRequest {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
}

export class ModelService {
  private worker: Worker | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private status: ModelStatus = 'idle';
  private device = 'wasm';
  private onStatusChange?: (status: ModelStatus) => void;

  async init(onStatusChange?: (status: ModelStatus) => void): Promise<void> {
    this.onStatusChange = onStatusChange;
    if (this.worker) return;

    if (typeof Worker === 'undefined' || typeof import.meta?.url === 'undefined') {
      this.status = 'error';
      this.onStatusChange?.('error');
      return;
    }

    try {
      this.worker = new Worker(
        new URL('../../workers/llm.worker.ts', import.meta.url),
        { type: 'module' },
      );

      this.worker.onmessage = (e: MessageEvent) => {
        const { id, type, data } = e.data;

        if (type === 'progress') {
          log.info(`Model progress: ${data.stage} ${data.progress}%`);
          return;
        }

        const pending = this.pending.get(id);
        if (!pending) return;

        if (type === 'loaded') {
          this.status = 'loaded';
          this.device = data.device ?? 'wasm';
          this.onStatusChange?.('loaded');
          pending.resolve(data.model);
        } else if (type === 'result') {
          pending.resolve(data.content);
        } else if (type === 'error') {
          this.status = 'error';
          this.onStatusChange?.('error');
          pending.reject(new Error(data.message));
        }

        this.pending.delete(id);
      };

      this.worker.onerror = (e) => {
        log.error('Worker error:', e.message);
        this.status = 'error';
        this.onStatusChange?.('error');
      };

      this.status = 'loading';
      this.onStatusChange?.('loading');

      await this.postMessage({ type: 'load' });
    } catch (err) {
      this.status = 'error';
      this.onStatusChange?.('error');
      throw err;
    }
  }

  async infer(request: InferenceRequest): Promise<string> {
    if (!this.worker || this.status !== 'loaded') {
      throw new Error('Model not ready');
    }
    return this.postMessage({
      type: 'infer',
      data: { messages: request.messages, maxTokens: request.maxTokens },
    });
  }

  getStatus(): { status: ModelStatus; device: string } {
    return { status: this.status, device: this.device };
  }

  private postMessage(msg: { type: string; data?: unknown }): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('No worker'));
        return;
      }
      const id = ++this.requestId;
      this.pending.set(id, { resolve: resolve as (v: string) => void, reject });
      this.worker.postMessage({ id, ...msg });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.status = 'idle';
    this.pending.clear();
  }
}
