import { useState, useRef, useCallback, useEffect } from 'react';
import { InferenceService, type ModelStatus, type InferenceResult } from './InferenceService';

export function useInference() {
  const svcRef = useRef<InferenceService | null>(null);
  const [status, setStatus] = useState<ModelStatus>('unloaded');
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<InferenceResult | null>(null);
  const intervalRef = useRef<number>(0);

  const load = useCallback(async () => {
    if (!svcRef.current) svcRef.current = new InferenceService();
    const svc = svcRef.current;
    setStatus('loading');
    await svc.load();
    setStatus(svc.getStatus());
    setError(svc.getError());
  }, []);

  const classify = useCallback(async () => {
    if (!svcRef.current || svcRef.current.getStatus() !== 'ready') return null;
    const result = await svcRef.current.classify();
    if (result) setLastResult(result);
    return result;
  }, []);

  const startPolling = useCallback((intervalMs = 2000) => {
    stopPolling();
    intervalRef.current = window.setInterval(() => {
      classify();
    }, intervalMs);
  }, [classify]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = 0;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  return {
    status,
    error,
    lastResult,
    load,
    classify,
    startPolling,
    stopPolling,
  };
}
