import * as ort from 'onnxruntime-web';

const FS = 30;
const WINDOW = 780;
const BURN_IN = 540;
const HR_MEAN = 75.0;
const HR_SCALE = 40.0;

export interface TCNResult {
  hr: number;
  beatProbability: number;
  confidence: number;
}

export type TCNModelStatus = 'unloaded' | 'loading' | 'ready' | 'error';

export class TCNInferenceService {
  private session: ort.InferenceSession | null = null;
  private status: TCNModelStatus = 'unloaded';
  private error: string | null = null;

  private rBuffer: number[] = [];
  private gBuffer: number[] = [];
  private bBuffer: number[] = [];

  private lastHr = 0;
  private lastBeatProb = 0;
  private frameCount = 0;

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
    this.status = 'loading';
    try {
      this.session = await ort.InferenceSession.create('/ppg_tcn.onnx', {
        executionProviders: ['wasm'],
      });
      this.status = 'ready';
    } catch (err: unknown) {
      this.status = 'error';
      this.error = (err as Error)?.message ?? String(err);
      console.error('[TCNInference] load failed:', err);
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
    this.frameCount++;
  }

  async infer(): Promise<TCNResult | null> {
    if (this.status !== 'ready' || !this.session) return null;
    if (this.rBuffer.length < WINDOW) return null;

    const n = this.rBuffer.length;
    const start = n - WINDOW;
    const rWin = this.rBuffer.slice(start);
    const gWin = this.gBuffer.slice(start);
    const bWin = this.bBuffer.slice(start);

    const input = new Float32Array(3 * WINDOW);
    for (let i = 0; i < WINDOW; i++) {
      input[i] = rWin[i];
      input[WINDOW + i] = gWin[i];
      input[2 * WINDOW + i] = bWin[i];
    }

    for (let ch = 0; ch < 3; ch++) {
      const off = ch * WINDOW;
      let sum = 0;
      for (let i = 0; i < WINDOW; i++) sum += input[off + i];
      const mu = sum / WINDOW;
      let sq = 0;
      for (let i = 0; i < WINDOW; i++) sq += (input[off + i] - mu) ** 2;
      const sd = Math.sqrt(sq / WINDOW) + 1e-6;
      for (let i = 0; i < WINDOW; i++) input[off + i] = (input[off + i] - mu) / sd;
    }

    const tensor = new ort.Tensor('float32', input, [1, 3, WINDOW]);
    try {
      const results = await this.session.run({ rgb_input: tensor });
      const hrData = results['hr'].data as Float32Array;
      const beatData = results['beat_prob'].data as Float32Array;

      const lastIdx = WINDOW - 1;
      this.lastHr = hrData[lastIdx];
      this.lastBeatProb = beatData[lastIdx];

      let hrSum = 0;
      let bpMax = 0;
      const avgWindow = FS;
      const avgStart = WINDOW - avgWindow;
      for (let i = avgStart; i < WINDOW; i++) {
        hrSum += hrData[i];
        if (beatData[i] > bpMax) bpMax = beatData[i];
      }
      const hrAvg = hrSum / avgWindow;

      const confidence = this.rBuffer.length >= WINDOW ? 1.0 : this.rBuffer.length / WINDOW;

      return {
        hr: Math.round(hrAvg * 10) / 10,
        beatProbability: bpMax,
        confidence,
      };
    } catch (err: unknown) {
      console.error('[TCNInference] infer failed:', err);
      return null;
    }
  }

  reset(): void {
    this.rBuffer = [];
    this.gBuffer = [];
    this.bBuffer = [];
    this.lastHr = 0;
    this.lastBeatProb = 0;
    this.frameCount = 0;
  }
}
