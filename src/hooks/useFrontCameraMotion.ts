import { useRef, useCallback, useEffect } from 'react';
import type { FrontCameraMotionReport } from '../lib/sensors/motionArbiter';

/** Resolución mínima para detección de movimiento */
const CAM_WIDTH = 160;
const CAM_HEIGHT = 120;
const FPS = 10;

/**
 * Cámara frontal como sensor de movimiento óptico.
 * NO se usa para rPPG — solo para detectar si el usuario se movió
 * comparando frames consecutivos a baja resolución.
 *
 * La cámara frontal ve el entorno (no está tapada por el dedo como la
 * trasera), así que cualquier movimiento del usuario se refleja en
 * cambios de píxeles entre frames.
 */
export function useFrontCameraMotion() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);
  const frameCountRef = useRef(0);
  const rafRef = useRef(0);
  const lastReportRef = useRef<FrontCameraMotionReport>({ meanDiff: 0, changeRatio: 0 });
  const activeRef = useRef(false);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { exact: CAM_WIDTH },
          height: { exact: CAM_HEIGHT },
          frameRate: { ideal: FPS },
        },
        audio: false,
      });

      const video = document.createElement('video');
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;
      video.width = CAM_WIDTH;
      video.height = CAM_HEIGHT;

      const canvas = document.createElement('canvas');
      canvas.width = CAM_WIDTH;
      canvas.height = CAM_HEIGHT;
      const ctx = canvas.getContext('2d')!;

      videoRef.current = video;
      canvasRef.current = canvas;
      streamRef.current = stream;
      activeRef.current = true;

      await video.play();

      const processFrame = () => {
        if (!activeRef.current) return;
        ctx.drawImage(video, 0, 0, CAM_WIDTH, CAM_HEIGHT);
        const imageData = ctx.getImageData(0, 0, CAM_WIDTH, CAM_HEIGHT);
        const pixels = imageData.data;

        const prev = prevFrameRef.current;
        if (prev) {
          let totalDiff = 0;
          let changedPixels = 0;
          const len = pixels.length;
          for (let i = 0; i < len; i += 4) {
            const dr = Math.abs(pixels[i] - prev[i]);
            const dg = Math.abs(pixels[i + 1] - prev[i + 1]);
            const db = Math.abs(pixels[i + 2] - prev[i + 2]);
            const diff = (dr + dg + db) / 3;
            totalDiff += diff;
            if (diff > 15) changedPixels++;
          }
          const pixelCount = len / 4;
          lastReportRef.current = {
            meanDiff: totalDiff / pixelCount,
            changeRatio: changedPixels / pixelCount,
          };
        }

        prevFrameRef.current = new Uint8ClampedArray(pixels);
        frameCountRef.current++;
        rafRef.current = requestAnimationFrame(processFrame);
      };

      rafRef.current = requestAnimationFrame(processFrame);
    } catch {
      // Fallback silencioso — sin cámara frontal no hay motion sensing
      activeRef.current = false;
    }
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    videoRef.current = null;
    canvasRef.current = null;
    prevFrameRef.current = null;
  }, []);

  /** Obtiene el último reporte de movimiento (llamado desde el pipeline) */
  const getMotionReport = useCallback((): FrontCameraMotionReport | null => {
    return activeRef.current ? lastReportRef.current : null;
  }, []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { start, stop, getMotionReport, isActive: activeRef };
}
