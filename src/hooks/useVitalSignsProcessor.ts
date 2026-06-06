import { useCallback, useRef, useState, useEffect } from 'react';
import { VitalSignsProcessor, VitalSignsResult, RGBData } from '../modules/vital-signs/VitalSignsProcessor';
import { createDefaultVitalSignsResult } from '../lib/vitals/defaultVitalSignsResult';
import type { SignalQualityMetrics } from '../types/measurements';

/**
 * HOOK DE SIGNOS VITALES - OPTIMIZADO
 * Ahora acepta datos RGB para cálculo correcto de SpO2
 */
export const useVitalSignsProcessor = () => {
  const processorRef = useRef<VitalSignsProcessor | null>(null);
  const lastValidRef = useRef<VitalSignsResult | null>(null);
  const [lastValidResults, setLastValidResults] = useState<VitalSignsResult | null>(null);

  // Lazy initialization
  if (!processorRef.current) {
    processorRef.current = new VitalSignsProcessor();
  }
  
  // Cleanup
  useEffect(() => {
    return () => {
      if (processorRef.current) {
        processorRef.current.fullReset();
        processorRef.current = null;
      }
    };
  }, []);
  
  const startCalibration = useCallback(() => {
    processorRef.current?.startCalibration();
  }, []);
  
  const forceCalibrationCompletion = useCallback(() => {
    processorRef.current?.forceCalibrationCompletion();
  }, []);
  
  /**
   * Actualizar datos RGB para SpO2
   */
  const setRGBData = useCallback((data: RGBData) => {
    processorRef.current?.setRGBData(data);
  }, []);

  const setPlacementMode = useCallback((mode: import('../types/signal').FingerPlacementMode) => {
    processorRef.current?.setPlacementMode(mode);
  }, []);
  
  const processSignal = useCallback((
    value: number, 
    quality: number,
    bpm: number,
    rrData?: { intervals: number[], lastPeakTime: number | null, timestampNow?: number },
    /** PI (AC/DC) del PPGSignalProcessor — alinea SpO2/“clínico” con la perfusión real del dedo */
    perfusionIndexFromPpg?: number,
    sqmBundle?: Partial<SignalQualityMetrics>,
    morphologyValue?: number,
    splitterChannels?: {
      morphologyFiltered?: number;
      respirationFiltered?: number;
      arrhythmiaFiltered?: number;
      spo2Channels?: {
        acRed: number;
        dcRed: number;
        acGreen: number;
        dcGreen: number;
        acBlue?: number;
        dcBlue?: number;
      };
    },
  ): VitalSignsResult => {
    if (!processorRef.current) return createDefaultVitalSignsResult();

    const result = processorRef.current.processSignal(
      value,
      quality,
      bpm,
      rrData,
      perfusionIndexFromPpg,
      sqmBundle,
      morphologyValue,
      splitterChannels,
    );
    
    // Guardar la última ventana realmente válida para cierre/exportación en ref para evitar re-renderizados constantes
    if (
      result.heartRate.status === 'VALID' ||
      result.bloodPressure.status === 'VALID' ||
      (result.spo2.value ?? 0) > 0 ||
      (result.arrhythmia.value?.count ?? 0) > 0
    ) {
      lastValidRef.current = result;
    }
    
    return result;
  }, []);

  const reset = useCallback(() => {
    if (!processorRef.current) return lastValidRef.current || lastValidResults;
    const savedResults = processorRef.current.reset();
    const resultToReturn = savedResults ?? lastValidRef.current;
    if (resultToReturn) {
      setLastValidResults(resultToReturn);
      lastValidRef.current = resultToReturn;
    }
    return resultToReturn;
  }, [lastValidResults]);
  
  // calibrateBP eliminado — BP se calcula exclusivamente desde morfología PPG

  const fullReset = useCallback(() => {
    processorRef.current?.fullReset();
    lastValidRef.current = null;
    setLastValidResults(null);
  }, []);

  return {
    processSignal,
    setPlacementMode,
    setRGBData,
    reset,
    fullReset,
    startCalibration,
    forceCalibrationCompletion,
    lastValidResults,
    getCalibrationProgress: useCallback(() => processorRef.current?.getCalibrationProgress() ?? 0, []),
  };
};
