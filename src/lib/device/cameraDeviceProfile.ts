/**
 * Perfil de cámara en runtime.
 * TCL suele entregar flash + AE estables; el resto usa modo tolerante por defecto.
 */
export interface CameraRuntimeHints {
  /** false solo en TCL (u otra cámara “probada”) */
  constrained: boolean;
  tclLike: boolean;
  motorolaLike: boolean;
  torchReliable: boolean;
  minPiScale: number;
  ensembleConfScale: number;
  liveFingerMissGrace: number;
  fingerConfirmFrames: number;
  instantLostToUnstable: number;
  instantLostToNoContact: number;
  bufferResetAfterNoContact: number;
  gateRangeScale: number;
}

const TCL_UA = /\bTCL\b|TCL[_\s-]|T671|6156|LE7|LF7/i;
const MOTOROLA_UA = /motorola|moto[\s/_-]|xt\d{4}/i;

export function isTclLikeUserAgent(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return TCL_UA.test(ua);
}

export function isMotorolaLikeUserAgent(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return MOTOROLA_UA.test(ua);
}

// Perfil tolerante (default para la mayoría de dispositivos).
// Ajustes 2026 basados en literatura PPG smartphone (FibriCheck, Welltory)
// para mejorar UX de adquisición:
//   - liveFingerMissGrace: 16 → 12 (~400ms@30fps): menos memoria del dedo
//     ausente, mejor responsividad cuando el usuario quita el dedo.
//   - instantLostToNoContact: 22 → 14 (~466ms@30fps): el sistema reconoce
//     "no hay dedo" más rápido (antes era ~730ms = sensación de "se quedó
//     pegado" en el modal de medición).
//   - fingerConfirmFrames: 3 sin cambio (es responsivo, ~100ms para confirmar).
//   - bufferResetAfterNoContact: 30 → 20 frames para reset DSP más limpio.
const TOLERANT_DEFAULT: Omit<CameraRuntimeHints, 'tclLike' | 'motorolaLike' | 'torchReliable' | 'constrained'> = {
  minPiScale: 0.1,
  ensembleConfScale: 0.5,
  liveFingerMissGrace: 12,
  fingerConfirmFrames: 3,
  instantLostToUnstable: 8,
  instantLostToNoContact: 14,
  bufferResetAfterNoContact: 20,
  gateRangeScale: 0.65,
};

const STRICT_TCL: Omit<CameraRuntimeHints, 'tclLike' | 'motorolaLike' | 'torchReliable' | 'constrained'> = {
  minPiScale: 0.28,
  ensembleConfScale: 1,
  liveFingerMissGrace: 6,
  fingerConfirmFrames: 6,
  instantLostToUnstable: 3,
  instantLostToNoContact: 6,
  bufferResetAfterNoContact: 8,
  gateRangeScale: 0.85,
};

export function inferCameraRuntimeHints(
  cameraDiag?: Record<string, unknown> | null,
): CameraRuntimeHints {
  const ua =
    (typeof cameraDiag?.userAgent === 'string' && cameraDiag.userAgent) ||
    (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const tclLike = isTclLikeUserAgent(ua);
  const motorolaLike = isMotorolaLikeUserAgent(ua);
  const fps = typeof cameraDiag?.fpsEffective === 'number' ? cameraDiag.fpsEffective : 0;
  const jitter =
    typeof cameraDiag?.timestampJitterMs === 'number' ? cameraDiag.timestampJitterMs : 0;
  const torchSupported = cameraDiag?.torchSupported !== false;
  const torchActive = cameraDiag?.torchActive === true;
  const torchReliable = torchSupported && torchActive;

  const base = tclLike ? STRICT_TCL : TOLERANT_DEFAULT;
  const constrained = !tclLike;

  // Degradación por FPS bajo / jitter alto: bajamos los grace periods previos
  // (40/60/70 era demasiado y producía sensación de "el dedo se quedó pegado"
  // por ~2s después de retirarlo). Nuevos valores siguen siendo más tolerantes
  // que el default pero no atrapan al usuario.
  let profile = { ...base };
  if (!tclLike && (fps > 0 && fps < 18 || jitter > 55)) {
    profile = {
      ...profile,
      liveFingerMissGrace: 25,
      instantLostToNoContact: 30,
      bufferResetAfterNoContact: 40,
    };
  }

  return {
    constrained,
    tclLike,
    motorolaLike,
    torchReliable,
    ...profile,
  };
}
