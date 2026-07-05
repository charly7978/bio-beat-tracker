import { useState, useRef, useCallback } from 'react';
import type { ProcessedSignal } from '@/types/signal';
import type { CortexFrame } from './types';
import { CortexReasoner } from './CortexReasoner';

export function useCortex() {
  const [lastFrame, setLastFrame] = useState<CortexFrame | null>(null);
  const [isActive, setIsActive] = useState(false);
  const reasonerRef = useRef<CortexReasoner | null>(null);

  const start = useCallback(() => {
    reasonerRef.current = new CortexReasoner();
    setIsActive(true);
  }, []);

  const stop = useCallback(() => {
    reasonerRef.current = null;
    setIsActive(false);
    setLastFrame(null);
  }, []);

  const feedSignal = useCallback((signal: ProcessedSignal) => {
    if (!reasonerRef.current) return;
    const frame = reasonerRef.current.process(signal);
    setLastFrame(frame);
  }, []);

  return {
    lastFrame,
    isActive,
    start,
    stop,
    feedSignal,
  };
}
