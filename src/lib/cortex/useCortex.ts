import { useState, useRef, useCallback } from 'react';
import type { ProcessedSignal } from '@/types/signal';
import type { CortexFrame } from './types';
import { CortexReasoner } from './CortexReasoner';

export interface InferenceInput {
  label: string;
  state: string;
  confidence: number;
  guidance: string;
  frameRgb: string;
}

// Cadencia máxima de publicación del frame de razonamiento a React (ms).
// El razonamiento (y el buffer del TCN) corre en CADA frame de señal (~30/s),
// pero re-renderizar el árbol completo de <Index> 30 veces por segundo congela
// la UI y mata la medición. El panel de razonamiento no necesita más de unas
// pocas actualizaciones por segundo, así que publicamos el estado throttleado.
const CORTEX_PUBLISH_THROTTLE_MS = 400;

export function useCortex() {
  const [lastFrame, setLastFrame] = useState<CortexFrame | null>(null);
  const [isActive, setIsActive] = useState(false);
  const reasonerRef = useRef<CortexReasoner | null>(null);
  const lastPublishRef = useRef(0);

  const start = useCallback(() => {
    reasonerRef.current = new CortexReasoner();
    lastPublishRef.current = 0;
    setIsActive(true);
  }, []);

  const stop = useCallback(() => {
    reasonerRef.current?.dispose();
    reasonerRef.current = null;
    setIsActive(false);
    setLastFrame(null);
  }, []);

  const feedSignal = useCallback((signal: ProcessedSignal) => {
    const reasoner = reasonerRef.current;
    if (!reasoner) return;
    // Cada frame: alimenta el buffer del TCN y su inferencia (barato).
    reasoner.feed(signal);
    // Solo de forma throttleada: construye el frame de razonamiento y lo empuja
    // a React, para no re-renderizar el componente completo en cada frame.
    const now = performance.now();
    if (now - lastPublishRef.current >= CORTEX_PUBLISH_THROTTLE_MS) {
      lastPublishRef.current = now;
      setLastFrame(reasoner.process(signal));
    }
  }, []);

  const setInferenceResult = useCallback((result: InferenceInput) => {
    if (!reasonerRef.current) return;
    reasonerRef.current.setInferenceResult(result);
  }, []);

  return {
    lastFrame,
    isActive,
    start,
    stop,
    feedSignal,
    setInferenceResult,
  };
}
