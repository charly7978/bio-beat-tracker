export interface CameraRuntimeHints {
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
  /** Factor de suavizado de exposición para optimizeForFinger (0-1). */
  exposureTrackAlpha: number;
  /** ISO base preferido con flash activo. */
  torchIsoTarget: number;
  /** Exposición compensación base con flash. */
  torchExpComp: number;
}

interface NativeCameraCapabilityLike {
  cameraId: string;
  lensFacing: 'back' | 'front' | 'external' | 'unknown';
  flashAvailable: boolean;
  hardwareLevel?: string;
  fpsRanges?: Array<{ min: number; max: number }>;
  isoRange?: { min: number; max: number };
  exposureTimeRangeNs?: { min: number; max: number };
}

export interface NativeCameraCapabilityReportLike {
  available: boolean;
  provider: 'camera2' | 'camerax' | 'webview' | 'unknown';
  cameras: NativeCameraCapabilityLike[];
  preferredCameraId?: string;
  reason?: string;
}

const TCL_UA = /\bTCL\b|TCL[_\s-]|T671|6156|LE7|LF7/i;
const MOTOROLA_UA = /motorola|moto[\s/_-]|xt\d{4}/i;
const NATIVE_PROFILE_STORAGE_KEY = 'bb-native-camera-profile-v1';

let nativeCapabilityCache: NativeCameraCapabilityReportLike | null = readNativeCapabilityCache();
let nativeProfilePrimed = false;

export function isTclLikeUserAgent(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return TCL_UA.test(ua);
}

export function isMotorolaLikeUserAgent(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return MOTOROLA_UA.test(ua);
}

const TOLERANT_DEFAULT: Omit<CameraRuntimeHints, 'tclLike' | 'motorolaLike' | 'torchReliable' | 'constrained'> = {
  minPiScale: 0.1,
  ensembleConfScale: 0.5,
  liveFingerMissGrace: 32,
  fingerConfirmFrames: 3,
  instantLostToUnstable: 22,
  instantLostToNoContact: 48,
  bufferResetAfterNoContact: 80,
  gateRangeScale: 0.65,
  exposureTrackAlpha: 0.15,
  torchIsoTarget: 140,
  torchExpComp: -0.35,
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
  exposureTrackAlpha: 0.25,
  torchIsoTarget: 100,
  torchExpComp: -0.5,
};

export function primeNativeCameraRuntimeProfile(): void {
  if (nativeProfilePrimed || typeof window === 'undefined') return;
  nativeProfilePrimed = true;
  import('@/lib/native/NativePpgCapture')
    .then(({ safeNativePpgCapabilities }) => safeNativePpgCapabilities())
    .then((report) => {
      nativeCapabilityCache = report;
      try {
        window.localStorage.setItem(NATIVE_PROFILE_STORAGE_KEY, JSON.stringify({
          report,
          selectedCameraId: selectNativePpgCamera(report)?.cameraId,
          bestFps: maxNativeFps(selectNativePpgCamera(report)),
          savedAt: Date.now(),
        }));
      } catch {
        // ignore storage failures
      }
    })
    .catch(() => {
      // Native profile is opportunistic. WebRTC remains the active fallback.
    });
}

export function inferCameraRuntimeHints(
  cameraDiag?: Record<string, unknown> | null,
): CameraRuntimeHints {
  primeNativeCameraRuntimeProfile();
  const nativeFallback = nativeCapabilityCache ? inferNativeCameraRuntimeHints(nativeCapabilityCache, false) : null;
  const ua =
    (typeof cameraDiag?.userAgent === 'string' && cameraDiag.userAgent) ||
    (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const tclLike = isTclLikeUserAgent(ua);
  const motorolaLike = isMotorolaLikeUserAgent(ua);
  const nativeSelected = selectNativePpgCamera(nativeCapabilityCache);
  const nativeFps = maxNativeFps(nativeSelected);
  const fps = typeof cameraDiag?.fpsEffective === 'number'
    ? cameraDiag.fpsEffective
    : nativeFps;
  const jitter =
    typeof cameraDiag?.timestampJitterMs === 'number' ? cameraDiag.timestampJitterMs : (nativeFps >= 30 ? 0 : 70);
  const torchSupported = cameraDiag?.torchSupported !== false && (nativeSelected?.flashAvailable ?? true);
  const torchActive = cameraDiag?.torchActive === true;
  const torchReliable = torchSupported && (torchActive || !!nativeSelected?.flashAvailable);

  const base = tclLike ? STRICT_TCL : TOLERANT_DEFAULT;
  const constrained = !tclLike || !!nativeFallback?.constrained;

  let profile = { ...base };
  if (!tclLike && (fps > 0 && fps < 18 || jitter > 55)) {
    profile = {
      ...profile,
      liveFingerMissGrace: 40,
      instantLostToNoContact: 60,
      bufferResetAfterNoContact: 70,
    };
  }

  const nativeIsoMid = nativeSelected?.isoRange
    ? Math.round((nativeSelected.isoRange.min + nativeSelected.isoRange.max) / 2)
    : 0;
  const iso = typeof cameraDiag?.iso === 'number' ? cameraDiag.iso as number : nativeIsoMid;
  const expComp = typeof cameraDiag?.exposureCompensation === 'number' ? cameraDiag.exposureCompensation as number : 0;

  return {
    constrained,
    tclLike,
    motorolaLike,
    torchReliable,
    ...profile,
    exposureTrackAlpha: nativeSelected?.exposureTimeRangeNs
      ? profile.exposureTrackAlpha
      : Math.max(profile.exposureTrackAlpha, nativeFallback?.exposureTrackAlpha ?? profile.exposureTrackAlpha),
    torchIsoTarget: iso > 0 ? Math.round(clampValue(iso * 1.0, 50, 800)) : profile.torchIsoTarget,
    torchExpComp: expComp !== 0 ? clampValue(expComp - 0.3, -2, 2) : profile.torchExpComp,
  };
}

export function inferNativeCameraRuntimeHints(
  report?: NativeCameraCapabilityReportLike | null,
  prime = true,
): CameraRuntimeHints {
  if (prime) primeNativeCameraRuntimeProfile();
  const selected = selectNativePpgCamera(report);
  const fps = maxNativeFps(selected);
  const isoMid = selected?.isoRange
    ? Math.round((selected.isoRange.min + selected.isoRange.max) / 2)
    : undefined;
  const base = inferCameraRuntimeHintsWithoutNative({
    fpsEffective: fps,
    timestampJitterMs: fps >= 30 ? 0 : 70,
    torchSupported: selected?.flashAvailable ?? false,
    torchActive: false,
    iso: isoMid,
  });

  if (!selected) return base;
  return {
    ...base,
    torchReliable: selected.flashAvailable,
    constrained: base.constrained || !selected.flashAvailable || fps < 30,
    exposureTrackAlpha: selected.exposureTimeRangeNs
      ? base.exposureTrackAlpha
      : Math.max(base.exposureTrackAlpha, 0.22),
    torchIsoTarget: selected.isoRange
      ? Math.round(clampValue(isoMid ?? base.torchIsoTarget, 50, 800))
      : base.torchIsoTarget,
  };
}

function inferCameraRuntimeHintsWithoutNative(
  cameraDiag?: Record<string, unknown> | null,
): CameraRuntimeHints {
  const ua =
    (typeof cameraDiag?.userAgent === 'string' && cameraDiag.userAgent) ||
    (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const tclLike = isTclLikeUserAgent(ua);
  const motorolaLike = isMotorolaLikeUserAgent(ua);
  const fps = typeof cameraDiag?.fpsEffective === 'number' ? cameraDiag.fpsEffective : 0;
  const jitter = typeof cameraDiag?.timestampJitterMs === 'number' ? cameraDiag.timestampJitterMs : 0;
  const torchSupported = cameraDiag?.torchSupported !== false;
  const torchActive = cameraDiag?.torchActive === true;
  const torchReliable = torchSupported && torchActive;
  const base = tclLike ? STRICT_TCL : TOLERANT_DEFAULT;
  let profile = { ...base };
  if (!tclLike && (fps > 0 && fps < 18 || jitter > 55)) {
    profile = {
      ...profile,
      liveFingerMissGrace: 40,
      instantLostToNoContact: 60,
      bufferResetAfterNoContact: 70,
    };
  }
  const iso = typeof cameraDiag?.iso === 'number' ? cameraDiag.iso as number : 0;
  const expComp = typeof cameraDiag?.exposureCompensation === 'number' ? cameraDiag.exposureCompensation as number : 0;
  return {
    constrained: !tclLike,
    tclLike,
    motorolaLike,
    torchReliable,
    ...profile,
    torchIsoTarget: iso > 0 ? Math.round(clampValue(iso * 1.0, 50, 800)) : profile.torchIsoTarget,
    torchExpComp: expComp !== 0 ? clampValue(expComp - 0.3, -2, 2) : profile.torchExpComp,
  };
}

export function selectNativePpgCamera(
  report?: NativeCameraCapabilityReportLike | null,
): NativeCameraCapabilityLike | undefined {
  const cameras = report?.cameras ?? [];
  return cameras.find((camera) => camera.cameraId === report?.preferredCameraId)
    ?? cameras.find((camera) => camera.lensFacing === 'back' && camera.flashAvailable)
    ?? cameras.find((camera) => camera.lensFacing === 'back')
    ?? cameras[0];
}

export function maxNativeFps(camera?: NativeCameraCapabilityLike): number {
  return camera?.fpsRanges?.reduce((best, range) => Math.max(best, range.max), 0) ?? 0;
}

function readNativeCapabilityCache(): NativeCameraCapabilityReportLike | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(NATIVE_PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { report?: NativeCameraCapabilityReportLike };
    return parsed.report ?? null;
  } catch {
    return null;
  }
}

function clampValue(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

primeNativeCameraRuntimeProfile();
