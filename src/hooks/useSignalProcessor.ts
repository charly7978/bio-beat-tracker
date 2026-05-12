import { useState, useEffect, useCallback, useRef } from 'react';
import { ProcessedSignal, ProcessingError } from '../types/signal';
import {
  loadBackpressureConfig,
  saveBackpressureConfig,
  type BackpressureConfig,
} from '../lib/perf/backpressureConfig';

/**
 * Hook que adapta el PPG Worker para React.
 * Traslada el procesamiento a un hilo separado para garantizar 60fps en la UI.
 */
export const useSignalProcessor = () => {
  const workerRef = useRef<Worker | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const isProcessingRef = useRef(false);
  const [lastSignal, setLastSignal] = useState<ProcessedSignal | null>(null);
  const [currentStride, setCurrentStride] = useState<number>(3);

  const realtimeCbRef = useRef<((s: ProcessedSignal) => void) | null>(null);
  const lastUiPushRef = useRef<number>(0);
  const UI_SNAPSHOT_INTERVAL_MS = 100;

  const instanceLock = useRef<boolean>(false);
  const initializationState = useRef<'IDLE' | 'INITIALIZING' | 'READY' | 'ERROR'>('IDLE');

  useEffect(() => {
    if (instanceLock.current || initializationState.current !== 'IDLE') {
      return;
    }

    instanceLock.current = true;
    initializationState.current = 'INITIALIZING';

    try {
      // Inicializar Worker
      const worker = new Worker(new URL('../modules/signal-processing/ppg.worker.ts', import.meta.url), {
        type: 'module'
      });

      worker.onmessage = (event) => {
        const { type, payload } = event.data;

        if (type === 'SIGNAL_READY') {
          const signal = payload as ProcessedSignal;
          
          // 1) Hot path: callback síncrono
          const cb = realtimeCbRef.current;
          if (cb) {
            try { cb(signal); } catch { /* silenciado */ }
          }
          
          // 2) Snapshot UI throttleado
          const nowMs = performance.now();
          if (nowMs - lastUiPushRef.current >= UI_SNAPSHOT_INTERVAL_MS) {
            lastUiPushRef.current = nowMs;
            setLastSignal(signal);
          }
        } else if (type === 'ERROR') {
          console.error(`PPG Worker error:`, payload);
        }
      };

      workerRef.current = worker;
      worker.postMessage({ type: 'INIT', payload: {} });
      initializationState.current = 'READY';
    } catch (e) {
      console.error("Failed to initialize PPG Worker", e);
      initializationState.current = 'ERROR';
      instanceLock.current = false;
    }

    return () => {
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'STOP' });
        workerRef.current.terminate();
        workerRef.current = null;
      }
      initializationState.current = 'IDLE';
      instanceLock.current = false;
    };
  }, []);

  const startProcessing = useCallback(() => {
    if (!workerRef.current || initializationState.current !== 'READY') return;
    if (isProcessing) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    workerRef.current.postMessage({ type: 'START' });
  }, [isProcessing]);

  const stopProcessing = useCallback(() => {
    if (!workerRef.current) return;
    isProcessingRef.current = false;
    workerRef.current.postMessage({ type: 'STOP' });
    setIsProcessing(false);
    setLastSignal(null);
    lastUiPushRef.current = 0;
  }, []);

  const calibrate = useCallback(async () => {
    workerRef.current?.postMessage({ type: 'RESET' });
    return true;
  }, []);

  const processFrame = useCallback((data: ImageData | ImageBitmap, frameTimestampMs?: number) => {
    if (!workerRef.current || initializationState.current !== 'READY' || !isProcessingRef.current) {
      return;
    }
    
    try {
      const payload: any = {
        timestamp: frameTimestampMs || performance.now()
      };
      const transfers: Transferable[] = [];

      if (data instanceof ImageBitmap) {
        payload.bitmap = data;
        transfers.push(data);
      } else {
        payload.imageData = data;
      }

      workerRef.current.postMessage({
        type: 'PROCESS_FRAME',
        payload
      }, transfers);
    } catch (e) {
      /* hot path */
    }
  }, []);

  const setSignalCallback = useCallback((cb: ((s: ProcessedSignal) => void) | null) => {
    realtimeCbRef.current = cb;
  }, []);

  const getRGBStats = useCallback(() => {
    if (!lastSignal) return { redAC: 0, redDC: 0, greenAC: 0, greenDC: 0, rgRatio: 0, ratioOfRatios: 0 };
    return {
      redAC: 0,
      redDC: 0,
      greenAC: 0,
      greenDC: 0,
      rgRatio: (lastSignal.rawRed / (lastSignal.rawGreen || 1)),
      ratioOfRatios: 0
    };
  }, [lastSignal]);

  const getBackpressureState = useCallback(() => {
    return { pixelStride: currentStride, estimatedSampleRate: 30, activeSource: 'RG' };
  }, [currentStride]);

  const setCanvas = useCallback((canvas: HTMLCanvasElement) => {
    if (workerRef.current && initializationState.current === 'READY') {
      try {
        const offscreen = canvas.transferControlToOffscreen();
        workerRef.current.postMessage({ type: 'INIT', payload: { canvas: offscreen } }, [offscreen]);
      } catch (e) {
        console.warn("Failed to transfer canvas to worker. It might have been transferred already.", e);
      }
    }
  }, []);

  const getBackpressureConfig = useCallback(() => {
    return loadBackpressureConfig();
  }, []);

  const setBackpressureConfig = useCallback((config: Partial<BackpressureConfig>) => {
    const current = loadBackpressureConfig();
    const updated = { ...current, ...config };
    saveBackpressureConfig(updated);
    // Podríamos enviar este config al worker si fuera necesario
  }, []);

  return {
    isProcessing,
    lastSignal,
    currentStride,
    startProcessing,
    stopProcessing,
    calibrate,
    processFrame,
    getRGBStats,
    getBackpressureState,
    getBackpressureConfig,
    setBackpressureConfig,
    setSignalCallback,
    setCanvas
  };
};
