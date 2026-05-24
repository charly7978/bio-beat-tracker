import { useRef, useCallback } from 'react';
import type { CameraViewHandle } from '@/components/CameraView';
import { ppgPerf } from '@/utils/logger';

interface UseFrameLoopInput {
  cameraRef: React.RefObject<CameraViewHandle>;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  ctxRef: React.MutableRefObject<CanvasRenderingContext2D | null>;
  processFrame: (imageData: ImageData, timestamp?: number) => void;
}

export function useFrameLoop({ cameraRef, canvasRef, ctxRef, processFrame }: UseFrameLoopInput) {
  const frameLoopRef = useRef<number | null>(null);
  const videoFrameLoopRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);
  const frameBusyRef = useRef(false);
  const frameTimingRef = useRef<{ lastWarning: number; maxMs: number }>({ lastWarning: 0, maxMs: 0 });

  const startFrameLoop = useCallback(() => {
    if (isProcessingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    isProcessingRef.current = true;
    frameBusyRef.current = false;

    const captureOneFrame = (frameTimestampMs?: number) => {
      if (!isProcessingRef.current) return;
      const video = cameraRef.current?.getVideoElement();
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
        frameLoopRef.current = requestAnimationFrame(captureOneFrame);
        return;
      }

      if (frameBusyRef.current) {
        scheduleNext(video);
        return;
      }

      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        frameBusyRef.current = true;
        const t0 = performance.now();
        processFrame(imageData, frameTimestampMs);
        const elapsed = performance.now() - t0;
        frameBusyRef.current = false;

        if (elapsed > 30) {
          const warn = frameTimingRef.current;
          if (elapsed > warn.maxMs) warn.maxMs = elapsed;
          if (t0 - warn.lastWarning > 10000) {
            warn.lastWarning = t0;
            console.warn(`[useFrameLoop] Frame processing exceeded budget: ${elapsed.toFixed(1)}ms (max: ${warn.maxMs.toFixed(1)}ms)`);
          }
        }
      } catch {
        frameBusyRef.current = false;
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
          const ts = typeof now === 'number' && Number.isFinite(now) ? now : performance.now();
          captureOneFrame(ts);
        });
      } else {
        ppgPerf.markFrame();
        frameLoopRef.current = requestAnimationFrame((ts) => captureOneFrame(ts));
      }
    };

    captureOneFrame(performance.now());
  }, [cameraRef, canvasRef, ctxRef, processFrame]);

  const stopFrameLoop = useCallback(() => {
    isProcessingRef.current = false;
    frameBusyRef.current = false;
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
