
import { useState, useEffect, useCallback, useRef } from 'react';
import { PPGSignalProcessor } from '../modules/signal-processing/PPGSignalProcessor';
import { ProcessedSignal, ProcessingError } from '../types/signal';
import {
  loadBackpressureConfig,
  saveBackpressureConfig,
  type BackpressureConfig,
} from '../lib/perf/backpressureConfig';

/**
 * Hook que adapta PPGSignalProcessor para React.
 * Mantiene una única instancia con ciclo de vida estricto y expone helpers
 * de backpressure, RGB y captura de frames.
 */
export const useSignalProcessor = () => {
  const processorRef = useRef<PPGSignalProcessor | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const isProcessingRef = useRef(false);
  const [lastSignal, setLastSignal] = useState<ProcessedSignal | null>(null);
  const [currentStride, setCurrentStride] = useState<number>(3);

  // Hot-path callback: corre por cada frame SIN pasar por React.
  // Evita que `setLastSignal` por frame haga re-renders en cascada del árbol.
  const realtimeCbRef = useRef<((s: ProcessedSignal) => void) | null>(null);
  // Throttle del snapshot UI (lastSignal): ~10 Hz es suficiente para HUD.
  const lastUiPushRef = useRef<number>(0);
  const UI_SNAPSHOT_INTERVAL_MS = 100;

  // Single-instance lifecycle guard.
  const instanceLock = useRef<boolean>(false);
  const initializationState = useRef<'IDLE' | 'INITIALIZING' | 'READY' | 'ERROR'>('IDLE');

  useEffect(() => {
    if (instanceLock.current || initializationState.current !== 'IDLE') {
      return;
    }

    instanceLock.current = true;
    initializationState.current = 'INITIALIZING';

    const onSignalReady = (signal: ProcessedSignal) => {
      if (initializationState.current !== 'READY') return;
      // 1) Hot path: callback síncrono (DSP, ringbuffers, refs en Index).
      const cb = realtimeCbRef.current;
      if (cb) {
        try { cb(signal); } catch { /* nunca romper el pipeline por la UI */ }
      }
      // 2) Snapshot UI throttleado a ~10 Hz para HUD/diagnóstico.
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (nowMs - lastUiPushRef.current >= UI_SNAPSHOT_INTERVAL_MS) {
        lastUiPushRef.current = nowMs;
        setLastSignal(signal);
      }
    };

    const onError = (err: ProcessingError) => {
      // El procesador raramente emite errores; los registramos sin estado UI.
      console.error(`PPGSignalProcessor error: ${err.code} ${err.message}`);
    };

    try {
      processorRef.current = new PPGSignalProcessor(onSignalReady, onError);
      try { processorRef.current.setBackpressureConfig(loadBackpressureConfig()); } catch {}
      initializationState.current = 'READY';
    } catch {
      initializationState.current = 'ERROR';
      instanceLock.current = false;
    }

    return () => {
      if (processorRef.current) {
        processorRef.current.stop();
        processorRef.current = null;
      }
      initializationState.current = 'IDLE';
      instanceLock.current = false;
    };
  }, []);

  const startProcessing = useCallback(() => {
    if (!processorRef.current || initializationState.current !== 'READY') {
      return;
    }
    if (isProcessing) {
      return;
    }
    isProcessingRef.current = true;
    setIsProcessing(true);
    processorRef.current.start();
  }, [isProcessing]);

  const stopProcessing = useCallback(() => {
    if (!processorRef.current) {
      return;
    }
    isProcessingRef.current = false;
    processorRef.current.stop();
    setIsProcessing(false);
    setLastSignal(null);
    lastUiPushRef.current = 0;
  }, []);



  const processFrame = useCallback((imageData: ImageData, frameTimestampMs?: number) => {
    if (!processorRef.current || initializationState.current !== 'READY' || !isProcessingRef.current) {
      return;
    }
    try {
      processorRef.current.processFrame(imageData, frameTimestampMs);
    } catch {
      /* hot path — silenciado a propósito */
    }
  }, []);

  const getRGBStats = useCallback(() => {
    if (!processorRef.current) {
      return {
        redAC: 0,
        redDC: 0,
        greenAC: 0,
        greenDC: 0,
        rgRatio: 0,
        ratioOfRatios: 0
      };
    }
    return processorRef.current.getRGBStats();
  }, []);

  const getBackpressureState = useCallback(() => {
    if (!processorRef.current) return { pixelStride: 3, estimatedSampleRate: 0, activeSource: 'RG' };
    return processorRef.current.getBackpressureState();
  }, []);

  const getBackpressureConfig = useCallback((): BackpressureConfig => {
    if (!processorRef.current) return loadBackpressureConfig();
    return processorRef.current.getBackpressureConfig();
  }, []);

  const setBackpressureConfig = useCallback((partial: Partial<BackpressureConfig>): BackpressureConfig => {
    const cfg = processorRef.current
      ? processorRef.current.setBackpressureConfig(partial)
      : { ...loadBackpressureConfig(), ...partial };
    saveBackpressureConfig(cfg);
    return cfg;
  }, []);

  /**
   * Registra un callback que recibe cada `ProcessedSignal` en tiempo real
   * (a la tasa real de cámara), sin pasar por estado de React. Usar SIEMPRE
   * con refs/throttling en el consumidor para alimentar DSP de latidos y
   * vitales. Pasar `null` para desconectar.
   */
  const setSignalCallback = useCallback((cb: ((s: ProcessedSignal) => void) | null) => {
    realtimeCbRef.current = cb;
  }, []);

  // Polling ligero (1 Hz) del stride activo durante la medición. Mantiene a la
  // UI sincronizada con cambios automáticos del backpressure adaptativo sin
  // tocar el hot path del procesador.
  useEffect(() => {
    if (!isProcessing) return;
    const tick = () => {
      if (!processorRef.current) return;
      try {
        const s = processorRef.current.getBackpressureState().pixelStride;
        setCurrentStride((prev) => (prev !== s ? s : prev));
      } catch {}
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isProcessing]);

  return {
    isProcessing,
    lastSignal,
    currentStride,
    startProcessing,
    stopProcessing,
    processFrame,
    getRGBStats,
    getBackpressureState,
    getBackpressureConfig,
    setBackpressureConfig,
    setSignalCallback,
  };
};
