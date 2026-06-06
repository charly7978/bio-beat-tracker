import { PPGSignalProcessor } from '../modules/signal-processing/PPGSignalProcessor';
import type { ProcessedSignal, ProcessingError } from '../types/signal';

let processor: PPGSignalProcessor | null = null;

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

        processor = new PPGSignalProcessor(onSignalReady, onError);
        if (data?.backpressureConfig) {
          processor.setBackpressureConfig(data.backpressureConfig);
        }
        self.postMessage({ type: 'initialized' });
        break;
      }

      case 'start':
        if (processor) {
          processor.start();
          self.postMessage({ type: 'started' });
        }
        break;

      case 'stop':
        if (processor) {
          processor.stop();
          self.postMessage({ type: 'stopped' });
        }
        break;

      case 'processFrame': {
        if (!processor || !processor.isProcessing) return;
        const { imageData, timestamp } = data as { imageData: ImageData; timestamp?: number };
        processor.processFrame(imageData, timestamp);
        break;
      }

      case 'motion': {
        if (!processor) return;
        // Inyectar evento de movimiento manualmente en el procesador
        const { accelerationIncludingGravity, rotationRate } = data as {
          accelerationIncludingGravity: { x: number; y: number; z: number } | null;
          rotationRate: { alpha: number; beta: number; gamma: number } | null;
        };
        
        // Simular DeviceMotionEvent compatible con el procesador
        const mockEvent = {
          accelerationIncludingGravity,
          rotationRate
        } as unknown as DeviceMotionEvent;

        // Acceder al manejador de eventos interno de movimiento
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
        // Tipo de mensaje no reconocido - ignorado silenciosamente
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
