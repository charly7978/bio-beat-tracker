import React, { useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { createLogger } from "@/utils/logger";

const log = createLogger("CameraView");

export interface CameraViewHandle {
  getVideoElement: () => HTMLVideoElement | null;
  getDiagnostics: () => Record<string, unknown>;
}

interface CameraViewProps {
  onStreamReady?: (stream: MediaStream) => void;
  isMonitoring: boolean;
}

/**
 * Cámara PPG optimizada:
 * - Una sola apertura de stream (sin probing invasivo previo).
 * - Selecciona cámara trasera con `facingMode: environment`.
 * - Activa torch con verificación, sin loops de reintentos arbitrarios.
 * - Estabiliza exposición/ISO/foco para fortalecer la señal PPG.
 */

type TorchCapableConstraint = MediaTrackConstraintSet & { torch?: boolean };
type AdvancedConstraint = MediaTrackConstraintSet & {
  torch?: boolean;
  exposureMode?: string;
  exposureCompensation?: number;
  whiteBalanceMode?: string;
  iso?: number;
  focusMode?: string;
  frameRate?: number;
};
type ExtendedCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  exposureMode?: string[];
  exposureCompensation?: { min?: number; max?: number };
  whiteBalanceMode?: string[];
  iso?: { min?: number; max?: number };
  focusMode?: string[];
  frameRate?: { min?: number; max?: number };
};
type ExtendedSettings = MediaTrackSettings & { 
  torch?: boolean;
  exposureMode?: string;
  whiteBalanceMode?: string;
  focusMode?: string;
};

const CameraView = forwardRef<CameraViewHandle, CameraViewProps>(({
  onStreamReady,
  isMonitoring,
}, ref) => {
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
        return {
          active: true,
          label: track.label,
          readyState: track.readyState,
          browser: navigator.userAgent,
          userAgent: navigator.userAgent,
          supportedConstraints: Object.keys(navigator.mediaDevices.getSupportedConstraints()),
          capabilities: caps,
          settings: settings,
          torchSupported: !!caps.torch,
          torchActive: settings.torch === true,
          fpsRequested: 30,
          fpsEffective: settings.frameRate || 0,
          resolution: { width: settings.width || 0, height: settings.height || 0 },
          exposureMode: settings.exposureMode,
          whiteBalanceMode: settings.whiteBalanceMode,
          focusMode: settings.focusMode,
        };
      } catch {
        return { active: true, error: "caps_unavailable" };
      }
    },
  }), []);

  useEffect(() => {
    let mounted = true;

    const stopCamera = async () => {
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getVideoTracks()) {
          try {
            const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
            if (caps.torch) {
              await track.applyConstraints({
                advanced: [{ torch: false } as TorchCapableConstraint],
              });
            }
          } catch {
            /* torch off best-effort */
          }
          track.stop();
        }
        streamRef.current = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      isStartingRef.current = false;
    };

    const activateTorch = async (track: MediaStreamTrack): Promise<boolean> => {
      const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
      if (!caps.torch) {
        log.warn("Esta cámara no soporta torch");
        return false;
      }
      try {
        await track.applyConstraints({
          advanced: [{ torch: true } as TorchCapableConstraint],
        });
        const settings = (track.getSettings?.() ?? {}) as ExtendedSettings;
        return settings.torch !== false;
      } catch (e) {
        log.warn("Fallo al activar torch", e);
        return false;
      }
    };

    const stabilizeTrack = async (track: MediaStreamTrack) => {
      const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
      const constraints: AdvancedConstraint[] = [];

      if (caps.frameRate) constraints.push({ frameRate: 30 });

      if (caps.exposureMode?.includes("manual")) {
        constraints.push({ exposureMode: "manual" });
      } else if (caps.exposureMode?.includes("continuous")) {
        constraints.push({ exposureMode: "continuous" });
      }

      if (caps.exposureCompensation) {
        const minExp = caps.exposureCompensation.min ?? -2;
        const maxExp = caps.exposureCompensation.max ?? 2;
        const targetExp = Math.max(minExp, Math.min(maxExp, -0.35));
        constraints.push({ exposureCompensation: targetExp });
      }

      if (caps.whiteBalanceMode?.includes("manual")) {
        constraints.push({ whiteBalanceMode: "manual" });
      }

      if (caps.iso) {
        const minISO = caps.iso.min ?? 50;
        const maxISO = caps.iso.max ?? 400;
        const targetISO = Math.max(minISO, Math.min(maxISO, 140));
        constraints.push({ iso: targetISO });
      }

      if (caps.focusMode?.includes("manual")) {
        constraints.push({ focusMode: "manual" });
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
    };

    const waitForVideo = (video: HTMLVideoElement): Promise<void> => {
      return new Promise((resolve) => {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          resolve();
          return;
        }
        const onMeta = async () => {
          video.removeEventListener("loadedmetadata", onMeta);
          try {
            await video.play();
          } catch {
            /* play() rejection is fine; video continues to render */
          }
          resolve();
        };
        video.addEventListener("loadedmetadata", onMeta);
      });
    };

    const startCamera = async () => {
      if (isStartingRef.current) return;
      isStartingRef.current = true;

      await stopCamera();
      if (!mounted) {
        isStartingRef.current = false;
        return;
      }

      try {
        // Una sola apertura: facingMode environment + constraints óptimos para PPG.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 640, max: 960 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 60, min: 24, max: 60 },
          },
        });

        if (!mounted) {
          stream.getTracks().forEach((t) => t.stop());
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
          const torchOn = await activateTorch(track);
          if (torchOn) log.info("Flash activado");
          await stabilizeTrack(track);
        }

        log.info(
          `Cámara lista ${videoRef.current?.videoWidth ?? "?"}x${videoRef.current?.videoHeight ?? "?"}`
        );
        onStreamReady?.(stream);
      } catch (err) {
        log.error("Error al inicializar cámara", err);
        // Dispatch event for UI notification
        window.dispatchEvent(new CustomEvent('camera-error', { detail: err }));
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
      mounted = false;
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
        opacity: 1,
        pointerEvents: "none",
      }}
    />
  );
});

CameraView.displayName = "CameraView";

export default CameraView;
