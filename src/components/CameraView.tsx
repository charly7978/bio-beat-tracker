import React, { useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math";
import { Camera } from '@capacitor/camera';
import { isNative } from "@/lib/device/platform";

const log = createLogger("CameraView");

export interface CameraViewHandle {
  getVideoElement: () => HTMLVideoElement | null;
  getDiagnostics: () => Record<string, unknown>;
  /**
   * Optimiza ACTIVAMENTE el hardware para el dedo ya colocado: bloquea foco cercano
   * y balance de blancos (anti-deriva), y AJUSTA la exposición/ISO según el nivel
   * REAL del rojo medido (`redLevel` 0–255) hacia la ventana óptima (sin saturar ni
   * quedar oscuro). Una sola vez en STABLE_CONTACT (timing seguro vs deriva del AE).
   */
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
};
type ExtendedCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  exposureMode?: string[];
  exposureCompensation?: { min?: number; max?: number };
  exposureTime?: { min?: number; max?: number };
  whiteBalanceMode?: string[];
  iso?: { min?: number; max?: number };
  focusMode?: string[];
  focusDistance?: { min?: number; max?: number };
  frameRate?: { min?: number; max?: number };
};
type ExtendedSettings = MediaTrackSettings & {
  torch?: boolean;
  exposureMode?: string;
  whiteBalanceMode?: string;
  focusMode?: string;
  iso?: number;
  exposureCompensation?: number;
  exposureTime?: number;
};

async function requestCameraPermission(): Promise<boolean> {
  if (!isNative()) return true;
  try {
    const result = await Camera.requestPermissions({ permissions: ['camera'] });
    const granted = result.camera === 'granted';
    if (!granted) log.warn("Permiso de cámara denegado por el usuario en diálogo nativo");
    return granted;
  } catch (err) {
    log.error("Error al solicitar permiso nativo de cámara", err);
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

async function stabilizeTrack(track: MediaStreamTrack): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  const constraints: AdvancedConstraint[] = [];

  if (caps.frameRate) {
    const maxFps = caps.frameRate.max ?? 30;
    const targetFps = Math.min(30, maxFps);
    constraints.push({ frameRate: targetFps });
  }

  if (caps.exposureMode?.includes("manual")) {
    constraints.push({ exposureMode: "manual" });
  } else if (caps.exposureMode?.includes("continuous")) {
    constraints.push({ exposureMode: "continuous" });
  }

  if (caps.whiteBalanceMode?.includes("manual")) {
    constraints.push({ whiteBalanceMode: "manual" });
  }

  if (caps.focusMode?.includes("manual")) {
    constraints.push({ focusMode: "manual", focusDistance: 0 });
  } else if (caps.focusMode?.includes("continuous")) {
    constraints.push({ focusMode: "continuous" });
  }

  if (constraints.length > 0) {
    try {
      await track.applyConstraints({ advanced: constraints });
    } catch (e) {
      log.warn("No se pudieron estabilizar parámetros de cámara", e);
    }
  }
}

async function applyTorchDependentParams(track: MediaStreamTrack, torchOn: boolean): Promise<void> {
  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  const constraints: AdvancedConstraint[] = [];

  if (torchOn) {
    if (caps.iso) {
      const minISO = caps.iso.min ?? 50;
      const maxISO = caps.iso.max ?? 400;
      const targetISO = Math.max(minISO, Math.min(maxISO, 140));
      constraints.push({ iso: targetISO });
    }
    if (caps.exposureCompensation) {
      const minExp = caps.exposureCompensation.min ?? -2;
      const maxExp = caps.exposureCompensation.max ?? 2;
      const targetExp = Math.max(minExp, Math.min(maxExp, -0.35));
      constraints.push({ exposureCompensation: targetExp });
    }
  } else {
    if (caps.iso) {
      const minISO = caps.iso.min ?? 50;
      const maxISO = caps.iso.max ?? 800;
      const targetISO = Math.max(minISO, Math.min(maxISO, 400));
      constraints.push({ iso: targetISO });
    }
    if (caps.exposureCompensation) {
      const minExp = caps.exposureCompensation.min ?? -2;
      const maxExp = caps.exposureCompensation.max ?? 2;
      const targetExp = Math.max(minExp, Math.min(maxExp, 0));
      constraints.push({ exposureCompensation: targetExp });
    }
  }

  if (constraints.length > 0) {
    try {
      await track.applyConstraints({ advanced: constraints });
    } catch (e) {
      log.warn("No se pudieron aplicar parámetros post-torch", e);
    }
  }
}

const CameraView = forwardRef<CameraViewHandle, CameraViewProps>((
  { onStreamReady, isMonitoring},
  ref
) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  const streamRef = useRef<MediaStream | null>(null);

  const isStartingRef = useRef(false);


  useImperativeHandle(ref, () => ({
    getVideoElement: () => videoRef.current,
    getDiagnostics: () => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (!track) return { active: false };
      try {
        const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
        const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
        let applied: MediaTrackConstraints | undefined;
        const torchVerified = settings.torch === true;
        try {
          applied = track.getConstraints?.();
        } catch {
          log.debug('getConstraints not available');
          applied = undefined;
        }
        return {
          active: true,
          label: track.label,
          readyState: track.readyState,
          browser: navigator.userAgent,
          userAgent: navigator.userAgent,
          supportedConstraints: Object.keys(navigator.mediaDevices.getSupportedConstraints()),
          capabilities: caps,
          settings: settings,
          appliedConstraints: applied,
          torchSupported: !!caps.torch,
          torchActive: settings.torch === true,
          torchApplyVerified: torchVerified,
          fpsRequested: 30,
          fpsEffective: settings.frameRate || 0,
          resolution: { width: settings.width || 0, height: settings.height || 0 },
          exposureMode: settings.exposureMode,
          whiteBalanceMode: settings.whiteBalanceMode,
          focusMode: settings.focusMode,
        };
      } catch {
        log.warn('Camera diagnostics failed');
        return { active: true, error: "caps_unavailable" };
      }
    },
    optimizeForFinger: (redLevel: number) => {
      const track = streamRef.current?.getVideoTracks?.()[0];
      if (!track) return;
      void (async () => {
        try {
          const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
          const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
          const constraints: AdvancedConstraint[] = [];

          if (caps.focusMode?.includes("manual")) {
            const near = typeof caps.focusDistance?.min === "number" ? caps.focusDistance.min : 0;
            constraints.push({ focusMode: "manual", focusDistance: near });
          }
          if (caps.whiteBalanceMode?.includes("manual")) {
            constraints.push({ whiteBalanceMode: "manual" });
          }
          if (caps.exposureMode?.includes("manual") && redLevel > 0) {
            constraints.push({ exposureMode: "manual" });
            const TARGET = 180;
            const ratio = clamp(TARGET / redLevel, 0.45, 2.2);
            if (caps.iso && typeof caps.iso.max === "number") {
              const isoMin = caps.iso.min ?? 25;
              const isoMax = caps.iso.max ?? 800;
              const curIso = settings.iso ?? (isoMin + isoMax) / 2;
              constraints.push({ iso: clamp(Math.round(curIso * ratio), isoMin, isoMax) });
            } else if (caps.exposureCompensation) {
              const evMin = caps.exposureCompensation.min ?? -2;
              const evMax = caps.exposureCompensation.max ?? 2;
              const curEv = settings.exposureCompensation ?? 0;
              constraints.push({
                exposureCompensation: clamp(curEv + clamp(Math.log2(ratio), -1, 1), evMin, evMax),
              });
            } else if (caps.exposureTime && typeof settings.exposureTime === "number") {
              const etMin = caps.exposureTime.min ?? settings.exposureTime;
              const etMax = caps.exposureTime.max ?? settings.exposureTime;
              constraints.push({ exposureTime: clamp(settings.exposureTime * ratio, etMin, etMax) });
            }
          }

          if (constraints.length > 0) {
            await track.applyConstraints({ advanced: constraints });
            log.info(`Cámara optimizada al dedo (red=${redLevel.toFixed(0)}, ${constraints.length} ajustes)`);
          }
        } catch (e) {
          log.warn("optimizeForFinger falló (best-effort)", e);
        }
      })();
    },
  }), []);

  useEffect(() => {
    const mountedRef = { current: true };

    const stopCamera = async () => {
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getVideoTracks()) {
          try {
            await track.applyConstraints({
              advanced: [{ torch: false } as TorchCapableConstraint],
            });
          } catch { log.debug('Torch off (advanced) failed — trying direct'); }
          try {
            await track.applyConstraints({ torch: false } as MediaTrackConstraints);
          } catch { log.debug('Torch off (direct) failed — expected if unsupported'); }
          track.stop();
        }
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;

      isStartingRef.current = false;
    };

    const activateTorch = async (track: MediaStreamTrack): Promise<boolean> => {
      const attempts = [
        { advanced: [{ torch: true } as TorchCapableConstraint] },
        { torch: true } as TorchCapableConstraint,
        { advanced: [{ torch: 'on' }] },
        { advanced: [{ torchMode: 'torch' }] },
      ] as MediaTrackConstraints[];
      for (const constraints of attempts) {
        try {
          await track.applyConstraints(constraints);
          const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
          if (settings.torch === true) return true;
        } catch { log.debug('Torch attempt failed — trying next syntax'); }
      }
      // Último intento: sin verificar settings, confiar en que applyConstraints funcionó
      try {
        await track.applyConstraints({ advanced: [{ torch: true } as TorchCapableConstraint] });
        return true;
      } catch { log.debug('Torch not available on this device'); }
      log.warn("Torch no disponible en este dispositivo");
      return false;
    };

    const waitForVideo = (video: HTMLVideoElement): Promise<void> => {
      return new Promise(resolve => {
        if (video.readyState >= 2 && video.videoWidth > 0) { resolve(); return; }
        const onMeta = async () => {
          video.removeEventListener("loadedmetadata", onMeta);
          try { await video.play(); } catch { log.debug('Video play() rejected (autoplay policy)'); }
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

      // 1. Solicitar permiso nativo en APK antes de getUserMedia
      const permitted = await requestCameraPermission();
      if (!permitted) {
        log.error("Permiso de cámara denegado");
        window.dispatchEvent(new CustomEvent('camera-error', {
          detail: { type: 'permission_denied', message: 'Permiso de cámara denegado' },
        }));
        isStartingRef.current = false;
        return;
      }

      try {
        // 2. Cámara Trasera (Dedo + PPG)
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 640, max: 960 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 30, min: 15, max: 30 },
          },
        });

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
            await new Promise(r => setTimeout(r, 400));
            torchOn = await activateTorch(track);
          }
          if (torchOn) log.info("Flash activado");
          else log.warn("Flash no confirmado — se usará perfil de cámara tolerante");
          await applyTorchDependentParams(track, torchOn);
        }

        log.info(`Cámara trasera lista ${videoRef.current?.videoWidth ?? "?"}x${videoRef.current?.videoHeight ?? "?"}`);

        onStreamReady?.(stream);


      } catch (err) {
        const errType = classifyCameraError(err);
        log.error(`Error al inicializar cámara trasera (${errType})`, err);

        // Reintentar con constraints relajados si es OverconstrainedError
        if (errType === 'overconstrained' && mountedRef.current) {
          log.warn("Reintentando con constraints relajados...");
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { facingMode: { ideal: "environment" } },
            });
            if (mountedRef.current) {
              streamRef.current = fallbackStream;
              if (videoRef.current) {
                videoRef.current.srcObject = fallbackStream;
                await waitForVideo(videoRef.current);
              }
              const track = fallbackStream.getVideoTracks()[0];
              if (track) await stabilizeTrack(track);
              log.info("Cámara iniciada con constraints relajados");
              onStreamReady?.(fallbackStream);
              isStartingRef.current = false;
              return;
            }
          } catch (fallbackErr) {
            log.error("Reintento con constraints relajados también falló", fallbackErr);
          }
        }

        window.dispatchEvent(new CustomEvent('camera-error', {
          detail: { type: errType, message: (err as Error)?.message || 'Error desconocido' },
        }));
      } finally {
        isStartingRef.current = false;
      }
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
    <>
      {/* Cámara trasera principal (fondo completo) */}
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
    </>
  );
});

CameraView.displayName = "CameraView";

export default CameraView;
