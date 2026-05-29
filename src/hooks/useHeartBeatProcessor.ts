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
 * Reinicia seguimiento de picos al perder contacto y al volver a colocar el dedo.
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
  const noContactFramesRef = useRef<number>(0);
  const wasNoContactRef = useRef(true);

  /** ~1,1 s sin dedo antes de re-adquisición suave (más tolerante: un artefacto
   * breve no corta la detección ni obliga a "ponerse en ritmo" de nuevo) */
  const NO_CONTACT_PEAK_RESET_FRAMES = 33;
  /** ~1,6 s sin dedo: reset completo del procesador (tolerante a parpadeos breves) */
  const NO_CONTACT_FULL_RESET_FRAMES = 48;

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
    timestamp?: number,
    fingerConfirmed = true,
    ppgQuality?: { sqi: number; perfusionIndex?: number; motionScore?: number },
  ): HeartBeatResult => {
    if (!processorRef.current || processingStateRef.current !== 'ACTIVE') {
      return {
        bpm: 0,
        confidence: 0,
        isPeak: false,
        filteredValue: lastFilteredValueRef.current,
        signalQuality: lastSqiRef.current,
        rrData: EMPTY_RR,
      };
    }

    const currentTime = timestamp ?? performance.now();

    processorRef.current.setFingerContactConfirmed(fingerConfirmed);
    if (ppgQuality) {
      processorRef.current.setPpgQualityMetrics(
        ppgQuality.sqi,
        ppgQuality.perfusionIndex,
        ppgQuality.motionScore,
      );
    }

    if (contactState === 'NO_CONTACT' || !fingerConfirmed) {
      noContactFramesRef.current += 1;
      wasNoContactRef.current = true;

      if (noContactFramesRef.current >= NO_CONTACT_PEAK_RESET_FRAMES) {
        processorRef.current.resetPeakTracking();
        lastBpmRef.current = 0;
      }
      if (noContactFramesRef.current >= NO_CONTACT_FULL_RESET_FRAMES) {
        processorRef.current.reset();
        lastBpmRef.current = 0;
        lastConfidenceRef.current = 0;
        lastSqiRef.current = 0;
        lastFilteredValueRef.current = 0;
      }

      return {
        bpm: 0,
        confidence: 0,
        isPeak: false,
        filteredValue: 0,
        signalQuality: 0,
        rrData: EMPTY_RR,
      };
    }

    if (wasNoContactRef.current) {
      wasNoContactRef.current = false;
      const framesLost = noContactFramesRef.current;
      if (framesLost >= NO_CONTACT_FULL_RESET_FRAMES) {
        lastBpmRef.current = 0;
        lastConfidenceRef.current = 0;
      } else if (framesLost >= NO_CONTACT_PEAK_RESET_FRAMES) {
        processorRef.current.softReacquirePeaks(timestamp);
        lastBpmRef.current = 0;
      }
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

  const reacquirePeaks = useCallback((timestamp?: number) => {
    processorRef.current?.softReacquirePeaks(timestamp);
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
    wasNoContactRef.current = true;

    processingStateRef.current = 'ACTIVE';
  }, []);

  return {
    processSignal,
    setFingerPlacementMode,
    setRuntimeHints,
    reacquirePeaks,
    reset,
    debugInfo: {
      sessionId: sessionIdRef.current,
      processingState: processingStateRef.current,
      processedSignals: processedSignalsRef.current,
    },
  };
};
