import { useRef, useCallback, useState, useEffect } from 'react';
import { SignalDivider, type DividerResult } from '../modules/signal-divider/SignalDivider';
import { useFrontCameraMotion } from './useFrontCameraMotion';
import { useCompassMotion } from './useCompassMotion';

export interface DividerHRChannel {
  filteredValue: number;
  quality: number;
  confidence: number;
  rawR: number;
  rawG: number;
  rawB: number;
}

export function useSignalDivider() {
  const dividerRef = useRef<SignalDivider | null>(null);
  const lastResultRef = useRef<DividerResult | null>(null);
  const [lastResult, setLastResult] = useState<DividerResult | null>(null);
  const frontCam = useFrontCameraMotion();
  const compass = useCompassMotion();
  const startedRef = useRef(false);

  useEffect(() => {
    dividerRef.current = new SignalDivider();
    return () => { dividerRef.current = null; };
  }, []);

  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    frontCam.start();
    compass.start();
  }, [frontCam, compass]);

  const stop = useCallback(() => {
    startedRef.current = false;
    frontCam.stop();
    compass.stop();
    lastResultRef.current = null;
    setLastResult(null);
  }, [frontCam, compass]);

  const processFrame = useCallback((imageData: ImageData, timestampMs?: number) => {
    const divider = dividerRef.current;
    if (!divider) return;

    divider.setSensorReports(
      frontCam.getMotionReport(),
      compass.getCompassReport(),
      compass.getLastCompassReport(),
      null,
    );

    const result = divider.processFrame(imageData, timestampMs ?? performance.now());
    lastResultRef.current = result;
    setLastResult(result);
  }, [frontCam, compass]);

  const hrChannel: DividerHRChannel | null = lastResultRef.current
    ? {
        filteredValue: lastResultRef.current.channels.hr.filtered,
        quality: lastResultRef.current.channels.hr.quality,
        confidence: lastResultRef.current.channels.hr.confidence,
        rawR: lastResultRef.current.channels.hr.rawR,
        rawG: lastResultRef.current.channels.hr.rawG,
        rawB: lastResultRef.current.channels.hr.rawB,
      }
    : null;

  return {
    processFrame,
    start,
    stop,
    lastResult,
    lastResultRef,
    hrChannel,
    arbiterVerdict: lastResult?.arbiterVerdict ?? null,
    arbiterConsulted: lastResult?.arbiterConsulted ?? false,
    frontCamActive: frontCam.isActive,
    compassActive: compass.isActive,
  };
}
