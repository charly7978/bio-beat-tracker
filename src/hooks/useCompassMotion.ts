import { useRef, useCallback, useEffect } from 'react';
import type { CompassMotionReport } from '../lib/sensors/motionArbiter';

/**
 * Hook que monitorea el magnetómetro/compás del dispositivo.
 * Detecta rotaciones bruscas que indican movimiento del usuario.
 * Se activa solo cuando el pipeline lo necesita (bajo demanda).
 */
export function useCompassMotion() {
  const lastReportRef = useRef<CompassMotionReport | null>(null);
  const currentHeadingRef = useRef<number>(0);
  const activeRef = useRef(false);
  const eventHandlerRef = useRef<((e: DeviceOrientationEvent) => void) | null>(null);

  const start = useCallback(() => {
    if (typeof window === 'undefined' || !window.DeviceOrientationEvent) return;
    activeRef.current = true;

    const handler = (e: DeviceOrientationEvent) => {
      if (!activeRef.current) return;
      const alpha = e.alpha ?? 0;
      const timestamp = performance.now();

      const last = lastReportRef.current;
      const delta = last ? deltaHeading(alpha, last.heading) : 0;

      lastReportRef.current = {
        heading: alpha,
        deltaDegrees: delta,
        timestamp,
      };
      currentHeadingRef.current = alpha;
    };

    eventHandlerRef.current = handler;
    window.addEventListener('deviceorientation', handler);
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (eventHandlerRef.current) {
      window.removeEventListener('deviceorientation', eventHandlerRef.current);
      eventHandlerRef.current = null;
    }
  }, []);

  const getCompassReport = useCallback((): CompassMotionReport | null => {
    return activeRef.current ? lastReportRef.current : null;
  }, []);

  const getLastCompassReport = useCallback((): CompassMotionReport | null => {
    return activeRef.current ? lastReportRef.current : null;
  }, []);

  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { start, stop, getCompassReport, getLastCompassReport, isActive: activeRef };
}

/** Diferencia angular mínima (maneja cruce por 0/360) */
function deltaHeading(current: number, previous: number): number {
  let d = current - previous;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
