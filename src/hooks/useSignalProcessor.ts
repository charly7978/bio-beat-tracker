import { useState, useEffect, useCallback, useRef } from 'react';
import type { ProcessedSignal, ProcessingError } from '../types/signal';
import {
  loadBackpressureConfig,
  saveBackpressureConfig,
  type BackpressureConfig,
} from '../lib/perf/backpressureConfig';
import { createLogger } from '../utils/logger';
import {
  PhysiologicalReasoningCore,
  isValidPhysiologyProfile,
} from '../lib/reasoning/PhysiologicalReasoningCore';

const log = createLogger('useSignalProcessor');
const PHYSIOLOGICAL_REASONING_PROFILE_KEY = 'bio-beat:physiological-reasoning-profile:v1';

function loadPhysiologicalReasoningProfile(): unknown | null {
  try {
    const raw = localStorage.getItem(PHYSIOLOGICAL_REASONING_PROFILE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidPhysiologyProfile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function savePhysiologicalReasoningProfile(profile: unknown): void {
  try {
    localStorage.setItem(PHYSIOLOGICAL_REASONING_PROFILE_KEY, JSON.stringify(profile));
  } catch {
    log.warn('No se pudo persistir el perfil de razonamiento fisiológico');
  }
}

/**
 * Hook que adapta el procesamiento de PPG a través de un Web Worker en un hilo separado.
 * Mantiene compatibilidad total con la interfaz del hilo principal de React.
 */
export const useSignalProcessor = () => {
  const workerRef = useRef<Worker | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const isProcessingRef = useRef(false);
  const [lastSignal, setLastSignal] = useState<ProcessedSignal | null>(null);
  const [currentStride, setCurrentStride] = useState<number>(3);
  const physiologicalReasoningRef = useRef<PhysiologicalReasoningCore | null>(null);
  if (physiologicalReasoningRef.current === null) {
    const core = new PhysiologicalReasoningCore();
    const persisted = loadPhysiologicalReasoningProfile();
    if (persisted) core.importProfile(persisted);
    physiologicalReasoningRef.current = core;
  }
  const lastPersistedReasoningRevisionRef = useRef<number>(
    physiologicalReasoningRef.current.exportProfile().revision,
  );

  // Guardar estadísticas recibidas del Worker para resolver getters síncronos
  const rgbStatsRef = useRef({
    redAC: 0,
    redDC: 0,
    greenAC: 0,
    greenDC: 0,
    blueAC: 0,
    blueDC: 0,
    rgRatio: 0,
    ratioOfRatios: 0
  });

  const backpressureStateRef = useRef({
    pixelStride: 3,
    estimatedSampleRate: 0,
    activeSource: 'RG',
    config: loadBackpressureConfig()
  });

  // Hot-path callback: corre por cada frame SIN pasar por React.
  const realtimeCbRef = useRef<((s: ProcessedSignal) => void) | null>(null);
  // Throttle del snapshot UI (lastSignal): ~10 Hz es suficiente para HUD.
  const lastUiPushRef = useRef<number>(0);
  const UI_SNAPSHOT_INTERVAL_MS = 100;
  const lastUiContactRef = useRef<{ finger: boolean; contact: string }>({
    finger: false,
    contact: 'NO_CONTACT',
  });

  // Single-instance lifecycle guard.
  const initializationState = useRef<'IDLE' | 'INITIALIZING' | 'READY' | 'ERROR'>('IDLE');

  useEffect(() => {
    if (initializationState.current !== 'IDLE') {
      return;
    }

    initializationState.current = 'INITIALIZING';

    try {
      // Instanciar el Web Worker compatible con Vite y TypeScript
      workerRef.current = new Worker(
        new URL('../workers/ppgSignal.worker.ts', import.meta.url),
        { type: 'module' }
      );

      workerRef.current.onmessage = (event: MessageEvent) => {
        const { type, data } = event.data;

        if (type === 'initialized') {
          initializationState.current = 'READY';
        } else if (type === 'signalReady') {
          if (initializationState.current !== 'READY') return;
          const { signal, rgbStats, backpressureState } = data as {
            signal: ProcessedSignal;
            rgbStats?: typeof rgbStatsRef.current;
            backpressureState?: typeof backpressureStateRef.current;
          };

          // El razonador trabaja sobre CADA frame emitido por el Worker, antes del
          // throttle de React y sin usar fingerDetected como verdad. Mantiene una
          // interpretación causal paralela y auditable de la escena.
          const sqm = signal.diagnostics?.sqm;
          const physiologicalReasoning = physiologicalReasoningRef.current!.update({
            timestampMs: signal.timestamp,
            rawRed: signal.rawRed ?? 0,
            rawGreen: signal.rawGreen ?? 0,
            rawBlue: signal.rawBlue ?? 0,
            coverageRatio: signal.diagnostics?.coverageRatio ?? 0,
            perfusionIndex: signal.perfusionIndex ?? 0,
            periodicity: sqm?.periodicity ?? 0,
            sqi: sqm?.sqi ?? signal.quality,
            pulseStrength: sqm?.snr ?? 0,
            filteredValue: signal.filteredValue,
            morphologyValue: signal.morphologyValue ?? signal.morphologyFiltered ?? 0,
            motionScore: sqm?.motionScore ?? (signal.motionArtifact ? 1 : 0),
            signalMotionScore: sqm?.motionScore ?? 0,
            saturationRatio: sqm?.saturationRatio ?? 0,
            underexposureRatio: sqm?.underexposureRatio ?? 0,
            frameDropRatio: sqm?.frameDropRatio,
            timestampJitterMs: sqm?.timestampJitterMs,
            spo2Channels: signal.spo2Channels,
          });
          if (signal.diagnostics) {
            signal.diagnostics.physiologicalReasoning = physiologicalReasoning;
          }

          if (physiologicalReasoning.learningAccepted) {
            const profile = physiologicalReasoningRef.current!.exportProfile();
            if (profile.revision > lastPersistedReasoningRevisionRef.current) {
              lastPersistedReasoningRevisionRef.current = profile.revision;
              savePhysiologicalReasoningProfile(profile);
            }
          }

          // Actualizar las caches de telemetría
          if (rgbStats) rgbStatsRef.current = rgbStats;
          if (backpressureState) {
            backpressureStateRef.current = backpressureState;
            setCurrentStride((prev) => (prev !== backpressureState.pixelStride ? backpressureState.pixelStride : prev));
          }

          // 1) Hot path: callback síncrono (DSP, ringbuffers, refs en Index).
          const cb = realtimeCbRef.current;
          if (cb) {
            try { cb(signal); } catch {
              log.warn('Realtime callback threw — signal may be stale');
            }
          }

          // 2) Snapshot UI throttleado a ~10 Hz para HUD/diagnóstico.
          const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
          const contactChanged =
            signal.fingerDetected !== lastUiContactRef.current.finger ||
            signal.contactState !== lastUiContactRef.current.contact;
          if (contactChanged) {
            lastUiContactRef.current = {
              finger: signal.fingerDetected,
              contact: signal.contactState,
            };
            lastUiPushRef.current = nowMs;
            setLastSignal(signal);
          } else if (nowMs - lastUiPushRef.current >= UI_SNAPSHOT_INTERVAL_MS) {
            lastUiPushRef.current = nowMs;
            setLastSignal(signal);
          }
        } else if (type === 'backpressureConfigChanged') {
          if (data) {
            backpressureStateRef.current.config = data;
          }
        } else if (type === 'error') {
          const err = data as ProcessingError;
          console.error(`PPGSignalProcessor Web Worker error: ${err.code} ${err.message}`);
        }
      };

      // Inicializar el procesador dentro del worker
      workerRef.current.postMessage({
        type: 'init',
        data: {
          backpressureConfig: loadBackpressureConfig()
        }
      });
    } catch (e) {
      log.error('Failed to initialize PPG Web Worker:', e);
      initializationState.current = 'ERROR';
    }

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      initializationState.current = 'IDLE';
    };
  }, []);

  // Listener de movimiento en el hilo principal
  useEffect(() => {
    if (!isProcessing) return;

    let motionListenerActive = false;

    const handleMotionEvent = (event: DeviceMotionEvent) => {
      const acc = event.accelerationIncludingGravity;
      const rot = event.rotationRate;

      workerRef.current?.postMessage({
        type: 'motion',
        data: {
          accelerationIncludingGravity: acc ? { x: acc.x, y: acc.y, z: acc.z } : null,
          rotationRate: rot ? { alpha: rot.alpha, beta: rot.beta, gamma: rot.gamma } : null
        }
      });
    };

    try {
      if (typeof DeviceMotionEvent !== 'undefined') {
        const dme = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
        if (typeof dme.requestPermission === 'function') {
          dme.requestPermission()
            .then((state: string) => {
              if (state === 'granted') {
                window.addEventListener('devicemotion', handleMotionEvent, { passive: true });
                motionListenerActive = true;
              }
            })
            .catch(() => { log.warn('DeviceMotion permission denied'); });
        } else {
          window.addEventListener('devicemotion', handleMotionEvent, { passive: true });
          motionListenerActive = true;
        }
      }
    } catch {
      log.warn('DeviceMotionEvent not supported on this device');
    }

    return () => {
      if (motionListenerActive) {
        window.removeEventListener('devicemotion', handleMotionEvent);
      }
    };
  }, [isProcessing]);

  const startProcessing = useCallback(() => {
    if (!workerRef.current || initializationState.current !== 'READY') {
      return;
    }
    if (isProcessing) {
      return;
    }
    isProcessingRef.current = true;
    setIsProcessing(true);
    workerRef.current.postMessage({ type: 'start' });
  }, [isProcessing]);

  const stopProcessing = useCallback(() => {
    if (!workerRef.current) {
      return;
    }
    isProcessingRef.current = false;
    workerRef.current.postMessage({ type: 'stop' });
    setIsProcessing(false);
    setLastSignal(null);
    lastUiPushRef.current = 0;
    lastUiContactRef.current = { finger: false, contact: 'NO_CONTACT' };
    physiologicalReasoningRef.current?.resetSession(true);
  }, []);

  const processFrame = useCallback((imageData: ImageData, frameTimestampMs?: number) => {
    if (!workerRef.current || initializationState.current !== 'READY' || !isProcessingRef.current) {
      return;
    }
    
    // Transferir el buffer de píxeles (Uint8ClampedArray.buffer) de forma eficiente sin copiar
    const buffer = imageData.data.buffer;
    workerRef.current.postMessage({
      type: 'processFrame',
      data: {
        imageData,
        timestamp: frameTimestampMs
      }
    }, [buffer]);
  }, []);

  const getRGBStats = useCallback(() => {
    return rgbStatsRef.current;
  }, []);

  const getBackpressureState = useCallback(() => {
    return backpressureStateRef.current;
  }, []);

  const getBackpressureConfig = useCallback((): BackpressureConfig => {
    return backpressureStateRef.current.config;
  }, []);

  const setCameraRuntimeHints = useCallback((diag: Record<string, unknown> | null | undefined) => {
    workerRef.current?.postMessage({
      type: 'setCameraRuntimeHints',
      data: diag
    });
  }, []);

  const setBackpressureConfig = useCallback((partial: Partial<BackpressureConfig>): BackpressureConfig => {
    const nextCfg = { ...backpressureStateRef.current.config, ...partial };
    saveBackpressureConfig(nextCfg);
    backpressureStateRef.current.config = nextCfg;
    
    workerRef.current?.postMessage({
      type: 'setBackpressureConfig',
      data: partial
    });
    
    return nextCfg;
  }, []);

  const setSignalCallback = useCallback((cb: ((s: ProcessedSignal) => void) | null) => {
    realtimeCbRef.current = cb;
  }, []);

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
    setCameraRuntimeHints,
    setSignalCallback,
  };
};
