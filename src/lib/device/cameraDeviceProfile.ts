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

const TOLERANT_DEFAULT: Omit<CameraRuntimeHints, 'tclLike' | 'motorolaLike' | 'torchReliable' | 'constrained'> = {
  minPiScale: 0.1,
  ensembleConfScale: 0.5,
  liveFingerMissGrace: 16,
  fingerConfirmFrames: 3,
  instantLostToUnstable: 10,
  instantLostToNoContact: 22,
  bufferResetAfterNoContact: 30,
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

  let profile = { ...base };
  if (!tclLike && (fps > 0 && fps < 18 || jitter > 55)) {
    profile = {
      ...profile,
      liveFingerMissGrace: 40,
      instantLostToNoContact: 60,
      bufferResetAfterNoContact: 70,
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
