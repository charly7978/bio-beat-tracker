import React, { useEffect, useRef, useState } from "react";
import type { CameraViewHandle } from "@/components/CameraView";

interface FingerPeepholeProps {
  cameraRef: React.RefObject<CameraViewHandle>;
  isActive: boolean;
  isFingerDetected?: boolean;
  quality?: number;
  /** Diámetro CSS del círculo. Un dedo humano en cámara ≈ 72-88px CSS. */
  size?: number;
}

/**
 * Peephole circular sutil que muestra en vivo el feed de la cámara trasera,
 * para que el usuario pueda ver si su dedo está bien apoyado sobre el lente.
 * Comparte el MediaStream con <CameraView/> (un mismo stream alimenta múltiples
 * elementos <video>). No consume otro sensor ni afecta el pipeline PPG.
 */
const FingerPeephole: React.FC<FingerPeepholeProps> = ({
  cameraRef,
  isActive,
  isFingerDetected = false,
  quality = 0,
  size = 78,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasStream, setHasStream] = useState(false);

  useEffect(() => {
    if (!isActive) {
      if (videoRef.current) videoRef.current.srcObject = null;
      setHasStream(false);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const attach = () => {
      if (cancelled) return;
      const src = cameraRef.current?.getVideoElement();
      const stream = (src?.srcObject as MediaStream | null) ?? null;
      if (stream && videoRef.current && videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => undefined);
        setHasStream(true);
        return;
      }
      if (!stream && attempts < 40) {
        attempts += 1;
        window.setTimeout(attach, 150);
      }
    };
    attach();
    return () => {
      cancelled = true;
    };
  }, [isActive, cameraRef]);

  // Anillo de color según calidad de contacto: neutro / ámbar / esmeralda.
  const ringColor = !isActive
    ? "rgba(160,160,160,0.35)"
    : isFingerDetected && quality >= 55
    ? "rgba(52, 211, 153, 0.85)"     // emerald
    : isFingerDetected
    ? "rgba(250, 204, 21, 0.85)"      // amber
    : "rgba(148, 163, 184, 0.55)";    // slate

  const glow = isFingerDetected
    ? `0 0 0 1px rgba(255,255,255,0.08), 0 0 22px ${ringColor}, inset 0 0 12px rgba(0,0,0,0.55)`
    : `0 0 0 1px rgba(255,255,255,0.06), 0 0 10px rgba(0,0,0,0.55), inset 0 0 10px rgba(0,0,0,0.55)`;

  return (
    <div
      aria-hidden={!isActive}
      className="pointer-events-none absolute z-40 select-none"
      style={{
        top: 14,
        left: "50%",
        transform: "translateX(-50%)",
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          overflow: "hidden",
          position: "relative",
          border: `1.5px solid ${ringColor}`,
          boxShadow: glow,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
          transition: "border-color 220ms ease, box-shadow 220ms ease",
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: hasStream ? 0.95 : 0,
            transition: "opacity 300ms ease",
          }}
        />
        {/* Retícula sutil tipo visor médico */}
        <svg
          viewBox="0 0 100 100"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            mixBlendMode: "screen",
            opacity: 0.55,
          }}
        >
          <circle cx="50" cy="50" r="30" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="0.6" />
          <line x1="50" y1="18" x2="50" y2="28" stroke="rgba(255,255,255,0.25)" strokeWidth="0.6" />
          <line x1="50" y1="72" x2="50" y2="82" stroke="rgba(255,255,255,0.25)" strokeWidth="0.6" />
          <line x1="18" y1="50" x2="28" y2="50" stroke="rgba(255,255,255,0.25)" strokeWidth="0.6" />
          <line x1="72" y1="50" x2="82" y2="50" stroke="rgba(255,255,255,0.25)" strokeWidth="0.6" />
        </svg>
        {/* Viñeta interior para integrarlo con el fondo oscuro del monitor */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            boxShadow: "inset 0 0 18px rgba(0,0,0,0.55)",
            pointerEvents: "none",
          }}
        />
      </div>
      <div
        style={{
          marginTop: 4,
          textAlign: "center",
          fontSize: 8,
          letterSpacing: "0.25em",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          color: isFingerDetected ? "rgba(226,232,240,0.85)" : "rgba(148,163,184,0.75)",
          textShadow: "0 1px 2px rgba(0,0,0,0.8)",
        }}
      >
        DEDO
      </div>
    </div>
  );
};

export default FingerPeephole;
