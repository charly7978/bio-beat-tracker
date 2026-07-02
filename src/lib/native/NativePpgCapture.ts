import { registerPlugin } from '@capacitor/core';

export interface NativePpgCameraCapability {
  cameraId: string;
  lensFacing: 'back' | 'front' | 'external' | 'unknown';
  flashAvailable: boolean;
  hardwareLevel: string;
  sensorOrientation: number;
  fpsRanges: Array<{ min: number; max: number }>;
  isoRange?: { min: number; max: number };
  exposureTimeRangeNs?: { min: number; max: number };
}

export interface NativePpgCapabilityReport {
  available: boolean;
  provider: 'camera2' | 'camerax' | 'webview' | 'unknown';
  cameras: NativePpgCameraCapability[];
  preferredCameraId?: string;
  reason?: string;
}

export interface NativePpgRuntimeProfile {
  provider: 'camera2' | 'camerax' | 'webview' | 'unknown';
  cameraId?: string;
  torchSupported: boolean;
  torchVerified: boolean;
  targetFps: number;
  fpsMedian?: number;
  fpsJitterP95Ms?: number;
  frameDropRatio?: number;
  exposureLockSupported?: boolean;
  whiteBalanceLockSupported?: boolean;
  isoRange?: { min: number; max: number };
  exposureTimeRangeNs?: { min: number; max: number };
  recommendedResolution?: { width: number; height: number };
  notes?: string[];
}

export interface NativePpgCapturePlugin {
  getCapabilities(): Promise<NativePpgCapabilityReport>;
  configure(options: Record<string, unknown>): Promise<NativePpgRuntimeProfile>;
  start(options?: Record<string, unknown>): Promise<NativePpgRuntimeProfile>;
  stop(): Promise<{ stopped: boolean }>;
  getRuntimeProfile(): Promise<NativePpgRuntimeProfile>;
}

export const NativePpgCapture = registerPlugin<NativePpgCapturePlugin>('NativePpgCapture');

export async function safeNativePpgCapabilities(): Promise<NativePpgCapabilityReport> {
  try {
    return await NativePpgCapture.getCapabilities();
  } catch (err) {
    return {
      available: false,
      provider: 'unknown',
      cameras: [],
      reason: err instanceof Error ? err.message : 'native_capture_unavailable',
    };
  }
}
