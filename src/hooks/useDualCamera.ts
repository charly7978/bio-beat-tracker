import { useRef, useState, useCallback, useEffect } from 'react';
import { FaceRoiExtractor } from '../modules/rppg/FaceRoiExtractor';
import { ChromRppg } from '../modules/rppg/ChromRppg';
import type { RgbFrame } from '../modules/rppg/types';

export type ActiveCamera = 'back' | 'front' | 'none';

export interface CameraStream {
  video: HTMLVideoElement | null;
  stream: MediaStream | null;
  facingMode: 'environment' | 'user';
}

export interface DualCameraState {
  back: CameraStream;
  front: CameraStream;
  activeCamera: ActiveCamera;
  backSqi: number;
  frontSqi: number;
  rppmLiveBpm: number;
  rppgConfidence: number;
}

const BACK_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 640, max: 960 },
  height: { ideal: 480, max: 720 },
  frameRate: { ideal: 30, min: 15, max: 30 },
};

const FRONT_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'user' },
  width: { ideal: 320, max: 640 },
  height: { ideal: 240, max: 480 },
  frameRate: { ideal: 15, min: 10, max: 30 },
};

export function useDualCamera({
  sqiThreshold = 30,
  switchDelayMs = 2000,
}: {
  sqiThreshold?: number;
  switchDelayMs?: number;
} = {}) {
  const backVideoRef = useRef<HTMLVideoElement | null>(null);
  const frontVideoRef = useRef<HTMLVideoElement | null>(null);
  const backStreamRef = useRef<MediaStream | null>(null);
  const frontStreamRef = useRef<MediaStream | null>(null);

  const [activeCamera, setActiveCamera] = useState<ActiveCamera>('back');
  const [backSqi, setBackSqi] = useState(0);
  const [frontSqi, setFrontSqi] = useState(0);
  const [rppmLiveBpm, setRppmLiveBpm] = useState(0);
  const [rppgConfidence, setRppgConfidence] = useState(0);

  const faceRoiRef = useRef(new FaceRoiExtractor());
  const chromRppgRef = useRef<ChromRppg | null>(null);
  const switchingRef = useRef(false);
  const lastSwitchTimeRef = useRef(0);
  const rppgCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!rppgCanvasRef.current && typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 240;
      rppgCanvasRef.current = c;
    }
    chromRppgRef.current = new ChromRppg({ windowSize: 150, sampleRate: 30 });
  }, []);

  const openCamera = useCallback(
    async (
      facingMode: 'environment' | 'user',
      videoRef: React.MutableRefObject<HTMLVideoElement | null>,
      streamRef: React.MutableRefObject<MediaStream | null>,
    ): Promise<boolean> => {
      try {
        const constraints: MediaStreamConstraints = {
          audio: false,
          video: facingMode === 'environment' ? BACK_CONSTRAINTS : FRONT_CONSTRAINTS,
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;

        if (!videoRef.current) {
          const video = document.createElement('video');
          video.playsInline = true;
          video.muted = true;
          video.autoplay = true;
          videoRef.current = video;
        }

        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const startCameras = useCallback(async () => {
    const backOk = await openCamera('environment', backVideoRef, backStreamRef);
    if (!backOk) {
      setActiveCamera('none');
      return;
    }
    const frontOk = await openCamera('user', frontVideoRef, frontStreamRef);
    setActiveCamera(backOk ? 'back' : frontOk ? 'front' : 'none');
  }, [openCamera]);

  const stopCameras = useCallback(() => {
    [backStreamRef, frontStreamRef].forEach((sr) => {
      if (sr.current) {
        sr.current.getTracks().forEach((t) => t.stop());
        sr.current = null;
      }
    });
    [backVideoRef, frontVideoRef].forEach((vr) => {
      if (vr.current) {
        vr.current.srcObject = null;
      }
    });
    setActiveCamera('none');
    setBackSqi(0);
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

  const updateBackSqi = useCallback((sqi: number) => {
    setBackSqi(sqi);

    // Automatic switching logic
    const now = performance.now();
    if (switchingRef.current || now - lastSwitchTimeRef.current < switchDelayMs) return;

    if (sqi < sqiThreshold && activeCamera === 'back') {
      switchingRef.current = true;
      lastSwitchTimeRef.current = now;
      setActiveCamera('front');
      setTimeout(() => { switchingRef.current = false; }, switchDelayMs);
    } else if (sqi >= sqiThreshold + 10 && activeCamera === 'front') {
      switchingRef.current = true;
      lastSwitchTimeRef.current = now;
      setActiveCamera('back');
      setTimeout(() => { switchingRef.current = false; }, switchDelayMs);
    }
  }, [sqiThreshold, switchDelayMs, activeCamera]);

  return {
    backVideoRef,
    frontVideoRef,
    backStreamRef,
    frontStreamRef,
    activeCamera,
    backSqi,
    frontSqi,
    rppmLiveBpm,
    rppgConfidence,
    startCameras,
    stopCameras,
    processFrontFrame,
    updateBackSqi,
    setActiveCamera,
  };
}
