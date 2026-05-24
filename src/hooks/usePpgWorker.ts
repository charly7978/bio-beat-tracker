import { useRef, useState, useCallback, useEffect } from 'react';
import { PpgWorkerManager, WorkerStatus, WorkerFrameResult } from '../modules/worker/PpgWorkerManager';

interface UsePpgWorkerOptions {
  canvasWidth?: number;
  canvasHeight?: number;
  enabled?: boolean;
}

export function usePpgWorker({
  canvasWidth = 320,
  canvasHeight = 240,
  enabled = true,
}: UsePpgWorkerOptions = {}) {
  const managerRef = useRef<PpgWorkerManager | null>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>('unavailable');
  const lastResultRef = useRef<WorkerFrameResult | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;

    const init = async () => {
      const mgr = new PpgWorkerManager();
      const ok = await mgr.init(canvasWidth, canvasHeight);
      if (mounted) {
        managerRef.current = ok ? mgr : null;
        setWorkerStatus(ok ? 'ready' : 'unavailable');
      } else {
        mgr.terminate();
      }
    };
    init();

    return () => {
      mounted = false;
      managerRef.current?.terminate();
      managerRef.current = null;
      setWorkerStatus('unavailable');
    };
  }, [canvasWidth, canvasHeight, enabled]);

  const processOffMain = useCallback(
    (imageData: ImageData, timestamp: number): Promise<WorkerFrameResult> | null => {
      const mgr = managerRef.current;
      if (!mgr || !mgr.isAvailable() || mgr.isBusy()) return null;

      const promise = mgr.processFrame(imageData, timestamp);
      if (promise) {
        promise.then((result) => {
          lastResultRef.current = result;
        }).catch(() => {});
      }
      return promise;
    },
    [],
  );

  const getLastResult = useCallback((): WorkerFrameResult | null => {
    return lastResultRef.current;
  }, []);

  return {
    workerStatus,
    processOffMain,
    getLastResult,
    isAvailable: workerStatus === 'ready',
    manager: managerRef.current,
  };
}
