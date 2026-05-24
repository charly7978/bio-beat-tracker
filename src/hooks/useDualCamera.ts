import { useRef, useState, useCallback, useEffect } from 'react';
import { FaceRoiExtractor } from '../modules/rppg/FaceRoiExtractor';
import { ChromRppg } from '../modules/rppg/ChromRppg';
import type { RgbFrame } from '../modules/rppg/types';

export type ActiveCamera = 'back' | 'front' | 'none';

const FRONT_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'user' },
  width: { ideal: 320, max: 640 },
  height: { ideal: 240, max: 480 },
  frameRate: { ideal: 15, min: 10, max: 30 },
};

export function useDualCamera() {
  const frontVideoRef = useRef<HTMLVideoElement | null>(null);
  const frontStreamRef = useRef<MediaStream | null>(null);

  const [frontSqi, setFrontSqi] = useState(0);
  const [rppmLiveBpm, setRppmLiveBpm] = useState(0);
  const [rppgConfidence, setRppgConfidence] = useState(0);

  const faceRoiRef = useRef(new FaceRoiExtractor());
  const chromRppgRef = useRef<ChromRppg | null>(null);
  const rppgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rppgCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const frontFrameLoopRef = useRef<number | null>(null);
  const isFrontProcessingRef = useRef(false);

  useEffect(() => {
    if (!rppgCanvasRef.current && typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 240;
      rppgCanvasRef.current = c;
      rppgCtxRef.current = c.getContext('2d', { willReadFrequently: true, alpha: false });
    }
    chromRppgRef.current = new ChromRppg({ windowSize: 150, sampleRate: 30 });
  }, []);

  const startFrontCamera = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: FRONT_CONSTRAINTS,
      });
      frontStreamRef.current = stream;

      const video = frontVideoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  const stopFrontCamera = useCallback(() => {
    if (frontStreamRef.current) {
      frontStreamRef.current.getTracks().forEach((t) => t.stop());
      frontStreamRef.current = null;
    }
    if (frontVideoRef.current) {
      frontVideoRef.current.srcObject = null;
    }
    setFrontSqi(0);
    setRppmLiveBpm(0);
    setRppgConfidence(0);
  }, []);

  const processFrontFrame = useCallback(
    (imageData: ImageData): number => {
      const roi = faceRoiRef.current.extract(imageData);
      const frame: RgbFrame = {
        r: roi.avgR,
        g: roi.avgG,
        b: roi.avgB,
        timestamp: performance.now(),
      };

      chromRppgRef.current?.feed(frame);
      const result = chromRppgRef.current?.process() ?? { pulse: 0, bpm: 0, confidence: 0, chrom: [] };

      const faceCoverage = roi.coverage;
      const sqi = Math.round(result.confidence * faceCoverage * 100);
      setFrontSqi(Math.min(sqi, 100));
      setRppmLiveBpm(result.bpm);
      setRppgConfidence(result.confidence);

      return result.confidence;
    },
    [],
  );

  const startFrontProcessing = useCallback(() => {
    if (isFrontProcessingRef.current) return;
    const canvas = rppgCanvasRef.current;
    const ctx = rppgCtxRef.current;
    if (!canvas || !ctx) return;
    isFrontProcessingRef.current = true;

    const loop = () => {
      if (!isFrontProcessingRef.current) return;
      const video = frontVideoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        frontFrameLoopRef.current = requestAnimationFrame(loop);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      processFrontFrame(imageData);

      frontFrameLoopRef.current = requestAnimationFrame(loop);
    };

    frontFrameLoopRef.current = requestAnimationFrame(loop);
  }, [processFrontFrame]);

  const stopFrontProcessing = useCallback(() => {
    isFrontProcessingRef.current = false;
    if (frontFrameLoopRef.current !== null) {
      cancelAnimationFrame(frontFrameLoopRef.current);
      frontFrameLoopRef.current = null;
    }
    setRppmLiveBpm(0);
    setRppgConfidence(0);
  }, []);

  const updateBackSqi = useCallback((_sqi: number) => {
    // SQI feedback from back camera — reserved for future rPPG/PPG switching
  }, []);

  return {
    frontVideoRef,
    frontStreamRef,
    frontSqi,
    rppmLiveBpm,
    rppgConfidence,
    startFrontCamera,
    stopFrontCamera,
    startFrontProcessing,
    stopFrontProcessing,
    processFrontFrame,
    updateBackSqi,
  };
}
