import { PPGSignalProcessor } from './PPGSignalProcessor';
import type { ProcessedSignal } from '../../types/signal';

let processor: PPGSignalProcessor | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

// Internal canvas for pixel extraction (avoids main thread getImageData)
let extractionCanvas: OffscreenCanvas | null = null;
let extractionCtx: OffscreenCanvasRenderingContext2D | null = null;

const COLORS = {
  BG: '#06090f',
  SIGNAL: '#22c55e',
  GRID: 'rgba(34, 197, 94, 0.1)',
};

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
      if (ctx && canvas) {
        ctx.fillStyle = COLORS.BG;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      break;
  }
};

// Lógica de barrido (sweep) simplificada para el worker
let lastX = 0;
let lastY = 0;
const SWEEP_WIDTH = 2;

function drawSignalSweep(signal: ProcessedSignal) {
  if (!ctx || !canvas) return;

  const w = canvas.width;
  const h = canvas.height;
  const val = signal.filteredValue;
  
  // Normalización simple para visualización
  const y = h / 2 - (val * h / 40);
  
  const x = lastX + SWEEP_WIDTH;
  
  if (x >= w) {
    lastX = 0;
    ctx.fillStyle = COLORS.BG;
    ctx.fillRect(0, 0, w, h);
  } else {
    // Borrar pequeño margen delante del trazo
    ctx.fillStyle = COLORS.BG;
    ctx.fillRect(x, 0, SWEEP_WIDTH * 10, h);
    
    ctx.beginPath();
    ctx.strokeStyle = COLORS.SIGNAL;
    ctx.lineWidth = 2;
    ctx.moveTo(lastX, lastY || y);
    ctx.lineTo(x, y);
    ctx.stroke();
    
    lastX = x;
    lastY = y;
  }
}
