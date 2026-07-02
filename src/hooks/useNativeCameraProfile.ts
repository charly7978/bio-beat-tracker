import { useEffect, useState } from 'react';
import { safeNativePpgCapabilities, type NativePpgCapabilityReport } from '@/lib/native/NativePpgCapture';
import { inferNativeCameraRuntimeHints, selectNativePpgCamera, maxNativeFps, type CameraRuntimeHints } from '@/lib/device/cameraDeviceProfile';

const STORAGE_KEY = 'bb-native-camera-profile-v1';

export interface NativeCameraProfileState {
  loading: boolean;
  report: NativePpgCapabilityReport | null;
  hints: CameraRuntimeHints | null;
  selectedCameraId?: string;
  bestFps: number;
  error?: string;
}

export function useNativeCameraProfile(): NativeCameraProfileState {
  const [state, setState] = useState<NativeCameraProfileState>({
    loading: true,
    report: null,
    hints: null,
    bestFps: 0,
  });

  useEffect(() => {
    let cancelled = false;
    safeNativePpgCapabilities()
      .then((report) => {
        if (cancelled) return;
        const selected = selectNativePpgCamera(report);
        const bestFps = maxNativeFps(selected);
        const hints = inferNativeCameraRuntimeHints(report);
        const next: NativeCameraProfileState = {
          loading: false,
          report,
          hints,
          selectedCameraId: selected?.cameraId,
          bestFps,
          error: report.available ? undefined : report.reason,
        };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, savedAt: Date.now() }));
        } catch {
          // ignore storage failures
        }
        setState(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          loading: false,
          report: null,
          hints: null,
          bestFps: 0,
          error: err instanceof Error ? err.message : 'native_profile_failed',
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
