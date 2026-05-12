import { PPGSignalProcessor } from './PPGSignalProcessor';
import type { ProcessedSignal } from '../../types/signal';

let processor: PPGSignalProcessor | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let bgCanvas: OffscreenCanvas | null = null;
let bgCtx: OffscreenCanvasRenderingContext2D | null = null;

// Internal canvas for pixel extraction (avoids main thread getImageData)
let extractionCanvas: OffscreenCanvas | null = null;
let extractionCtx: OffscreenCanvasRenderingContext2D | null = null;

const COLORS = {
  BG: '#020408',
  BG_TOP: '#050a14',
  BG_BOTTOM: '#020408',
  SIGNAL: '#22c55e',
  SIGNAL_GLOW: 'rgba(34, 197, 94, 0.45)',
  APG: 'rgba(56, 189, 248, 0.4)', // Azul cielo para la aceleración (APG)
  GRID: 'rgba(34, 197, 94, 0.08)',
  HEAD: '#ffffff',
};

// PERSISTENCIA Y ESCALADO
let lastX = 0;
let lastY = 0;
let lastAPGY = 0;
let minVal = -20;
let maxVal = 20;
let range = 40;
// SWEEP_SPEED se calcula dinámicamente en drawSignalSweep para que
// el barrido completo siempre tarde ~4 s sin importar el ancho del canvas.
const SWEEP_DURATION_S = 4.0; // segundos por barrido completo
const GHOST_WIDTH_FRAC = 0.06; // fracción del ancho que se borra por delante

/**
 * PPG WEB WORKER
 * 
 * Traslada la carga computacional pesada (DSP, ROI, MFCC) y el renderizado
 * de la onda fuera del hilo principal.
 */
self.onmessage = (event: MessageEvent) => {
  const { type, payload } = event.data;

  switch (type) {
    case 'INIT':
      if (payload?.canvas) {
        canvas = payload.canvas;
        ctx = canvas!.getContext('2d');
      }
      
      if (!processor) {
        processor = new PPGSignalProcessor(
          (signal: ProcessedSignal) => {
            // 1. Dibujar onda si hay canvas (OffscreenCanvas)
            if (ctx && canvas) {
              drawSignalSweep(signal);
            }
            
            // 2. Enviar resultado al hilo principal para UI/Métricas
            // @ts-ignore
            self.postMessage({ type: 'SIGNAL_READY', payload: signal });
          },
          (error) => {
            // @ts-ignore
            self.postMessage({ type: 'ERROR', payload: error });
          }
        );
      }
      break;

    case 'START':
      if (processor) processor.start();
      break;

    case 'PROCESS_FRAME':
      if (processor) {
        if (payload.imageData) {
          processor.processFrame(payload.imageData, payload.timestamp);
        } else if (payload.bitmap) {
          const bitmap = payload.bitmap as ImageBitmap;
          
          if (!extractionCanvas) {
            extractionCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            extractionCtx = extractionCanvas.getContext('2d', { willReadFrequently: true });
          }
          
          if (extractionCtx) {
            extractionCtx.drawImage(bitmap, 0, 0);
            const imageData = extractionCtx.getImageData(0, 0, bitmap.width, bitmap.height);
            processor.processFrame(imageData, payload.timestamp);
          }
          
          bitmap.close();
        }
      }
      break;

    case 'STOP':
      if (processor) {
        processor.stop();
      }
      break;

    case 'RESIZE':
      // El main thread informa de un nuevo tamaño CSS→físico para el OffscreenCanvas.
      // Actualizamos width/height y regeneramos el fondo.
      if (canvas && payload?.width && payload?.height) {
        canvas.width = payload.width;
        canvas.height = payload.height;
        bgCanvas = null; // Forzar regeneración del fondo a nuevo tamaño
        lastX = 0;       // Reiniciar posición de barrido
        lastY = 0;
        drawGrid();
      }
      break;

    case 'RESET':
      if (processor) processor.reset();
      lastX = 0;
      minVal = -20; maxVal = 20; range = 40;
      if (ctx && canvas) {
        bgCanvas = null; // Forzar regeneración
        drawGrid();
      }
      break;
  }
};

function drawGrid() {
  if (!ctx || !canvas) return;
  const w = canvas.width;
  const h = canvas.height;

  if (!bgCanvas) {
    bgCanvas = new OffscreenCanvas(w, h);
    bgCtx = bgCanvas.getContext('2d');
  }

  if (!bgCtx) return;

  // ── Fondo: degradado profundo tipo monitor clínico ──
  const grad = bgCtx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#040d08');
  grad.addColorStop(0.5, '#020a06');
  grad.addColorStop(1, '#040d08');
  bgCtx.fillStyle = grad;
  bgCtx.fillRect(0, 0, w, h);

  // ── Cuadrícula ECG "papel milimetrado" ──
  // Cuadros menores: ~h/24 (aprox 5mm a 25 mm/s)
  const minor = h / 24;
  const major = minor * 5;

  // Líneas menores (muy sutiles)
  bgCtx.strokeStyle = 'rgba(220, 38, 38, 0.07)';
  bgCtx.lineWidth = 0.5;
  bgCtx.beginPath();
  for (let y = 0; y <= h; y += minor) {
    bgCtx.moveTo(0, y); bgCtx.lineTo(w, y);
  }
  for (let x = 0; x <= w; x += minor) {
    bgCtx.moveTo(x, 0); bgCtx.lineTo(x, h);
  }
  bgCtx.stroke();

  // Líneas mayores (5×minor, más visibles)
  bgCtx.strokeStyle = 'rgba(220, 38, 38, 0.18)';
  bgCtx.lineWidth = 1;
  bgCtx.beginPath();
  for (let y = 0; y <= h; y += major) {
    bgCtx.moveTo(0, y); bgCtx.lineTo(w, y);
  }
  for (let x = 0; x <= w; x += major) {
    bgCtx.moveTo(x, 0); bgCtx.lineTo(x, h);
  }
  bgCtx.stroke();

  // Baseline central (referencia 0)
  bgCtx.strokeStyle = 'rgba(34, 197, 94, 0.30)';
  bgCtx.lineWidth = 1;
  bgCtx.setLineDash([8, 6]);
  bgCtx.beginPath();
  bgCtx.moveTo(0, h / 2); bgCtx.lineTo(w, h / 2);
  bgCtx.stroke();
  bgCtx.setLineDash([]);

  // Borde superior/inferior del área de plot
  bgCtx.strokeStyle = 'rgba(34, 197, 94, 0.22)';
  bgCtx.lineWidth = 1;
  bgCtx.strokeRect(0, 0, w, h);

  // Pintar el fondo inicial
  ctx.drawImage(bgCanvas, 0, 0);
}

function drawSignalSweep(signal: ProcessedSignal) {
  if (!ctx || !canvas) return;

  const w = canvas.width;
  const h = canvas.height;
  const val = signal.filteredValue;
  const apg = signal.diagnostics?.apg || 0;
  const quality = signal.quality || 0;

  // 1. Velocidad de barrido: w píxeles / (SWEEP_DURATION_S * FPS_estimado)
  // FPS estimado a 30 fps. Esto garantiza que el barrido siempre tarde ~4 s
  // independientemente del DPR o del ancho del canvas.
  const SWEEP_SPEED = w / (SWEEP_DURATION_S * 30);
  const GHOST_WIDTH = Math.ceil(w * GHOST_WIDTH_FRAC);

  // 2. Auto-scaling agresivo: adapta en ~10 frames (factor 0.18)
  //    Si la señal sale del rango actual, fuerza inmediatamente el límite.
  const margin = Math.abs(val) * 0.05 + 1.5; // margen pequeño
  const targetMin = val - margin;
  const targetMax = val + margin;
  // Hard-clamp instantáneo si el valor sale del rango
  if (val < minVal) minVal = val - margin;
  if (val > maxVal) maxVal = val + margin;
  // Suavizado lento hacia el rango observado (retroceso hacia el promedio)
  minVal = minVal * 0.88 + (targetMin * 0.12);
  maxVal = maxVal * 0.88 + (targetMax * 0.12);
  range = Math.max(8, maxVal - minVal);

  // 3. Normalización a coordenadas de canvas
  // Dejamos un margen del 10% arriba y abajo para que la onda no se corte
  const MARGIN_TOP = h * 0.10;
  const MARGIN_BOT = h * 0.10;
  const plotH = h - MARGIN_TOP - MARGIN_BOT;
  const y = MARGIN_TOP + plotH - ((val - minVal) / range) * plotH;

  // Normalización APG
  const apgY = h / 2 - (apg * plotH / 800);

  const x = lastX + SWEEP_SPEED;

  if (x >= w) {
    lastX = 0;
  }

  // 4. Efecto Sweep (borrado por delante usando el buffer de fondo)
  if (bgCanvas) {
    ctx.drawImage(bgCanvas, x, 0, GHOST_WIDTH, h, x, 0, GHOST_WIDTH, h);
  } else {
    ctx.fillStyle = COLORS.BG;
    ctx.fillRect(x, 0, GHOST_WIDTH, h);
  }

  if (quality > 5) {
    // 5. APG (Aceleración — capa informativa)
    ctx.beginPath();
    ctx.strokeStyle = COLORS.APG;
    ctx.lineWidth = 1.5;
    ctx.moveTo(lastX, lastAPGY || apgY);
    ctx.lineTo(x, apgY);
    ctx.stroke();

    // 6. Glow exterior (doble pasada para mayor visibilidad)
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(34, 197, 94, 0.20)';
    ctx.lineWidth = 10;
    ctx.lineJoin = 'round';
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = COLORS.SIGNAL_GLOW;
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();

    // 7. Línea principal
    ctx.beginPath();
    ctx.strokeStyle = COLORS.SIGNAL;
    ctx.lineWidth = 2.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();

    // 8. Cabezal de barrido (Spark) — más grande para mayor impacto visual
    const sparkR = Math.max(3, w * 0.004);
    ctx.beginPath();
    ctx.fillStyle = COLORS.HEAD;
    ctx.arc(x, y, sparkR, 0, Math.PI * 2);
    ctx.fill();

    // Halo del cabezal
    const haloR = sparkR * 3.5;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, haloR);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.75)');
    gradient.addColorStop(0.4, 'rgba(34, 197, 94, 0.35)');
    gradient.addColorStop(1, 'rgba(34, 197, 94, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, haloR, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Señal de baja calidad: línea punteada tenue
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.setLineDash([2, 5]);
    ctx.moveTo(lastX, h / 2);
    ctx.lineTo(x, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  lastX = x;
  lastY = y;
  lastAPGY = apgY;
}
