/**
 * Perfil en runtime según cámara real (UA, FPS, torch, jitter).
 * Motorola y varios Android fallan en torch/AE → umbrales más tolerantes sin duplicar processors.
 */
export interface CameraRuntimeHints {
  constrained: boolean;
  motorolaLike: boolean;
  torchReliable: boolean;
  /** Escala sobre MIN_PI para vitalsReady (p.ej. 0.28 → 0.16 en Motorola) */
  minPiScale: number;
  /** Multiplicador de confianza mínima ensemble (1 = normal, 0.75 = más permisivo) */
  ensembleConfScale: number;
  /** Frames sin liveFinger antes de cortar contacto */
  liveFingerMissGrace: number;
}

const MOTOROLA_UA = /motorola|moto[\s/_-]|xt\d{4}|motorola\sone/i;

export function isMotorolaLikeUserAgent(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return MOTOROLA_UA.test(ua);
}

export function inferCameraRuntimeHints(
  cameraDiag?: Record<string, unknown> | null,
): CameraRuntimeHints {
  const ua =
    (typeof cameraDiag?.userAgent === 'string' && cameraDiag.userAgent) ||
    (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const motorolaLike = isMotorolaLikeUserAgent(ua);
  const fps = typeof cameraDiag?.fpsEffective === 'number' ? cameraDiag.fpsEffective : 0;
  const jitter =
    typeof cameraDiag?.timestampJitterMs === 'number' ? cameraDiag.timestampJitterMs : 0;
  const torchSupported = cameraDiag?.torchSupported !== false;
  const torchActive = cameraDiag?.torchActive === true;
  const torchReliable = torchSupported && torchActive;

  const lowFps = fps > 0 && fps < 22;
  const highJitter = jitter > 45;
  const constrained = motorolaLike || lowFps || highJitter || (torchSupported && !torchActive);

  return {
    constrained,
    motorolaLike,
    torchReliable,
    minPiScale: constrained ? 0.16 : 0.28,
    ensembleConfScale: constrained ? 0.72 : 1,
    liveFingerMissGrace: constrained ? 14 : 6,
  };
}
