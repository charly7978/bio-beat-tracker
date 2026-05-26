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

  const startFrameLoop = useCallback(() => {
    if (isProcessingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    isProcessingRef.current = true;

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
        processFrame(imageData, frameTimestampMs);
      } catch {
        /* drawImage / getImageData can throw if the video tears down mid-frame */
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
        ppgPerf.markFrame();
        frameLoopRef.current = requestAnimationFrame((ts) => captureOneFrame(ts));
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
