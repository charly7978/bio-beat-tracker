import { useRef, useCallback } from 'react';
import type { CameraViewHandle } from '@/components/CameraView';
import { ppgPerf, logWarn } from '@/utils/logger';

interface UseFrameLoopInput {
  cameraRef: React.RefObject<CameraViewHandle>;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  ctxRef: React.MutableRefObject<CanvasRenderingContext2D | null>;
  processFrame: (imageData: ImageData, timestamp?: number) => void;
}

/**
 * Firma barata del contenido del frame = suma ponderada de los canales verde y
 * rojo sobre una grilla dispersa (~1 de cada 16 px). Dos canales combinados
 * reducen colisiones: un cambio en luminancia (afecta a ambos) se distingue de
 * un cambio cromático puro. Permite descartar FRAMES DUPLICADOS (el dispositivo
 * entrega ~30 fps reales pero rAF dispara ~60 → la mitad de los frames son
 * idénticos → valor repetido → onda escalonada + sample-rate mal estimado).
 */
function frameSignature(img: ImageData): number {
  const d = img.data;
  const n = d.length;
  let sumG = 0, sumR = 0;
  for (let i = 0; i < n; i += 64) {
    sumR += d[i];       // canal rojo
    sumG += d[i + 1];   // canal verde
  }
  return sumR * 1e4 + sumG;
}

export function useFrameLoop({ cameraRef, canvasRef, ctxRef, processFrame }: UseFrameLoopInput) {
  const frameLoopRef = useRef<number | null>(null);
  const videoFrameLoopRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);
  const lastFrameSigRef = useRef<number>(-1);
  const duplicateStreakRef = useRef<number>(0);
  const lastRafTsRef = useRef<number>(0);

  const startFrameLoop = useCallback(() => {
    if (isProcessingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    isProcessingRef.current = true;
    lastFrameSigRef.current = -1;
    duplicateStreakRef.current = 0;
    lastRafTsRef.current = 0;

    const captureOneFrame = (frameTimestampMs?: number) => {
      if (!isProcessingRef.current) return;
      const video = cameraRef.current?.getVideoElement();
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        frameLoopRef.current = requestAnimationFrame(captureOneFrame);
        return;
      }
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // Descarta frames DUPLICADOS (idénticos al anterior)
        const sig = frameSignature(imageData);
        if (sig === lastFrameSigRef.current && duplicateStreakRef.current < 90) {
          duplicateStreakRef.current++;
        } else {
          duplicateStreakRef.current = 0;
          lastFrameSigRef.current = sig;
          processFrame(imageData, frameTimestampMs);
        }
      } catch {
        logWarn('useFrameLoop', 'drawImage/getImageData failed (video teardown)');
      }
      scheduleNext(video);
    };

    const scheduleNext = (video: HTMLVideoElement) => {
      if (!isProcessingRef.current) return;
      const vAny = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
      };
      if (typeof vAny.requestVideoFrameCallback === 'function') {
        videoFrameLoopRef.current = vAny.requestVideoFrameCallback((now, metadata) => {
          ppgPerf.markFrame(metadata);
          const ts =
            typeof now === 'number' && Number.isFinite(now)
              ? now
              : performance.now();
          captureOneFrame(ts);
        });
      } else {
        const tick = (ts: number) => {
          if (!isProcessingRef.current) return;
          if (ts - lastRafTsRef.current < 28) {
            frameLoopRef.current = requestAnimationFrame(tick);
            return;
          }
          lastRafTsRef.current = ts;
          ppgPerf.markFrame();
          captureOneFrame(ts);
        };
        frameLoopRef.current = requestAnimationFrame(tick);
      }
    };

    captureOneFrame(performance.now());
  }, [cameraRef, canvasRef, ctxRef, processFrame]);

  const stopFrameLoop = useCallback(() => {
    isProcessingRef.current = false;
    const video = cameraRef.current?.getVideoElement() as (HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void }) | null;
    if (videoFrameLoopRef.current !== null && typeof video?.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(videoFrameLoopRef.current);
      videoFrameLoopRef.current = null;
    }
    if (frameLoopRef.current) {
      cancelAnimationFrame(frameLoopRef.current);
      frameLoopRef.current = null;
    }
  }, [cameraRef]);

  return { startFrameLoop, stopFrameLoop, isProcessingRef };
}
