/**
 * Web Worker para inferencia del modelo TCN de PPG->HR.
 *
 * Toda la ejecución ONNX (WASM) vive AQUÍ, fuera del hilo principal, para que
 * la cámara y la UI nunca se congelen durante la inferencia. El hilo principal
 * solo envía la ventana RGB cruda y recibe {hr, beatProb} de vuelta.
 */
import * as ort from 'onnxruntime-web';

const FS = 30;
const WINDOW = 780;

let session: ort.InferenceSession | null = null;

interface LoadMsg { type: 'load'; modelUrl: string }
interface InferMsg { type: 'infer'; id: number; window: Float32Array }
type InboundMsg = LoadMsg | InferMsg;

self.onmessage = async (event: MessageEvent<InboundMsg>) => {
  const msg = event.data;

  if (msg.type === 'load') {
    try {
      session = await ort.InferenceSession.create(msg.modelUrl, {
        executionProviders: ['wasm'],
      });
      self.postMessage({ type: 'loaded' });
    } catch (err) {
      session = null;
      self.postMessage({ type: 'error', error: (err as Error)?.message ?? String(err) });
    }
    return;
  }

  if (msg.type === 'infer') {
    if (!session) {
      self.postMessage({ type: 'inferResult', id: msg.id, ok: false });
      return;
    }
    try {
      const raw = msg.window; // length 3*WINDOW, raw R/G/B concatenated
      const input = new Float32Array(3 * WINDOW);

      // Normalización z-score por canal (idéntica al entrenamiento)
      for (let ch = 0; ch < 3; ch++) {
        const off = ch * WINDOW;
        let sum = 0;
        for (let i = 0; i < WINDOW; i++) sum += raw[off + i];
        const mu = sum / WINDOW;
        let sq = 0;
        for (let i = 0; i < WINDOW; i++) {
          const d = raw[off + i] - mu;
          sq += d * d;
        }
        const sd = Math.sqrt(sq / WINDOW) + 1e-6;
        for (let i = 0; i < WINDOW; i++) input[off + i] = (raw[off + i] - mu) / sd;
      }

      const tensor = new ort.Tensor('float32', input, [1, 3, WINDOW]);
      const results = await session.run({ rgb_input: tensor });
      const hrData = results['hr'].data as Float32Array;
      const beatData = results['beat_prob'].data as Float32Array;

      // Promedio del último segundo para HR, máximo para probabilidad de latido
      let hrSum = 0;
      let bpMax = 0;
      for (let i = WINDOW - FS; i < WINDOW; i++) {
        hrSum += hrData[i];
        if (beatData[i] > bpMax) bpMax = beatData[i];
      }

      self.postMessage({
        type: 'inferResult',
        id: msg.id,
        ok: true,
        hr: hrSum / FS,
        beatProb: bpMax,
      });
    } catch (err) {
      self.postMessage({ type: 'inferResult', id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) });
    }
  }
};
