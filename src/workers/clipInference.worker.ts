/**
 * Web Worker para el clasificador de colocación del dedo (CLIP zero-shot).
 *
 * El modelo CLIP (Xenova/clip-vit-base-patch32) es PESADO: descargar, compilar
 * e inferir en el hilo principal congelaba la cámara y la UI por completo.
 * Aquí toda esa carga vive fuera del hilo principal. El hilo principal solo
 * captura un frame RGBA de 224×224 (drawImage + getImageData, baratísimo) y
 * transfiere los píxeles crudos (zero-copy). El worker reconstruye la imagen,
 * corre CLIP y devuelve la etiqueta ganadora.
 *
 * Intenta WebGPU primero y cae a WASM automáticamente si no está disponible,
 * de modo que la capacidad del modelo se conserva intacta en cualquier equipo.
 */
import { pipeline, RawImage } from '@huggingface/transformers';

type Classifier = (
  image: RawImage,
  labels: string[],
) => Promise<Array<{ label: string; score: number }>>;

const CANDIDATE_LABELS = [
  'a finger completely covering the camera lens and flash, centered correctly',
  'a finger partially covering the camera lens, offset to one side',
  'empty camera lens with no finger, just bright light',
  'a finger pressing too hard on the camera, skin blanched',
  'a finger barely touching the camera surface, very light contact',
];

let classifier: Classifier | null = null;
let inFlight = false;

interface LoadMsg { type: 'load' }
interface ClassifyMsg { type: 'classify'; id: number; width: number; height: number; pixels: Uint8ClampedArray }
type InboundMsg = LoadMsg | ClassifyMsg;

async function loadClassifier(): Promise<void> {
  // WebGPU primero; si falla, WASM. Misma capacidad, sin bloquear el hilo principal.
  for (const device of ['webgpu', 'wasm'] as const) {
    try {
      classifier = (await pipeline(
        'zero-shot-image-classification',
        'Xenova/clip-vit-base-patch32',
        { dtype: 'fp32', device },
      )) as unknown as Classifier;
      self.postMessage({ type: 'loaded', device });
      return;
    } catch (err) {
      if (device === 'wasm') {
        self.postMessage({ type: 'error', error: (err as Error)?.message ?? String(err) });
      }
    }
  }
}

self.onmessage = async (event: MessageEvent<InboundMsg>) => {
  const msg = event.data;

  if (msg.type === 'load') {
    await loadClassifier();
    return;
  }

  if (msg.type === 'classify') {
    if (!classifier || inFlight) {
      self.postMessage({ type: 'classifyResult', id: msg.id, ok: false });
      return;
    }
    inFlight = true;
    try {
      // RGBA -> RawImage de 4 canales, tal cual lo espera CLIP tras su preprocesado interno.
      const image = new RawImage(msg.pixels, msg.width, msg.height, 4);
      const results = await classifier(image, CANDIDATE_LABELS);
      inFlight = false;
      if (!results || results.length === 0) {
        self.postMessage({ type: 'classifyResult', id: msg.id, ok: false });
        return;
      }
      const top = results[0];
      self.postMessage({
        type: 'classifyResult',
        id: msg.id,
        ok: true,
        label: top.label,
        score: top.score,
      });
    } catch (err) {
      inFlight = false;
      self.postMessage({ type: 'classifyResult', id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) });
    }
  }
};
