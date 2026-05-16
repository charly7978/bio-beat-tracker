import { useEffect, useCallback, useRef } from 'react';
import { HeartBeatProcessor } from '../modules/HeartBeatProcessor';
import type { ContactState } from '../types/signal';
import type { CameraRuntimeHints } from '../lib/device/cameraDeviceProfile';

interface HeartBeatResult {
  bpm: number;
  confidence: number;
  isPeak: boolean;
  filteredValue: number;
  signalQuality: number;
  ensembleDiagnostics?: Record<string, unknown>;
  rrData?: {
    intervals: number[];
    lastPeakTime: number | null;
    timestampNow?: number;
  };
}

const EMPTY_RR = { intervals: [] as number[], lastPeakTime: null as number | null, timestampNow: 0 };

/**
 * Hook de procesamiento cardíaco.
 *
 * Diseño: NO mantiene state React (BPM, confidence, SQI). El consumidor recibe
 * los valores directamente en el resultado de `processSignal` y los gestiona como
 * prefiera (típicamente via `useState` o `useRef` en Index.tsx). Esto evita
 * setStates por frame que disparaban re-renders en cascada.
 */
export const useHeartBeatProcessor = () => {
  const processorRef = useRef<HeartBeatProcessor | null>(null);
  const sessionIdRef = useRef<string>('');
  const processingStateRef = useRef<'IDLE' | 'ACTIVE' | 'RESETTING'>('IDLE');
  const processedSignalsRef = useRef<number>(0);
  const lastBpmRef = useRef<number>(0);
  const lastConfidenceRef = useRef<number>(0);
  const lastFilteredValueRef = useRef(0);
  const lastSqiRef = useRef<number>(0);
  // Track sustained NO_CONTACT to align with PPGSignalProcessor reset semantics
  const noContactFramesRef = useRef<number>(0);
  const NO_CONTACT_RESET_THRESHOLD = 90;
  const NO_CONTACT_HOLD_FRAMES = 8;

  useEffect(() => {
    const t = Date.now().toString(36);
    const p = (performance.now() | 0).toString(36);
    sessionIdRef.current = `hb_${t}_${p}`;
    processorRef.current = new HeartBeatProcessor();
    processingStateRef.current = 'ACTIVE';

    return () => {
      if (processorRef.current) {
        processorRef.current.dispose();
        processorRef.current = null;
      }
      processingStateRef.current = 'IDLE';
    };
  }, []);

  const processSignal = useCallback((
    value: number,
    contactState: ContactState = 'STABLE_CONTACT',
    timestamp?: number
  ): HeartBeatResult => {
    if (!processorRef.current || processingStateRef.current !== 'ACTIVE') {
      return {
        bpm: lastBpmRef.current, confidence: 0, isPeak: false,
        filteredValue: lastFilteredValueRef.current, signalQuality: lastSqiRef.current,
        rrData: EMPTY_RR,
      };
    }

    const currentTime = timestamp ?? performance.now();

    // Sin dedo: no alimentar el ensemble (la onda PPG puede seguir en otro canal)
    if (contactState === 'NO_CONTACT') {
      noContactFramesRef.current += 1;
      if (noContactFramesRef.current <= NO_CONTACT_HOLD_FRAMES) {
        return {
          bpm: 0,
          confidence: 0,
          isPeak: false,
          filteredValue: 0,
          signalQuality: 0,
          rrData: EMPTY_RR,
        };
      }
      if (noContactFramesRef.current >= NO_CONTACT_RESET_THRESHOLD) {
        processorRef.current.reset();
        lastBpmRef.current = 0;
        lastConfidenceRef.current = 0;
        lastSqiRef.current = 0;
        lastFilteredValueRef.current = 0;
      }
      return {
        bpm: 0, confidence: 0, isPeak: false,
        filteredValue: 0, signalQuality: 0,
        rrData: EMPTY_RR,
      };
    }

    noContactFramesRef.current = 0;
    processedSignalsRef.current++;

    const result = processorRef.current.processSignal(value, timestamp);
    const rrIntervals = processorRef.current.getRRIntervals();
    const lastPeakTime = processorRef.current.getLastPeakTime();
    const roundedSQI = Math.round(result.sqi);

    lastSqiRef.current = roundedSQI;
    lastFilteredValueRef.current = result.filteredValue;
    if (result.bpm > 0 && result.confidence >= 0.15) {
      lastBpmRef.current = Math.round(result.bpm);
      lastConfidenceRef.current = result.confidence;
    } else if (result.confidence > 0) {
      lastConfidenceRef.current = result.confidence;
    }

    return {
      bpm: Math.round(result.bpm),
      confidence: result.confidence,
      isPeak: result.isPeak,
      filteredValue: result.filteredValue,
      signalQuality: roundedSQI,
      ensembleDiagnostics: result.ensembleDiagnostics,
      rrData: { intervals: rrIntervals, lastPeakTime: lastPeakTime || null, timestampNow: currentTime },
    };
  }, []);

  const setRuntimeHints = useCallback((hints: CameraRuntimeHints) => {
    processorRef.current?.setRuntimeHints(hints);
  }, []);

  const setFingerPlacementMode = useCallback((mode: import('../types/signal').FingerPlacementMode) => {
    processorRef.current?.setFingerPlacementMode(mode);
  }, []);

  const reset = useCallback(() => {
    if (processingStateRef.current === 'RESETTING') return;
    processingStateRef.current = 'RESETTING';

    if (processorRef.current) processorRef.current.reset();

    lastBpmRef.current = 0;
    lastConfidenceRef.current = 0;
    lastSqiRef.current = 0;
    lastFilteredValueRef.current = 0;
    processedSignalsRef.current = 0;
    noContactFramesRef.current = 0;

    processingStateRef.current = 'ACTIVE';
  }, []);

  return {
    processSignal,
    setFingerPlacementMode,
    setRuntimeHints,
    reset,
    debugInfo: {
      sessionId: sessionIdRef.current,
      processingState: processingStateRef.current,
      processedSignals: processedSignalsRef.current,
    },
  };
};
