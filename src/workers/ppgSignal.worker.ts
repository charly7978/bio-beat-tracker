import * as ort from 'onnxruntime-web';
import { OnnxModelLoader } from '../lib/ml/onnxLoader';
import { PPGSignalProcessor } from '../modules/signal-processing/PPGSignalProcessor';
import type { ProcessedSignal, ProcessingError } from '../types/signal';

let processor: PPGSignalProcessor | null = null;
let visionSession: ort.InferenceSession | null = null;
let signalSession: ort.InferenceSession | null = null;

// Throttling & tracking states
let lastCentroid = { x: 0.5, y: 0.5 };
let lastFingerDetected = false;
let lastLatentVector: number[] = new Array(32).fill(0);
let frameCounter = 0;

// Reset AI state variables on start or stop
function resetAIState() {
  lastCentroid = { x: 0.5, y: 0.5 };
  lastFingerDetected = false;
  lastLatentVector = new Array(32).fill(0);
  frameCounter = 0;
}

// Preprocess frame data for the Vision Cortex Model (downsample to 64x64, CHW normalized to [0, 1])
function preprocessFrame(imageData: ImageData, targetSize = 64): Float32Array {
  const { data, width, height } = imageData;
  const buffer = new Float32Array(3 * targetSize * targetSize);
  const xRatio = width / targetSize;
  const yRatio = height / targetSize;
  
  for (let dy = 0; dy < targetSize; dy++) {
    for (let dx = 0; dx < targetSize; dx++) {
      const sx = Math.floor(dx * xRatio);
      const sy = Math.floor(dy * yRatio);
      const srcIdx = (sy * width + sx) * 4;
      
      const r = data[srcIdx] / 255.0;
      const g = data[srcIdx + 1] / 255.0;
      const b = data[srcIdx + 2] / 255.0;
      
      const offset = dy * targetSize + dx;
      buffer[offset] = r;                                 // R
      buffer[targetSize * targetSize + offset] = g;       // G
      buffer[2 * targetSize * targetSize + offset] = b;   // B
    }
  }
  return buffer;
}

// Optimized local RGB extraction around cached centroid coordinates
function extractRgbAtCentroid(
  imageData: ImageData,
  centroid: { x: number; y: number }
): { r: number; g: number; b: number } {
  const { data, width, height } = imageData;
  
  const cx = Math.floor(centroid.x * width);
  const cy = Math.floor(centroid.y * height);
  
  const halfSize = 16; // 32x32 bounding box
  const startX = Math.max(0, cx - halfSize);
  const startY = Math.max(0, cy - halfSize);
  const endX = Math.min(width, cx + halfSize);
  const endY = Math.min(height, cy + halfSize);
  
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  
  for (let y = startY; y < endY; y += 2) {
    for (let x = startX; x < endX; x += 2) {
      const idx = (y * width + x) * 4;
      sumR += data[idx];
      sumG += data[idx + 1];
      sumB += data[idx + 2];
      count++;
    }
  }
  
  return {
    r: count > 0 ? sumR / count : 0,
    g: count > 0 ? sumG / count : 0,
    b: count > 0 ? sumB / count : 0,
  };
}

// Escuchar mensajes del hilo principal
self.onmessage = async (event: MessageEvent) => {
  const { type, data } = event.data;

  try {
    switch (type) {
      case 'init': {
        const onSignalReady = (signal: ProcessedSignal) => {
          // Serializar el resultado junto con las estadísticas necesarias
          self.postMessage({
            type: 'signalReady',
            data: {
              signal,
              rgbStats: processor ? processor.getRGBStats() : null,
              backpressureState: processor ? processor.getBackpressureState() : null
            }
          });
        };

        const onError = (error: ProcessingError) => {
          self.postMessage({
            type: 'error',
            data: error
          });
        };

        // Try to load ONNX models. If they are not found or fail, fallback to CPU shadow mode
        try {
          visionSession = await OnnxModelLoader.getSession('/models/vision_cortex_v1.onnx');
          signalSession = await OnnxModelLoader.getSession('/models/signal_foundation_v1.onnx');
        } catch (onnxErr) {
          console.warn('Failed to load ONNX models (running in fallback heuristics mode):', onnxErr);
        }

        processor = new PPGSignalProcessor(onSignalReady, onError);
        if (data?.backpressureConfig) {
          processor.setBackpressureConfig(data.backpressureConfig);
        }
        resetAIState();
        self.postMessage({ type: 'initialized' });
        break;
      }

      case 'start':
        if (processor) {
          resetAIState();
          processor.start();
          self.postMessage({ type: 'started' });
        }
        break;

      case 'stop':
        if (processor) {
          processor.stop();
          resetAIState();
          self.postMessage({ type: 'stopped' });
        }
        break;

      case 'processFrame': {
        if (!processor || !processor.isProcessing) return;
        const { imageData, timestamp } = data as { imageData: ImageData; timestamp?: number };
        
        let visionMetrics = null;
        frameCounter++;
        
        if (visionSession) {
          // Throttling: run Vision Cortex neural network only every 6 frames (~5Hz) or if finger is not detected
          if (frameCounter % 6 === 0 || !lastFingerDetected) {
            const t0 = performance.now();
            try {
              const preprocessed = preprocessFrame(imageData, 64);
              const tensor = new ort.Tensor('float32', preprocessed, [1, 3, 64, 64]);
              const outputs = await visionSession.run({ frame_pixels: tensor });
              
              const fingerScore = (outputs.finger_detected.data as Float32Array)[0];
              const centroid = outputs.roi_centroid.data as Float32Array;
              const rgb = outputs.signal_rgb.data as Float32Array;
              const latent = outputs.latent_vector.data as Float32Array;
              
              lastFingerDetected = fingerScore > 0.5;
              lastCentroid = { x: centroid[0], y: centroid[1] };
              lastLatentVector = Array.from(latent);
              
              visionMetrics = {
                fingerDetected: lastFingerDetected,
                roiCentroid: lastCentroid,
                signalRgb: { r: rgb[0], g: rgb[1], b: rgb[2] },
                latentVector: lastLatentVector,
                inferenceTimeMs: performance.now() - t0,
              };
            } catch (err) {
              console.error('Vision Cortex ONNX execution failed:', err);
            }
          } else {
            // Intermediate frames: fast average R/G/B calculation from cached centroid coordinates (no neural net run)
            const t0 = performance.now();
            const rgb = extractRgbAtCentroid(imageData, lastCentroid);
            visionMetrics = {
              fingerDetected: lastFingerDetected,
              roiCentroid: lastCentroid,
              signalRgb: rgb,
              latentVector: lastLatentVector,
              inferenceTimeMs: performance.now() - t0, // Takes ~0.05ms
            };
          }
        }
        
        let signalMetrics = null;
        if (
          signalSession &&
          processor.isFingerDetected() &&
          processor.getFilteredBufferLength() >= 256 &&
          processor.getFrameCount() % 15 === 0
        ) {
          const t0 = performance.now();
          try {
            const ppgWindow = processor.getLastFilteredSamples(256);
            const tensor = new ort.Tensor('float32', new Float32Array(ppgWindow), [1, 1, 256]);
            const outputs = await signalSession.run({ ppg_signal: tensor });
            
            const hemo = outputs.hemo_params.data as Float32Array;
            const latent = outputs.latent_vector.data as Float32Array;
            
            signalMetrics = {
              co: hemo[0],
              contractility: hemo[1],
              vascularLoad: hemo[2],
              latentVector: Array.from(latent),
              inferenceTimeMs: performance.now() - t0,
            };
          } catch (err) {
            console.error('Signal Foundation ONNX execution failed:', err);
          }
        }
        
        processor.processFrame(imageData, timestamp, visionMetrics, signalMetrics);
        break;
      }

      case 'motion': {
        if (!processor) return;
        const { accelerationIncludingGravity, rotationRate } = data as {
          accelerationIncludingGravity: { x: number; y: number; z: number } | null;
          rotationRate: { alpha: number; beta: number; gamma: number } | null;
        };
        
        const mockEvent = {
          accelerationIncludingGravity,
          rotationRate
        } as unknown as DeviceMotionEvent;

        const pWithMotion = processor as unknown as {
          handleMotionEvent?: (e: DeviceMotionEvent) => void;
        };
        if (typeof pWithMotion.handleMotionEvent === 'function') {
          pWithMotion.handleMotionEvent(mockEvent);
        }
        break;
      }

      case 'setCameraRuntimeHints':
        if (processor) {
          processor.setCameraRuntimeHints(data);
        }
        break;

      case 'setBackpressureConfig':
        if (processor) {
          const newCfg = processor.setBackpressureConfig(data);
          self.postMessage({
            type: 'backpressureConfigChanged',
            data: newCfg
          });
        }
        break;

      default:
        // unrecognized message type
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      data: {
        code: 'WORKER_INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
};
