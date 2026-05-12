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
const SWEEP_SPEED = 3.2; // Más rápido para mayor fluidez
const GHOST_WIDTH = 50; // Más espacio de borrado

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

  // Fondo degradado profundo
  const grad = bgCtx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, COLORS.BG_TOP);
  grad.addColorStop(1, COLORS.BG_BOTTOM);
  bgCtx.fillStyle = grad;
  bgCtx.fillRect(0, 0, w, h);
  
  bgCtx.strokeStyle = COLORS.GRID;
  bgCtx.lineWidth = 1;
  bgCtx.beginPath();
  // Líneas horizontales
  for (let y = 0; y <= h; y += h / 4) {
    bgCtx.moveTo(0, y);
    bgCtx.lineTo(w, y);
  }
  // Líneas verticales
  for (let x = 0; x <= w; x += w / 10) {
    bgCtx.moveTo(x, 0);
    bgCtx.lineTo(x, h);
  }
  bgCtx.stroke();

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
  
  // 1. Auto-scaling adaptativo más agresivo
  const targetMin = Math.min(minVal, val - 3);
  const targetMax = Math.max(maxVal, val + 3);
  minVal = minVal * 0.96 + targetMin * 0.04; // Adaptación más rápida
  maxVal = maxVal * 0.96 + targetMax * 0.04;
  range = Math.max(12, maxVal - minVal);

  // 2. Normalización a coordenadas de canvas
  const y = h - ((val - minVal) / range) * h;
  
  // Normalización APG (escala fija o adaptativa menor)
  const apgY = h/2 - (apg * h / 800); 

  const x = lastX + SWEEP_SPEED;
  
  if (x >= w) {
    lastX = 0;
  }

  // 3. Efecto Sweep (borrado por delante usando el buffer de fondo)
  if (bgCanvas) {
    ctx.drawImage(bgCanvas, x, 0, GHOST_WIDTH, h, x, 0, GHOST_WIDTH, h);
  } else {
    ctx.fillStyle = COLORS.BG;
    ctx.fillRect(x, 0, GHOST_WIDTH, h);
  }

  if (quality > 5) {
    // 4. Dibujar APG (Aceleración - Sombra informativa)
    ctx.beginPath();
    ctx.strokeStyle = COLORS.APG;
    ctx.lineWidth = 1.5;
    ctx.moveTo(lastX, lastAPGY || apgY);
    ctx.lineTo(x, apgY);
    ctx.stroke();

    // 5. Dibujar Sombra/Resplandor (Glow)
    ctx.beginPath();
    ctx.strokeStyle = COLORS.SIGNAL_GLOW;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();

    // 6. Dibujar Línea Principal
    ctx.beginPath();
    ctx.strokeStyle = COLORS.SIGNAL;
    ctx.lineWidth = 2.5;
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();

    // 7. Cabezal de barrido (Spark)
    ctx.beginPath();
    ctx.fillStyle = COLORS.HEAD;
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    
    // Halo del cabezal
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, 8);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Señal de baja calidad: línea punteada o tenue
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.setLineDash([2, 4]);
    ctx.moveTo(lastX, h/2);
    ctx.lineTo(x, h/2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  lastX = x;
  lastY = y;
  lastAPGY = apgY;
}
