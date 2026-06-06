import { useState, useRef, useCallback, useEffect } from 'react';
import { playCompletionSound } from '@/utils/soundUtils';
import { triggerSessionStartHaptic, triggerSessionEndHaptic } from '@/utils/haptics';
import { logWarn } from '@/utils/logger';
import { inferCameraRuntimeHints } from '@/lib/device/cameraDeviceProfile';
import { createDefaultVitalSignsResult } from '@/lib/vitals/defaultVitalSignsResult';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import {
  setActiveProfile as setAuditProfile,
} from '@/lib/sanity/sanityAuditLog';
import type { CameraViewHandle } from '@/components/CameraView';
import type { ValidationFrame } from '@/lib/acquisition/MeasurementWindowValidator';

interface UseMeasurementSessionInput {
  cameraRef: React.RefObject<CameraViewHandle>;
  startFrameLoop: () => void;
  stopFrameLoop: () => void;
  startProcessing: () => void;
  stopProcessing: () => void;
  startCalibration: () => void;
  forceCalibrationCompletion: () => void;
  resetVitalSigns: () => VitalSignsResult | null;
  fullResetVitalSigns: () => void;
  resetHeartBeat: () => void;
  saveMeasurement: (data: {
    vitalSigns: VitalSignsResult;
    signalQuality: number;
    artifactMetrics?: {
      motionArtifactRatio: number;
      saturationRatio: number;
      underexposureRatio: number;
      totalFrames: number;
    };
  }) => Promise<boolean>;
  setCameraRuntimeHints: (diag: Record<string, unknown> | null | undefined) => void;
  syncCameraHints: () => void;
  resetFingerContactSession: () => void;
  resetSessionRefs: () => void;
  setShowResults: (v: boolean) => void;
  setMeasurementSummary: (v: { totalBeats: number; arrhythmiaBeats: number; normalPercent: number } | null) => void;
  setHeartbeatSignal: (v: number) => void;
  setBeatMarker: (v: number) => void;
  setRRIntervals: (v: number[]) => void;
  setVitalSigns: (v: VitalSignsResult | ((prev: VitalSignsResult) => VitalSignsResult)) => void;
  vitalSignsRef: React.MutableRefObject<VitalSignsResult>;
  totalBeatsRef: React.MutableRefObject<number>;
  arrhythmiaBeatsRef: React.MutableRefObject<number>;
  motionArtifactFramesRef: React.MutableRefObject<number>;
  saturationFramesRef: React.MutableRefObject<number>;
  underexposedFramesRef: React.MutableRefObject<number>;
  artifactCheckFramesRef: React.MutableRefObject<number>;
  lastArrhythmiaData: React.MutableRefObject<{ timestamp: number; rmssd: number; rrVariation: number } | null>;
  isMonitoringRef: React.MutableRefObject<boolean>;
  lastSignal: import('@/types/signal').ProcessedSignal | null;
  sanityProfileId: string;
  getBackpressureConfig: () => import('@/lib/perf/backpressureConfig').BackpressureConfig;
  setHeartBeatRuntimeHints: (hints: import('@/lib/device/cameraDeviceProfile').CameraRuntimeHints) => void;
}

export function useMeasurementSession({
  cameraRef,
  startFrameLoop, stopFrameLoop,
  startProcessing, stopProcessing,
  startCalibration, forceCalibrationCompletion,
  resetVitalSigns, fullResetVitalSigns,
  resetHeartBeat,
  saveMeasurement,
  setCameraRuntimeHints: _setCameraRuntimeHints,
  syncCameraHints,
  resetFingerContactSession,
  resetSessionRefs,
  setShowResults: _setShowResults, setMeasurementSummary: _setMeasurementSummary,
  setHeartbeatSignal, setBeatMarker, setRRIntervals,
  setVitalSigns,
  vitalSignsRef,
  totalBeatsRef, arrhythmiaBeatsRef,
  motionArtifactFramesRef, saturationFramesRef,
  underexposedFramesRef, artifactCheckFramesRef,
  lastArrhythmiaData,
  isMonitoringRef,
  lastSignal,
  sanityProfileId,
  getBackpressureConfig: _getBackpressureConfig,
  setHeartBeatRuntimeHints,
}: UseMeasurementSessionInput) {
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [measurementSummary, setLocalMeasurementSummary] = useState<{
    totalBeats: number;
    arrhythmiaBeats: number;
    normalPercent: number;
  } | null>(null);
  const [showResults, setLocalShowResults] = useState(false);
  const [validationVerdict, setValidationVerdict] = useState<import('@/lib/acquisition/MeasurementWindowValidator').ValidationVerdict | null>(null);

  const validationBufferRef = useRef<ValidationFrame[]>([]);
  const measurementTimerRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const monitoringStartedAtRef = useRef<number>(0);

  // Fullscreen
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element };
      setIsFullscreen(Boolean(doc.fullscreenElement || doc.webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Wake lock
  const requestWakeLock = useCallback(async () => {
    if ('wakeLock' in navigator && navigator.wakeLock) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        logWarn('useMeasurementSession', 'WakeLock request failed');
      }
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isMonitoring) {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const preventScroll = (e: Event) => e.preventDefault();
    document.body.addEventListener('touchmove', preventScroll, { passive: false });
    document.body.addEventListener('scroll', preventScroll, { passive: false });
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.body.removeEventListener('touchmove', preventScroll);
      document.body.removeEventListener('scroll', preventScroll);
      releaseWakeLock();
    };
  }, [isMonitoring, requestWakeLock, releaseWakeLock]);

  useEffect(() => {
    if (isMonitoring) {
      if (isMonitoring && monitoringStartedAtRef.current === 0) {
        monitoringStartedAtRef.current = performance.now();
      }
    } else {
      monitoringStartedAtRef.current = 0;
    }
  }, [isMonitoring]);

  // Fullscreen
  const enterFullScreen = useCallback(async () => {
    if (isFullscreen) return;
    // Ocultar splash INMEDIATAMENTE (primera instrucción, sin condiciones)
    setIsFullscreen(true);
    // Intento best-effort de fullscreen nativo + orientación
    try {
      const docEl = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      if (docEl.requestFullscreen) await docEl.requestFullscreen();
      else if (docEl.webkitRequestFullscreen) await docEl.webkitRequestFullscreen();
    } catch {
      logWarn('useMeasurementSession', 'Fullscreen request failed');
    }
    try {
      const orient = screen.orientation as ScreenOrientation & { lock?: (o: OrientationLockType) => Promise<void> };
      if (orient?.lock) await orient.lock('portrait').catch(() => undefined);
    } catch {
      logWarn('useMeasurementSession', 'Screen orientation lock failed');
    }
  }, [isFullscreen]);



  // === INICIO DE MONITOREO ===
  const startMonitoring = useCallback(() => {
    if (isMonitoring) return;

    triggerSessionStartHaptic().catch(() => undefined);

    enterFullScreen();
    setLocalShowResults(false);
    setLocalMeasurementSummary(null);
    setValidationVerdict(null);
    validationBufferRef.current = [];
    setElapsedTime(0);
    totalBeatsRef.current = 0;
    arrhythmiaBeatsRef.current = 0;
    // arrhythmia se resetea desde VitalSignsProcessor; no hay propiedad plana

    startProcessing();
    setIsCameraOn(true);
    setIsMonitoring(true);
    requestWakeLock();

    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
    }
    measurementTimerRef.current = window.setInterval(() => {
      setElapsedTime(prev => prev + 1);
    }, 1000);

    setAuditProfile(sanityProfileId);

    startCalibration();
    resetFingerContactSession();
    setHeartBeatRuntimeHints(inferCameraRuntimeHints());
  }, [isMonitoring, enterFullScreen, startProcessing, startCalibration, requestWakeLock, sanityProfileId, setHeartBeatRuntimeHints, totalBeatsRef, arrhythmiaBeatsRef, resetFingerContactSession]);

  // === CUANDO LA CÁMARA ESTÁ LISTA ===
  const handleStreamReady = useCallback((stream: MediaStream) => {
    setCameraStream(stream);
    syncCameraHints();
    const video = cameraRef.current?.getVideoElement();
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      startFrameLoop();
      return;
    }
    if (video) {
      const onCanPlay = () => {
        video.removeEventListener('canplay', onCanPlay);
        startFrameLoop();
      };
      video.addEventListener('canplay', onCanPlay, { once: true });
    }
  }, [cameraRef, startFrameLoop, syncCameraHints]);

  // === FINALIZAR MEDICIÓN ===
  const finalizeMeasurement = useCallback(async () => {
    if (!isMonitoring) return;

    playCompletionSound();
    triggerSessionEndHaptic().catch(() => undefined);

    stopFrameLoop();
    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
      measurementTimerRef.current = null;
    }

    stopProcessing();

    if (vitalSignsRef.current.isCalibrating) {
      forceCalibrationCompletion();
    }

    const savedResults = resetVitalSigns();

    const dataToSave = savedResults ?? vitalSignsRef.current;
    const sqForSave = Math.round(
      dataToSave.signalQuality ?? lastSignal?.quality ?? 0,
    );
    const hasMeasurable =
      (dataToSave.heartRate.value != null && dataToSave.heartRate.value > 0) ||
      (dataToSave.spo2.value != null &&
        dataToSave.spo2.value >= VITAL_THRESHOLDS.SPO2.MIN_VALID) ||
      (dataToSave.bloodPressure.value?.systolic ?? 0) > 0;

    const totalCheckFrames = artifactCheckFramesRef.current;
    const artifactMetrics = totalCheckFrames > 0
      ? {
          motionArtifactRatio: motionArtifactFramesRef.current / totalCheckFrames,
          saturationRatio: saturationFramesRef.current / totalCheckFrames,
          underexposureRatio: underexposedFramesRef.current / totalCheckFrames,
          totalFrames: totalCheckFrames,
        }
      : undefined;

    if (hasMeasurable) {
      await saveMeasurement({
        vitalSigns: dataToSave,
        signalQuality: sqForSave,
        artifactMetrics,
      });
    }

    setIsCameraOn(false);

    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    setIsMonitoring(false);
    isMonitoringRef.current = false;
    releaseWakeLock();

    if (savedResults) {
      setVitalSigns(savedResults);
    }
    setLocalShowResults(true);

    const total = totalBeatsRef.current;
    const arrBeats = arrhythmiaBeatsRef.current;
    setLocalMeasurementSummary({
      totalBeats: total,
      arrhythmiaBeats: arrBeats,
      normalPercent: total > 0 ? Math.round(((total - arrBeats) / total) * 100) : 100,
    });

    setElapsedTime(0);
  }, [isMonitoring, cameraStream, stopFrameLoop, stopProcessing, forceCalibrationCompletion, resetVitalSigns, saveMeasurement, vitalSignsRef, lastSignal, releaseWakeLock, isMonitoringRef, totalBeatsRef, arrhythmiaBeatsRef, motionArtifactFramesRef, saturationFramesRef, underexposedFramesRef, artifactCheckFramesRef, setVitalSigns]);

  // === RESET COMPLETO ===
  const handleReset = useCallback(() => {
    stopFrameLoop();
    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
      measurementTimerRef.current = null;
    }

    stopProcessing();
    fullResetVitalSigns();
    resetHeartBeat();

    setIsCameraOn(false);

    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    setIsMonitoring(false);
    isMonitoringRef.current = false;
    setLocalShowResults(false);
    setLocalMeasurementSummary(null);
    setValidationVerdict(null);
    validationBufferRef.current = [];
    setElapsedTime(0);
    setVitalSigns(createDefaultVitalSignsResult());

    resetSessionRefs();
    setHeartbeatSignal(0);
    setBeatMarker(0);
    setRRIntervals([]);
    lastArrhythmiaData.current = null;
  }, [cameraStream, stopFrameLoop, stopProcessing, fullResetVitalSigns, resetHeartBeat, resetSessionRefs, isMonitoringRef, setHeartbeatSignal, setBeatMarker, setRRIntervals, lastArrhythmiaData, setVitalSigns]);

  // Auto-finalizar a los 90 segundos
  useEffect(() => {
    if (isMonitoring && elapsedTime >= 90) {
      finalizeMeasurement();
    }
  }, [elapsedTime, isMonitoring, finalizeMeasurement]);

  // Sincronizar isMonitoringRef
  useEffect(() => {
    isMonitoringRef.current = isMonitoring;
  }, [isMonitoring, isMonitoringRef]);

  return {
    isMonitoring,
    setIsMonitoring,
    isCameraOn,
    setIsCameraOn,
    elapsedTime,
    setElapsedTime,
    cameraStream,
    setCameraStream,
    measurementSummary,
    showResults,
    isFullscreen,
    startMonitoring,
    handleStreamReady,
    finalizeMeasurement,
    handleReset,
    enterFullScreen,
    setLocalShowResults,
    setLocalMeasurementSummary, validationVerdict,
  };
}
