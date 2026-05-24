export interface WorkerFrameResult {
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  coverageRatio: number;
  fingerScore: number;
  fingerTileCount: number;
}

export type WorkerStatus = 'unavailable' | 'ready' | 'busy';

export class PpgWorkerManager {
  private worker: Worker | null = null;
  private status: WorkerStatus = 'unavailable';
  private pendingResolve: ((result: WorkerFrameResult) => void) | null = null;
  private pendingReject: ((err: unknown) => void) | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private roiRatio = 0.5;

  async init(canvasWidth: number, canvasHeight: number): Promise<boolean> {
    try {
      const PpgWorker = (await import('../../workers/ppgWorker?worker')).default;
      this.worker = new PpgWorker();

      this.canvas = document.createElement('canvas');
      this.canvas.width = canvasWidth;
      this.canvas.height = canvasHeight;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });

      this.worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          this.status = 'ready';
          return;
        }
        if (msg.type === 'result') {
          this.status = 'ready';
          this.pendingResolve?.({
            rawRed: msg.rawRed,
            rawGreen: msg.rawGreen,
            rawBlue: msg.rawBlue,
            coverageRatio: msg.coverageRatio,
            fingerScore: msg.fingerScore,
            fingerTileCount: msg.fingerTileCount,
          });
          this.pendingResolve = null;
          this.pendingReject = null;
        }
      };

      this.worker.onerror = (err) => {
        this.status = 'unavailable';
        this.pendingReject?.(err);
        this.pendingResolve = null;
        this.pendingReject = null;
      };

      this.worker.postMessage({ type: 'init', width: canvasWidth, height: canvasHeight });
      return true;
    } catch {
      this.status = 'unavailable';
      return false;
    }
  }

  setRoiRatio(ratio: number): void {
    this.roiRatio = ratio;
  }

  processFrame(imageData: ImageData, timestamp: number): Promise<WorkerFrameResult> | null {
    if (this.status !== 'ready' || !this.worker || !this.ctx || !this.canvas) return null;

    this.status = 'busy';

    const w = imageData.width;
    const h = imageData.height;
    const roiMargin = Math.round(Math.min(w, h) * (1 - this.roiRatio) / 2);
    const roiX = roiMargin;
    const roiY = roiMargin;
    const roiW = w - roiMargin * 2;
    const roiH = h - roiMargin * 2;

    const buffer = imageData.data.buffer.slice(0);

    return new Promise<WorkerFrameResult>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.worker!.postMessage(
        {
          type: 'frame',
          buffer,
          width: w,
          height: h,
          timestamp,
          roiX,
          roiY,
          roiW,
          roiH,
        },
        [buffer],
      );
    });
  }

  isAvailable(): boolean {
    return this.status !== 'unavailable';
  }

  isBusy(): boolean {
    return this.status === 'busy';
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.status = 'unavailable';
    this.pendingResolve = null;
    this.pendingReject = null;
  }
}
