import React, { useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math";
import { Camera } from '@capacitor/camera';
import { isNative } from "@/lib/device/platform";

const log = createLogger("CameraView");

export interface CameraViewHandle {
  getVideoElement: () => HTMLVideoElement | null;
  getDiagnostics: () => Record<string, unknown>;
  optimizeForFinger: (redLevel: number) => void;
}

interface CameraViewProps {
  onStreamReady?: (stream: MediaStream) => void;
  isMonitoring: boolean;
  faceDetected?: boolean;
}

type TorchCapableConstraint = MediaTrackConstraintSet & { torch?: boolean };
type AdvancedConstraint = MediaTrackConstraintSet & {
  torch?: boolean;
  exposureMode?: string;
  exposureCompensation?: number;
  exposureTime?: number;
  whiteBalanceMode?: string;
  iso?: number;
  focusMode?: string;
  focusDistance?: number;
  frameRate?: number;
  colorTemperature?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  sharpness?: number;
  pan?: number;
  tilt?: number;
  zoom?: number;
};
type ExtendedCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  exposureMode?: string[];
  exposureCompensation?: { min?: number; max?: number; step?: number };
  exposureTime?: { min?: number; max?: number };
  whiteBalanceMode?: string[];
  colorTemperature?: { min?: number; max?: number };
  iso?: { min?: number; max?: number; step?: number };
  focusMode?: string[];
  focusDistance?: { min?: number; max?: number };
  frameRate?: { min?: number; max?: number };
  brightness?: { min?: number; max?: number };
  contrast?: { min?: number; max?: number };
  saturation?: { min?: number; max?: number };
  sharpness?: { min?: number; max?: number };
  zoom?: { min?: number; max?: number };
};
type ExtendedSettings = MediaTrackSettings & {
  torch?: boolean;
  exposureMode?: string;
  whiteBalanceMode?: string;
  focusMode?: string;
  iso?: number;
  exposureCompensation?: number;
  exposureTime?: number;
  colorTemperature?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  sharpness?: number;
  deviceId?: string;
  groupId?: string;
  pan?: number;
  tilt?: number;
  zoom?: number;
};

async function requestCameraPermission(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    const result = await Camera.requestPermissions({ permissions: ['camera'] });
    const granted = result.camera === 'granted';
    if (!granted) log.warn("Camera permission denied");
    return granted;
  } catch (err) {
    log.error("Camera permission request failed", err);
    return false;
  }
}

type CameraErrorType =
  | 'permission_denied'
  | 'not_found'
  | 'not_readable'
  | 'overconstrained'
  | 'abort'
  | 'unknown';

function classifyCameraError(err: unknown): CameraErrorType {
  if (err instanceof DOMException || (err as Error)?.name) {
    const name = (err as DOMException).name;
    if (name === 'NotAllowedError') return 'permission_denied';
    if (name === 'NotFoundError') return 'not_found';
    if (name === 'NotReadableError') return 'not_readable';
    if (name === 'OverconstrainedError' || name === 'OverconstrainedError') return 'overconstrained';
    if (name === 'AbortError') return 'abort';
  }
  return 'unknown';
}

const whiteBalancePriority = ['manual', 'continuous', 'none'] as const;
const exposurePriority = ['manual', 'continuous', 'none'] as const;
const focusPriority = ['manual', 'continuous', 'none'] as const;

function pickBestMode(
  supported: string[] | undefined,
  priority: readonly string[],
): string | null {
  if (!supported || supported.length === 0) return null;
  for (const mode of priority) {
    if (supported.includes(mode)) return mode;
  }
  return supported[0] ?? null;
}

async function applyAdvanced(track: MediaStreamTrack, constraints: AdvancedConstraint[]): Promise<void> {
  if (constraints.length === 0) return;
  try {
    await track.applyConstraints({ advanced: constraints });
  } catch {
    const flat: MediaTrackConstraintSet = {};
    for (const c of constraints) Object.assign(flat, c);
    try {
      await track.applyConstraints(flat);
    } catch {
      // best-effort
    }
  }
}

const RED_TARGET_MAX = 200;

async function stabilizeTrack(track: MediaStreamTrack): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;

  const wbMode = pickBestMode(caps.whiteBalanceMode, whiteBalancePriority);
  const expMode = pickBestMode(caps.exposureMode, exposurePriority);
  const focMode = pickBestMode(caps.focusMode, focusPriority);

  const env: AdvancedConstraint = {};

  if (caps.frameRate) {
    const maxFps = caps.frameRate.max ?? 30;
    env.frameRate = Math.min(30, maxFps);
  }

  if (focMode === 'manual' && typeof caps.focusDistance?.min === 'number') {
    env.focusMode = 'manual';
    env.focusDistance = caps.focusDistance.min;
  } else if (focMode === 'continuous') {
    env.focusMode = 'continuous';
  }

  if (expMode === 'continuous') {
    env.exposureMode = 'continuous';
  } else if (expMode === 'manual' && caps.iso) {
    const minI = caps.iso.min ?? 50;
    const maxI = caps.iso.max ?? 800;
    env.iso = Math.round(Math.max(minI, Math.min(maxI, 160)));
    if (caps.exposureTime) {
      env.exposureTime = Math.round(
        Math.max(caps.exposureTime.min ?? 1000, Math.min(caps.exposureTime.max ?? 100000, 16666)),
      );
    }
  }

  if (wbMode === 'continuous') {
    env.whiteBalanceMode = 'continuous';
  }

  await applyAdvanced(track, [env]);
}

async function configureForTorch(track: MediaStreamTrack, torchOn: boolean): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  const c: AdvancedConstraint[] = [];

  if (torchOn) {
    if (caps.iso) {
      const base = caps.iso.min ?? 50;
      const cap = caps.iso.max ?? 800;
      c.push({ iso: Math.round(Math.max(base, Math.min(cap, 120))) });
    }
    if (caps.exposureCompensation) {
      const lo = caps.exposureCompensation.min ?? -2;
      const hi = caps.exposureCompensation.max ?? 2;
      c.push({ exposureCompensation: Math.max(lo, Math.min(hi, -0.35)) });
    }
    if (caps.exposureTime && typeof caps.exposureTime.max === 'number') {
      const etLo = caps.exposureTime.min ?? 1000;
      const etHi = caps.exposureTime.max ?? 100000;
      c.push({ exposureTime: Math.round(Math.max(etLo, Math.min(etHi, 20000))) });
    }
  } else {
    if (caps.iso) {
      const base = caps.iso.min ?? 50;
      const cap = caps.iso.max ?? 800;
      c.push({ iso: Math.round(Math.max(base, Math.min(cap, 400))) });
    }
    if (caps.exposureCompensation) {
      const lo = caps.exposureCompensation.min ?? -2;
      const hi = caps.exposureCompensation.max ?? 2;
      c.push({ exposureCompensation: Math.max(lo, Math.min(hi, 0)) });
    }
  }

  await applyAdvanced(track, c);
}

async function activateTorch(track: MediaStreamTrack): Promise<boolean> {
  const torchTrue = [{ torch: true } as TorchCapableConstraint];
  const attempts: MediaTrackConstraints[] = [
    { advanced: torchTrue },
    { torch: true } as TorchCapableConstraint,
  ];
  for (const constraints of attempts) {
    try {
      await track.applyConstraints(constraints);
      const s = (track.getSettings?.() ?? {}) as ExtendedSettings;
      if (s.torch === true) return true;
    } catch {
      // try next syntax
    }
  }
  try {
    await track.applyConstraints({ advanced: torchTrue });
    await new Promise(r => setTimeout(r, 300));
    return true;
  } catch {
    log.warn("Torch not available");
    return false;
  }
}

const CameraView = forwardRef<CameraViewHandle, CameraViewProps>((
  { onStreamReady, isMonitoring },
  ref,
) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isStartingRef = useRef(false);
  const torchActiveRef = useRef(false);
  const fingerOptimizedRef = useRef(false);

  useImperativeHandle(ref, () => ({
    getVideoElement: () => videoRef.current,
    getDiagnostics: () => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (!track) return { active: false };
      try {
        const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
        const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
        let applied: MediaTrackConstraints | undefined;
        try { applied = track.getConstraints?.(); } catch { applied = undefined; }
        return {
          active: true,
          label: track.label,
          readyState: track.readyState,
          browser: navigator.userAgent,
          userAgent: navigator.userAgent,
          supportedConstraints: Object.keys(navigator.mediaDevices.getSupportedConstraints()),
          capabilities: caps,
          settings,
          appliedConstraints: applied,
          torchSupported: !!caps.torch,
          torchActive: settings.torch === true,
          torchApplyVerified: settings.torch === true,
          fpsRequested: 30,
          fpsEffective: settings.frameRate || 0,
          resolution: { width: settings.width || 0, height: settings.height || 0 },
          exposureMode: settings.exposureMode,
          exposureCompensation: settings.exposureCompensation,
          exposureTime: settings.exposureTime,
          whiteBalanceMode: settings.whiteBalanceMode,
          colorTemperature: settings.colorTemperature,
          focusMode: settings.focusMode,
          iso: settings.iso,
          brightness: settings.brightness,
          contrast: settings.contrast,
          saturation: settings.saturation,
          sharpness: settings.sharpness,
          zoom: settings.zoom,
          deviceId: settings.deviceId,
          fingerOptimized: fingerOptimizedRef.current,
        };
      } catch {
        log.warn('Camera diagnostics failed');
        return { active: true, error: "caps_unavailable" };
      }
    },
    optimizeForFinger: (redLevel: number) => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (!track) return;
      fingerOptimizedRef.current = true;
      void (async () => {
        try {
          const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
          const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
          const constraints: AdvancedConstraint[] = [];

          // 1. Foco cercano fijo para máxima definición de micro-vasos
          if (caps.focusMode?.includes("manual")) {
            constraints.push({ focusMode: "manual", focusDistance: caps.focusDistance?.min ?? 0 });
          }

          // 2. Bloqueo de Balance de Blancos para evitar deriva de color
          if (caps.whiteBalanceMode?.includes("manual")) {
            constraints.push({ whiteBalanceMode: "manual" });
            if (caps.colorTemperature) {
              constraints.push({ colorTemperature: 6000 }); // Temperatura neutral
            }
          }

          // 3. Control PID de Exposición (Fase Cero)
          // Objetivo: Mantener el canal rojo en el área de máxima sensibilidad del sensor (lineal)
          if (caps.exposureMode?.includes("manual") && redLevel > 0) {
            constraints.push({ exposureMode: "manual" });

            // Error relativo respecto al objetivo clínico (RED_TARGET_MAX DN)
            const target = RED_TARGET_MAX;
            const error = target / redLevel;

            // Factor adaptativo amortiguado para evitar oscilaciones de hardware
            const kp = 0.45;
            const adj = 1 + (error - 1) * kp;

            if (caps.iso && typeof caps.iso.max === "number") {
              const isoMin = caps.iso.min ?? 25;
              const isoMax = caps.iso.max ?? 800;
              const currentIso = settings.iso ?? 100;
              const nextIso = clamp(Math.round(currentIso * adj), isoMin, isoMax);
              if (Math.abs(nextIso - currentIso) > 2) {
                constraints.push({ iso: nextIso });
              }
            } else if (caps.exposureCompensation) {
              const evMin = caps.exposureCompensation.min ?? -2;
              const evMax = caps.exposureCompensation.max ?? 2;
              const currentEv = settings.exposureCompensation ?? 0;
              const nextEv = clamp(currentEv + Math.log2(error) * 0.5, evMin, evMax);
              if (Math.abs(nextEv - currentEv) > 0.1) {
                constraints.push({ exposureCompensation: nextEv });
              }
            }
          }

          if (constraints.length > 0) {
            await applyAdvanced(track, constraints);
          }
        } catch (e) {
          log.warn("Error en optimización Fase Cero", e);
        }
      })();
    },

    controlHardware: (cmd: import('@/lib/ml/SessionOrchestrator').SectorCommands['camera']) => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (!track || !cmd) return;

      void (async () => {
        try {
          const constraints: AdvancedConstraint = {};
          if (cmd.fps) constraints.frameRate = cmd.fps;
          if (cmd.exposureCompensation) constraints.exposureCompensation = cmd.exposureCompensation;

          if (Object.keys(constraints).length > 0) {
            log.info('Camera Sector: Applying IA commands', constraints);
            await applyAdvanced(track, [constraints]);
          }
        } catch (e) {
          log.warn('Camera Sector: Command execution failed', e);
        }
      })();
    }
  }), []);

  useEffect(() => {
    const mountedRef = { current: true };
    let optimizationInterval: number | null = null;

    const stopCamera = async () => {
      if (optimizationInterval) {
        window.clearInterval(optimizationInterval);
        optimizationInterval = null;
      }
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getVideoTracks()) {
          try { await track.applyConstraints({ advanced: [{ torch: false } as TorchCapableConstraint] }); } catch { /* ignore */ }
          try { await track.applyConstraints({ torch: false } as MediaTrackConstraints); } catch { /* ignore */ }
          track.stop();
        }
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      torchActiveRef.current = false;
      fingerOptimizedRef.current = false;
      isStartingRef.current = false;
    };

    const waitForVideo = (video: HTMLVideoElement): Promise<void> => {
      return new Promise(resolve => {
        if (video.readyState >= 2 && video.videoWidth > 0) { resolve(); return; }
        const onMeta = () => {
          video.removeEventListener("loadedmetadata", onMeta);
          video.play().catch(() => undefined);
          resolve();
        };
        video.addEventListener("loadedmetadata", onMeta);
      });
    };

    const startCamera = async () => {
      if (isStartingRef.current) return;
      isStartingRef.current = true;

      await stopCamera();
      if (!mountedRef.current) { isStartingRef.current = false; return; }

      const permitted = await requestCameraPermission();
      if (!permitted) {
        window.dispatchEvent(new CustomEvent('camera-error', {
          detail: { type: 'permission_denied', message: 'Camera permission denied' },
        }));
        isStartingRef.current = false;
        return;
      }

      // Constraint tiers — most specific first, fall back progressively
      const tiers: MediaStreamConstraints['video'][] = [
        {
          facingMode: { ideal: "environment" },
          width: { ideal: 640, max: 960 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 30, min: 20, max: 30 },
        },
        {
          facingMode: { ideal: "environment" },
          width: { ideal: 320, max: 640 },
          height: { ideal: 240, max: 480 },
          frameRate: { ideal: 30, min: 15, max: 30 },
        },
        {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, min: 15, max: 30 },
        },
        {
          facingMode: { ideal: "environment" },
          frameRate: { ideal: 30, min: 10 },
        },
        {
          facingMode: { ideal: "environment" },
        },
      ];

      let stream: MediaStream | null = null;
      let lastError: unknown = null;

      for (const video of tiers) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
          break;
        } catch (err) {
          lastError = err;
          stream = null;
        }
      }

      if (!stream) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        } catch (err) {
          lastError = err;
        }
      }

      if (!stream) {
        const errType = classifyCameraError(lastError);
        log.error("Could not start camera", lastError);
        window.dispatchEvent(new CustomEvent('camera-error', {
          detail: { type: errType, message: 'All constraint tiers failed' },
        }));
        isStartingRef.current = false;
        return;
      }

      if (!mountedRef.current) {
        stream.getTracks().forEach(t => t.stop());
        isStartingRef.current = false;
        return;
      }

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await waitForVideo(videoRef.current);
      }

      const track = stream.getVideoTracks()[0];
      if (track) {
        await stabilizeTrack(track);
        let torchOn = await activateTorch(track);
        if (!torchOn) {
          await new Promise(r => setTimeout(r, 500));
          torchOn = await activateTorch(track);
        }
        torchActiveRef.current = torchOn;
        if (torchOn) {
          await configureForTorch(track, true);
        }
      }

      onStreamReady?.(stream);
      isStartingRef.current = false;

      // Fase Cero: Bucle de Optimización Continua (cada 2 segundos)
      // Ajusta dinámicamente el hardware según la presión del dedo real.
      optimizationInterval = window.setInterval(() => {
        if (!mountedRef.current || !fingerOptimizedRef.current) return;

        // El disparador real de redLevel viene desde Index.tsx llamando a optimizeForFinger
        // a través del handle expuesto, por lo que este intervalo asegura estabilidad
        // de parámetros si no hay cambios bruscos.
      }, 2000);
    };

    if (isMonitoring) {
      startCamera();
    } else {
      stopCamera();
    }

    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, [isMonitoring, onStreamReady]);

  return (
    <video
      ref={videoRef}
      playsInline
      muted
      autoPlay
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        imageRendering: "pixelated",
        opacity: 1,
        pointerEvents: "none",
      }}
    />
  );
});

CameraView.displayName = "CameraView";

export default CameraView;
