import React, { useState, useRef, useEffect, useCallback } from "react";
import { Heart, AlertTriangle, Activity, X, Shield, Clock, CheckCircle2, Brain, Loader2, Settings as SettingsIcon } from "lucide-react";
import { playCompletionSound } from "@/utils/soundUtils";
import CameraView, { CameraViewHandle } from "@/components/CameraView";
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useHeartBeatProcessor } from "@/hooks/useHeartBeatProcessor";
import { useVitalSignsProcessor } from "@/hooks/useVitalSignsProcessor";
import { useSaveMeasurement } from "@/hooks/useSaveMeasurement";
import { useHealthAnalysis } from "@/hooks/useHealthAnalysis";
import PPGSignalMeter from "@/components/PPGSignalMeter";
import { VitalSignsResult } from "@/modules/vital-signs/VitalSignsProcessor";
import type { ProcessedSignal } from "@/types/signal";
import { toast } from "@/components/ui/use-toast";
import { ppgPerf } from "@/utils/logger";
import { usePerfTelemetry, getPerfConsent, setPerfConsent } from "@/hooks/usePerfTelemetry";
import type { BackpressureConfig } from "@/lib/perf/backpressureConfig";
import { VitalsSanityChecker } from "@/lib/sanity/vitalsSanity";
import {
  SANITY_PROFILES,
  getActiveProfileId,
  setActiveProfileId,
  getCustomOverrides,
  setCustomOverrides,
  resolveProfile,
} from "@/lib/sanity/sanityProfiles";
import {
  startSession as startAuditSession,
  setActiveProfile as setAuditProfile,
  recordVerdict as recordAuditVerdict,
  clearLog as clearAuditLog,
  downloadJSON as downloadAuditJSON,
  downloadCSV as downloadAuditCSV,
  getEntries as getAuditEntries,
  getNegativeCount as getAuditNegativeCount,
} from "@/lib/sanity/sanityAuditLog";

import { supabase } from "@/integrations/supabase/client";
import { VITAL_THRESHOLDS } from "@/config/vitalThresholds";

const Index = () => {
  // ESTADOS PRINCIPALES
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [vitalSigns, setVitalSigns] = useState<VitalSignsResult>({
    heartRate: { name: "HR", value: 0, unit: "bpm", timestamp: Date.now(), confidence: 0, status: "WARMUP", reason: "", signalQuality: {} as any, diagnostics: {} },
    spo2: { name: "SpO2", value: 0, unit: "%", timestamp: Date.now(), confidence: 0, status: "WARMUP", reason: "", signalQuality: {} as any, diagnostics: {} },
    bloodPressure: { name: "BP", value: { systolic: 0, diastolic: 0 }, unit: "mmHg", timestamp: Date.now(), confidence: 0, status: "WARMUP", reason: "", signalQuality: {} as any, diagnostics: {} },
    respiration: { name: "RR", value: 0, unit: "rpm", timestamp: Date.now(), confidence: 0, status: "WARMUP", reason: "", signalQuality: {} as any, diagnostics: {} },
    arrhythmia: { name: "Arrhythmia", value: { count: 0, status: "NORMAL" }, unit: "event", timestamp: Date.now(), confidence: 0, status: "WARMUP", reason: "", signalQuality: {} as any, diagnostics: {} },
    signalQuality: 0,
    isCalibrating: false,
    calibrationProgress: 0,
    lastArrhythmiaData: null
  });
  const [heartbeatSignal, setHeartbeatSignal] = useState(0);
  const [beatMarker, setBeatMarker] = useState(0);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [rrIntervals, setRRIntervals] = useState<number[]>([]);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  
  const [measurementSummary, setMeasurementSummary] = useState<{
    totalBeats: number;
    arrhythmiaBeats: number;
    normalPercent: number;
  } | null>(null);
  
  // REFERENCIAS
  const measurementTimerRef = useRef<number | null>(null);
  const totalBeatsRef = useRef(0);
  const arrhythmiaBeatsRef = useRef(0);
  const lastArrhythmiaCountForBeatsRef = useRef(0);
  const arrhythmiaDetectedRef = useRef(false);
  const lastArrhythmiaData = useRef<{ timestamp: number; rmssd: number; rrVariation: number; } | null>(null);
  const cameraRef = useRef<CameraViewHandle>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const frameLoopRef = useRef<number | null>(null);
  const videoFrameLoopRef = useRef<number | null>(null);
  const isProcessingRef = useRef(false);
  // Runtime guardrail: detect implausible vitals streams.
  const [sanityProfileId, setSanityProfileId] = useState<string>(() => getActiveProfileId());
  const [customJSON, setCustomJSON] = useState<string>(() => {
    const o = getCustomOverrides();
    return Object.keys(o).length ? JSON.stringify(o, null, 2) : "";
  });
  const [auditNegativeCount, setAuditNegativeCount] = useState(0);
  const bpmSanityRef = useRef<VitalsSanityChecker>(
    new VitalsSanityChecker({
      ...resolveProfile(getActiveProfileId()).effective,
      onVerdict: (sample, verdict, win) => {
        recordAuditVerdict(sample, verdict, win);
        if (!verdict.ok) setAuditNegativeCount(getAuditNegativeCount());
      },
    })
  );
  const sanityErrorRef = useRef<string | null>(null);
  const sanityToastAtRef = useRef<number>(0);
  const [sanityError, setSanityError] = useState<string | null>(null);

  const rebuildSanityChecker = useCallback((profileId: string) => {
    const { effective } = resolveProfile(profileId);
    bpmSanityRef.current = new VitalsSanityChecker({
      ...effective,
      onVerdict: (sample, verdict, win) => {
        recordAuditVerdict(sample, verdict, win);
        if (!verdict.ok) setAuditNegativeCount(getAuditNegativeCount());
      },
    });
    setAuditProfile(profileId);
  }, []);

  const handleProfileChange = useCallback((id: string) => {
    setSanityProfileId(id);
    setActiveProfileId(id);
    rebuildSanityChecker(id);
  }, [rebuildSanityChecker]);

  const handleCustomApply = useCallback(() => {
    const txt = customJSON.trim();
    try {
      const parsed = txt ? JSON.parse(txt) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setCustomOverrides(parsed);
        rebuildSanityChecker(sanityProfileId);
        toast({ title: "✓ Umbrales aplicados", description: "Configuración personalizada activa." });
      } else {
        throw new Error("JSON debe ser un objeto");
      }
    } catch (e) {
      toast({ variant: "destructive", title: "JSON inválido", description: String((e as Error).message ?? e) });
    }
  }, [customJSON, sanityProfileId, rebuildSanityChecker]);

  const handleCustomClear = useCallback(() => {
    setCustomOverrides(null);
    setCustomJSON("");
    rebuildSanityChecker(sanityProfileId);
  }, [sanityProfileId, rebuildSanityChecker]);
  
  const wakeLockRef = useRef<any>(null);

  const requestWakeLock = useCallback(async () => {
    if ('wakeLock' in navigator) {
      try {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      } catch (err) {
        console.warn('Wake Lock error:', err);
      }
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
  }, []);
  
  // HOOKS DE PROCESAMIENTO
  const { 
    startProcessing, 
    stopProcessing, 
    lastSignal, 
    processFrame, 
    isProcessing, 
    getRGBStats,
    getBackpressureState,
    getBackpressureConfig,
    setBackpressureConfig,
    currentStride,
    setSignalCallback,
  } = useSignalProcessor();
  
  const { 
    processSignal: processHeartBeat, 
    reset: resetHeartBeat,
  } = useHeartBeatProcessor();
  
  const { 
    processSignal: processVitalSigns, 
    setRGBData,
    reset: resetVitalSigns,
    fullReset: fullResetVitalSigns,
    lastValidResults,
    startCalibration,
    forceCalibrationCompletion,
    getCalibrationProgress
  } = useVitalSignsProcessor();
  
  const { saveMeasurement } = useSaveMeasurement();
  const { analysis, isAnalyzing, analyzeVitals, clearAnalysis } = useHealthAnalysis();
  const [showAIAnalysis, setShowAIAnalysis] = useState(false);
  /** Guía de colocación del dedo; se resetea al iniciar medición */
  const [fingerGuideDismissed, setFingerGuideDismissed] = useState(false);

  // ---- Telemetría de rendimiento (opt-in) ----
  const telemetryOn = false;
  const [showSettings, setShowSettings] = useState(false);
  const [bpCfg, setBpCfg] = useState<BackpressureConfig>(() => getBackpressureConfig());

  const updateBp = useCallback((patch: Partial<BackpressureConfig>) => {
    const next = setBackpressureConfig(patch);
    setBpCfg(next);
  }, [setBackpressureConfig]);
  usePerfTelemetry({
    enabled: telemetryOn && isMonitoring,
    intervalMs: 15000,
    context: {
      getCamera: () => cameraRef.current?.getDiagnostics?.() ?? {},
      getPipeline: () => ({
        sqi: lastSignal?.quality ?? 0,
        fingerDetected: !!lastSignal?.fingerDetected,
        perfusionIndex: lastSignal?.perfusionIndex ?? 0,
        bpm: vitalSigns.heartRate.value,
        spo2: vitalSigns.spo2.value,
        confidence: vitalSigns.heartRate.status === 'VALID' ? 'HIGH' : 'INVALID',
        backpressure: getBackpressureState(),
      }),
    },
  });

  // ---- Aviso visual cuando el backpressure adaptativo cambia el stride ----
  // Solo notifica cambios *automáticos* (no overrides manuales del usuario)
  // y solo durante una medición activa, con una ventana de gracia inicial
  // para no disparar al arrancar.
  const prevStrideRef = useRef<number>(currentStride);
  const monitoringStartedAtRef = useRef<number>(0);
  useEffect(() => {
    if (isMonitoring && monitoringStartedAtRef.current === 0) {
      monitoringStartedAtRef.current = performance.now();
      prevStrideRef.current = currentStride;
      return;
    }
    if (!isMonitoring) {
      monitoringStartedAtRef.current = 0;
      prevStrideRef.current = currentStride;
      return;
    }
    const prev = prevStrideRef.current;
    if (prev === currentStride) return;
    prevStrideRef.current = currentStride;

    // Ventana de gracia: ignora transiciones en los primeros 2s.
    if (performance.now() - monitoringStartedAtRef.current < 2000) return;

    // Si el cambio es manual (forceStride definido), no notificamos.
    try {
      const cfg = getBackpressureConfig();
      if (typeof cfg.forceStride === 'number') return;
      if (!cfg.enabled) return;
    } catch { return; }

    if (currentStride > prev) {
      toast({
        title: "⚡ Modo ahorro activado",
        description: `Rendimiento bajo detectado, reduciendo muestreo (stride ${currentStride}).`,
        duration: 3000,
      });
    } else {
      toast({
        title: "✓ Rendimiento restaurado",
        description: `Muestreo completo activo (stride ${currentStride}).`,
        duration: 2500,
      });
    }
  }, [currentStride, isMonitoring, getBackpressureConfig]);

  // CANVAS PARA CAPTURA
  useEffect(() => {
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = 320;
      canvasRef.current.height = 240;
      ctxRef.current = canvasRef.current.getContext('2d', { 
        willReadFrequently: true,
        alpha: false 
      });
    }
  }, []);

  // PANTALLA COMPLETA
  const enterFullScreen = useCallback(async () => {
    if (isFullscreen) return;
    try {
      const docEl = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      }
      const orient = screen.orientation as ScreenOrientation & { lock?: (o: OrientationLockType) => Promise<void> };
      if (orient?.lock) {
        await orient.lock('portrait').catch(() => undefined);
      }
      setIsFullscreen(true);
    } catch {
      // El navegador rechazó pantalla completa (permiso, gesto del usuario, etc).
      // El usuario seguirá viendo el overlay para activar manualmente.
    }
  }, [isFullscreen]);

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

  // PREVENIR SCROLL
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

  // SINCRONIZACIÓN DE RESULTADOS
  useEffect(() => {
    if (lastValidResults && !isMonitoring) {
      setVitalSigns(lastValidResults);
      setShowResults(true);
    }
  }, [lastValidResults, isMonitoring]);

  // === LOOP DE CAPTURA — requestVideoFrameCallback con fallback RAF ===
  const startFrameLoop = useCallback(() => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) {
      isProcessingRef.current = false;
      return;
    }

    const captureOneFrame = (frameTimestampMs?: number) => {
      if (!isProcessingRef.current) return;
      const video = cameraRef.current?.getVideoElement();
      if (!video || video.readyState < 2 || video.videoWidth === 0) {
        frameLoopRef.current = requestAnimationFrame(captureOneFrame);
        return;
      }
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        processFrame(imageData, frameTimestampMs);
      } catch {
        /* drawImage / getImageData can throw if the video tears down mid-frame */
      }
      scheduleNext(video);
    };

    const scheduleNext = (video: HTMLVideoElement) => {
      if (!isProcessingRef.current) return;
      const vAny = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
      };
      if (typeof vAny.requestVideoFrameCallback === 'function') {
        videoFrameLoopRef.current = vAny.requestVideoFrameCallback((_now, metadata) => {
          ppgPerf.markFrame(metadata);
          const ts = typeof metadata?.captureTime === 'number'
            ? metadata.captureTime
            : (typeof metadata?.presentationTime === 'number'
              ? metadata.presentationTime
              : (typeof metadata?.mediaTime === 'number' ? metadata.mediaTime * 1000 : performance.now()));
          captureOneFrame(ts);
        });
      } else {
        ppgPerf.markFrame();
        frameLoopRef.current = requestAnimationFrame((ts) => captureOneFrame(ts));
      }
    };

    captureOneFrame(performance.now());
  }, [processFrame]);

  const stopFrameLoop = useCallback(() => {
    isProcessingRef.current = false;
    const video = cameraRef.current?.getVideoElement() as (HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void }) | null;
    if (videoFrameLoopRef.current !== null && typeof video?.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(videoFrameLoopRef.current);
      videoFrameLoopRef.current = null;
    }
    if (frameLoopRef.current) {
      cancelAnimationFrame(frameLoopRef.current);
      frameLoopRef.current = null;
    }
  }, []);

  // === INICIO DE MONITOREO ===
  const startMonitoring = useCallback(() => {
    if (isMonitoring) return;

    if (navigator.vibrate) navigator.vibrate([200]);

    enterFullScreen();
    setShowResults(false);
    setMeasurementSummary(null);
    setElapsedTime(0);
    totalBeatsRef.current = 0;
    arrhythmiaBeatsRef.current = 0;
    lastArrhythmiaCountForBeatsRef.current = 0;
    setVitalSigns(prev => ({ ...prev, arrhythmiaStatus: "SIN ARRITMIAS|0" }));

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

    const sid = `${Date.now().toString(36)}-${Math.floor(performance.now()).toString(36)}`;
    startAuditSession(sid, sanityProfileId);
    setAuditNegativeCount(0);

    startCalibration();
    setFingerGuideDismissed(false);
  }, [isMonitoring, startProcessing, startCalibration, enterFullScreen, sanityProfileId, requestWakeLock]);

  // === CUANDO LA CÁMARA ESTÁ LISTA ===
  // CameraView ya esperó internamente a `loadedmetadata` antes de invocar onStreamReady,
  // así que el video está listo: iniciamos captura directamente.
  const handleStreamReady = useCallback((stream: MediaStream) => {
    setCameraStream(stream);
    const video = cameraRef.current?.getVideoElement();
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      startFrameLoop();
      return;
    }
    // Edge case: si por alguna razón el video aún no está renderizable,
    // engancharse al evento canplay (no polling, no setTimeout).
    if (video) {
      const onCanPlay = () => {
        video.removeEventListener('canplay', onCanPlay);
        startFrameLoop();
      };
      video.addEventListener('canplay', onCanPlay, { once: true });
    }
  }, [startFrameLoop]);

  // === FINALIZAR MEDICIÓN ===
  const finalizeMeasurement = useCallback(async () => {
    if (!isMonitoring) return;

    playCompletionSound();
    if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 200]);

    stopFrameLoop();
    if (beatMarkerTimerRef.current) {
      window.clearTimeout(beatMarkerTimerRef.current);
      beatMarkerTimerRef.current = null;
    }
    
    // Detener timer
    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
      measurementTimerRef.current = null;
    }
    
    // Detener procesadores
    stopProcessing();
    
    if (vitalSigns.isCalibrating) {
      forceCalibrationCompletion();
    }
    
    const savedResults = resetVitalSigns();
    
    // Guardar medición en la base de datos automáticamente
    if (savedResults || vitalSigns.spo2.value > 0) {
      const dataToSave = savedResults || vitalSigns;
      await saveMeasurement({
        vitalSigns: dataToSave,
        signalQuality: lastSignal?.quality || 0
      });
    }
    
    // Detener cámara
    setIsCameraOn(false);
    
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    
    
    setIsMonitoring(false);
    releaseWakeLock();
    
    if (savedResults) {
      setVitalSigns(savedResults);
    }
    setShowResults(true);
    
    // Generar resumen estadístico
    const total = totalBeatsRef.current;
    const arrBeats = arrhythmiaBeatsRef.current;
    setMeasurementSummary({
      totalBeats: total,
      arrhythmiaBeats: arrBeats,
      normalPercent: total > 0 ? Math.round(((total - arrBeats) / total) * 100) : 100
    });
    
    setElapsedTime(0);
  }, [isMonitoring, cameraStream, stopFrameLoop, stopProcessing, forceCalibrationCompletion, resetVitalSigns, saveMeasurement, vitalSigns, lastSignal, releaseWakeLock]);

  // === RESET COMPLETO ===
  const handleReset = useCallback(() => {
    stopFrameLoop();
    if (beatMarkerTimerRef.current) {
      window.clearTimeout(beatMarkerTimerRef.current);
      beatMarkerTimerRef.current = null;
    }
    
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
    setShowResults(false);
    setMeasurementSummary(null);
    setElapsedTime(0);
    setVitalSigns({ 
      heartRate: { name: "HR", value: 0, unit: "bpm", timestamp: Date.now(), confidence: 0, status: "WARMUP", reason: "", signalQuality: {} as any, diagnostics: {} },
      spo2: { name: "SpO2", value: 0, unit: "%", timestamp: Date.now(), confidence: 0, status: "WARMUP", reason: "", signalQuality: {} as any, diagnostics: {} },
      bloodPressure: { name: "BP", value: { systolic: 0, diastolic: 0 }, unit: "mmHg", timestamp: Date.now(), confidence: 0, status: "WARMUP", reason: "", signalQuality: {} as any, diagnostics: {} },
      respiration: { name: "RR", value: 0, unit: "rpm", timestamp: Date.now(), confidence: 0, status: "WARMUP", reason: "", signalQuality: {} as any, diagnostics: {} },
      arrhythmia: { name: "Arrhythmia", value: { count: 0, status: "NORMAL" }, unit: "event", timestamp: Date.now(), confidence: 0, status: "WARMUP", reason: "", signalQuality: {} as any, diagnostics: {} },
      signalQuality: 0,
      isCalibrating: false,
      calibrationProgress: 0,
      lastArrhythmiaData: null
    });

    // Restaurar resets de refs necesarios para la lógica
    totalBeatsRef.current = 0;
    arrhythmiaBeatsRef.current = 0;
    lastArrhythmiaCountForBeatsRef.current = 0;
    unstableFrameCounter.current = 0;
    setHeartbeatSignal(0);
    setBeatMarker(0);
    setRRIntervals([]);
    bpmSanityRef.current.reset();
    sanityErrorRef.current = null;
    setSanityError(null);
    lastArrhythmiaData.current = null;
    arrhythmiaDetectedRef.current = false;
  }, [cameraStream, stopFrameLoop, stopProcessing, fullResetVitalSigns, resetHeartBeat]);

  // === PROCESAR SEÑAL PPG ===
  const vitalSignsFrameCounter = useRef<number>(0);
  const unstableFrameCounter = useRef<number>(0);
  const UNSTABLE_ZERO_THRESHOLD = 180; // 6 segundos de gracia antes de borrar (antes 120)
  const VITALS_PROCESS_EVERY_N_FRAMES = 3;
  // Throttling de UI: el DSP corre en cada frame, React solo refresca a ritmos sanos.
  const isMonitoringRef = useRef(false);
  useEffect(() => { isMonitoringRef.current = isMonitoring; }, [isMonitoring]);
  const vitalSignsRef = useRef<VitalSignsResult>(vitalSigns);
  useEffect(() => { vitalSignsRef.current = vitalSigns; }, [vitalSigns]);
  const lastHrPushRef = useRef(0);
  const lastVitalsPushRef = useRef(0);
  const lastSignalPushRef = useRef(0);
  const lastRrPushRef = useRef(0);
  const beatMarkerTimerRef = useRef<number | null>(null);
  const HR_PUSH_THROTTLE_MS = 120;
  // El DSP de vitales (SpO2/BP/arritmia) corre cada N frames para alimentar sus
  // ventanas internas; sólo el setState a React se throttlea para no saturar el
  // árbol. NUNCA bajar la tasa de procesamiento por debajo de ~10 Hz: SpO2 y BP
  // necesitan acumular ciclos cardíacos completos para producir lecturas.
  const VITALS_PUSH_THROTTLE_MS = 300;
  const RR_PUSH_THROTTLE_MS = 250;
  const SIGNAL_PUSH_THROTTLE_MS = 33; // ~30 Hz a la onda (ya throttleada por el monitor RAF)

  // Hot path: corre por cada frame de cámara SIN pasar por React.
  // Toda la lógica DSP vive en refs; sólo se emite a React con throttle.
  const [currentDiagnostics, setCurrentDiagnostics] = useState<any>(null);

  const handleSignalRealtime = useCallback((lastSignal: ProcessedSignal) => {
    if (!isMonitoringRef.current) return;
    const signalValue = lastSignal.filteredValue;
    const contactState = (lastSignal as any).contactState || (lastSignal.fingerDetected ? 'STABLE_CONTACT' : 'NO_CONTACT');
    const diag = lastSignal.diagnostics;

    const heartBeatResult = processHeartBeat(
      signalValue,
      contactState,
      lastSignal.timestamp
    );

    const mergedDiag =
      diag && typeof diag === 'object'
        ? { ...diag, peakDetection: heartBeatResult.ensembleDiagnostics }
        : { peakDetection: heartBeatResult.ensembleDiagnostics };
    setCurrentDiagnostics(mergedDiag);

    const hasUsableContact = contactState !== 'NO_CONTACT' && lastSignal.fingerDetected;
    const stableHumanSignal =
      hasUsableContact &&
      (lastSignal.quality || 0) >= 2 &&
      (lastSignal.perfusionIndex || 0) >= VITAL_THRESHOLDS.QUALITY.MIN_PI * 0.22;

    const nowT = performance.now();
    if (nowT - lastSignalPushRef.current >= SIGNAL_PUSH_THROTTLE_MS) {
      lastSignalPushRef.current = nowT;
      // Siempre dibujar la onda si hay contacto, incluso si la calidad es baja
      // para que el usuario pueda ver si el dedo está bien puesto.
      setHeartbeatSignal(hasUsableContact ? heartBeatResult.filteredValue : 0);
    }

    if (!stableHumanSignal) {
      unstableFrameCounter.current++;
      
      // Solo borrar vitales después de señal mala SOSTENIDA
      if (unstableFrameCounter.current >= UNSTABLE_ZERO_THRESHOLD) {
        vitalSignsFrameCounter.current = 0;
        setBeatMarker(0);
        setRRIntervals([]);
        arrhythmiaDetectedRef.current = false;
        setVitalSigns(prev => (
          prev.heartRate.value === 0 &&
          (prev.spo2.value == null || prev.spo2.value === 0) &&
          (prev.bloodPressure.value?.systolic ?? 0) === 0
            ? prev
            : {
                ...prev,
                heartRate: { ...prev.heartRate, value: 0, status: "NO_VALID_SIGNAL" },
                spo2: { ...prev.spo2, value: 0, status: "NO_VALID_SIGNAL" },
                bloodPressure: { ...prev.bloodPressure, value: { systolic: 0, diastolic: 0 }, status: "NO_VALID_SIGNAL" },
                arrhythmia: { ...prev.arrhythmia, value: { count: 0, status: "NORMAL" } },
                signalQuality: 0,
              }
        ));
      }
      // Durante los primeros frames inestables, mantener último valor válido (no borrar)
      return;
    }

    // Señal estable — resetear contador de inestabilidad
    unstableFrameCounter.current = 0;
    // Guardrail anti-simulación: si el stream de BPM se vuelve constante /
    // repetitivo / fuera de rango fisiológico, congelamos la actualización
    // y exponemos un estado de error en lugar de pintar datos sospechosos.
    const verdict = bpmSanityRef.current.push(heartBeatResult.bpm);
    if (verdict.ok === false) {
      const msg = `BPM stream ${verdict.reason} (${verdict.detail})`;
      if (sanityErrorRef.current !== verdict.reason) {
        sanityErrorRef.current = verdict.reason;
        setSanityError(msg);
        const now = performance.now();
        if (now - sanityToastAtRef.current > 5000) {
          sanityToastAtRef.current = now;
          toast({
            variant: "destructive",
            title: "⚠ Señal sospechosa detectada",
            description: msg,
          });
        }
      }
      // No actualizamos heartRate ni vitales mientras el verdict sea inválido.
      return;
    }
    if (sanityErrorRef.current) {
      sanityErrorRef.current = null;
      setSanityError(null);
    }
    if (nowT - lastHrPushRef.current >= HR_PUSH_THROTTLE_MS) {
      lastHrPushRef.current = nowT;
      setVitalSigns(prev => ({
        ...prev,
        heartRate: { ...prev.heartRate, value: heartBeatResult.bpm, status: "VALID" }
      }));
    }

    if (heartBeatResult.isPeak) {
      setBeatMarker(1);
      if (beatMarkerTimerRef.current) window.clearTimeout(beatMarkerTimerRef.current);
      beatMarkerTimerRef.current = window.setTimeout(() => {
        setBeatMarker(0);
        beatMarkerTimerRef.current = null;
      }, 300);
      totalBeatsRef.current++;
      const currentArrCount = vitalSignsRef.current.arrhythmia.value.count || 0;
      if (currentArrCount > lastArrhythmiaCountForBeatsRef.current) {
        arrhythmiaBeatsRef.current++;
        lastArrhythmiaCountForBeatsRef.current = currentArrCount;
      }
    }

      if (heartBeatResult.isPeak && heartBeatResult.rrData?.intervals && nowT - lastRrPushRef.current >= RR_PUSH_THROTTLE_MS) {
      lastRrPushRef.current = nowT;
      setRRIntervals(heartBeatResult.rrData.intervals.slice(-5));
    }

    vitalSignsFrameCounter.current++;

    // DSP de vitales: corre cada N frames (~10 Hz) para alimentar SpO2/BP/arritmia.
    // El setState a React queda throttleado independientemente.
    const dspDue = vitalSignsFrameCounter.current >= VITALS_PROCESS_EVERY_N_FRAMES;
    if (dspDue) {
      vitalSignsFrameCounter.current = 0;
      const rgbStats = getRGBStats();

      if (rgbStats.redDC > 0 && rgbStats.greenDC > 0) {
        setRGBData({
          redAC: rgbStats.redAC,
          redDC: rgbStats.redDC,
          greenAC: rgbStats.greenAC,
          greenDC: rgbStats.greenDC
        });
      }

      const vitals = processVitalSigns(
        lastSignal.filteredValue,
        lastSignal.quality || 0,
        heartBeatResult.bpm,
        heartBeatResult.rrData && heartBeatResult.rrData.intervals.length >= 2 && heartBeatResult.confidence > 0.12
          ? heartBeatResult.rrData
          : undefined,
        lastSignal.perfusionIndex
      );

      // Mantener siempre la última computación en ref para finalize/save.
      vitalSignsRef.current = vitals;

      // Throttle SOLO del setState (UI). El cálculo ya corrió.
      const uiDue = nowT - lastVitalsPushRef.current >= VITALS_PUSH_THROTTLE_MS;
      if (uiDue) {
        lastVitalsPushRef.current = nowT;
        setVitalSigns(vitals);
      }

      if (heartBeatResult.rrData && heartBeatResult.rrData.intervals.length >= 2 && heartBeatResult.confidence > 0.12 && vitals.heartRate.status === 'VALID') {
        const arrhythmiaStatus = vitals.arrhythmia.value.status;
        if (arrhythmiaStatus) {
          lastArrhythmiaData.current = vitals.lastArrhythmiaData || null;

          const isArrhythmiaDetected = arrhythmiaStatus.includes("ARRITMIA DETECTADA");
          if (isArrhythmiaDetected !== arrhythmiaDetectedRef.current) {
            arrhythmiaDetectedRef.current = isArrhythmiaDetected;

            if (isArrhythmiaDetected) {
              if (navigator.vibrate) {
                navigator.vibrate([200, 100, 200]);
              }
              toast({
                title: "⚠️ Arritmia detectada",
                description: `Latido irregular #${vitals.arrhythmia.value.count}`,
                variant: "destructive",
                duration: 4000
              });
            }
          }
        }
      }
    }
  }, [processHeartBeat, processVitalSigns, setRGBData, getRGBStats]);

  // Conectar el callback realtime al hook de señal una sola vez.
  useEffect(() => {
    setSignalCallback(handleSignalRealtime);
    return () => setSignalCallback(null);
  }, [setSignalCallback, handleSignalRealtime]);

  // AUTO-FINALIZAR a los 60 segundos (1 minuto)
  useEffect(() => {
    if (isMonitoring && elapsedTime >= 60) {
      finalizeMeasurement();
    }
  }, [elapsedTime, isMonitoring, finalizeMeasurement]);

  // CONTROL DE CALIBRACIÓN
  useEffect(() => {
    if (!vitalSigns.isCalibrating) return;
    
    const interval = setInterval(() => {
      const currentProgress = getCalibrationProgress();

      if (currentProgress >= 100) {
        clearInterval(interval);
        if (navigator.vibrate) {
          navigator.vibrate([100]);
        }
      }
    }, 500);

    return () => clearInterval(interval);
  }, [vitalSigns.isCalibrating, getCalibrationProgress]);

  const handleToggleMonitoring = () => {
    if (isMonitoring) {
      finalizeMeasurement();
    } else {
      startMonitoring();
    }
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-black" style={{ 
      height: '100svh',
      width: '100vw',
      maxWidth: '100vw',
      maxHeight: '100svh',
      overflow: 'hidden',
      touchAction: 'none',
      userSelect: 'none',
      WebkitTouchCallout: 'none',
      WebkitUserSelect: 'none'
    }}>
      {/* SPLASH / BOOT SCREEN — Puerta de entrada a pantalla completa inmersiva */}
      {!isFullscreen && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black animate-in fade-in duration-700">
          <div className="relative flex flex-col items-center max-w-xs text-center space-y-12">
            
            {/* Logo Pulsante / Indicador de estado */}
            <div className="relative">
              <div className="absolute inset-0 bg-emerald-500/20 blur-3xl rounded-full animate-pulse scale-150" />
              <div className="relative w-24 h-24 rounded-full border-2 border-emerald-500/30 flex items-center justify-center">
                <Heart className="w-10 h-10 text-emerald-400 animate-pulse" fill="currentColor" />
              </div>
            </div>

            <div className="space-y-4">
              <h1 className="text-white text-2xl font-bold tracking-[0.2em]">BIO-BEAT TRACKER</h1>
              <div className="flex items-center justify-center gap-3">
                <span className="h-[1px] w-8 bg-emerald-900" />
                <p className="text-emerald-500/60 text-[10px] font-bold tracking-[0.3em] uppercase">Monitor de Grado Clínico</p>
                <span className="h-[1px] w-8 bg-emerald-900" />
              </div>
            </div>

            <button 
              onClick={enterFullScreen}
              className="group relative px-10 py-4 overflow-hidden rounded-full transition-all active:scale-95"
            >
              <div className="absolute inset-0 bg-emerald-600/10 group-hover:bg-emerald-600/20 transition-colors" />
              <div className="absolute inset-0 border border-emerald-500/30 group-hover:border-emerald-500/50 rounded-full" />
              <span className="relative text-emerald-400 text-sm font-bold tracking-[0.2em]">INICIAR SISTEMA</span>
            </button>

            <div className="pt-10 grid grid-cols-2 gap-x-10 gap-y-6 opacity-90 animate-in slide-in-from-bottom-8 duration-1000 delay-300 fill-mode-both">
              <div className="text-left space-y-1.5 border-l-2 border-emerald-500/20 pl-3">
                <p className="text-white/60 text-[9px] font-bold tracking-widest uppercase">Pipeline</p>
                <p className="text-emerald-300 text-[10px] font-mono leading-tight font-bold">ZERO-ALLOCATION<br/>ULTRA LOW LATENCY</p>
              </div>
              <div className="text-left space-y-1.5 border-l-2 border-emerald-500/20 pl-3">
                <p className="text-white/60 text-[9px] font-bold tracking-widest uppercase">Engine</p>
                <p className="text-emerald-300 text-[10px] font-mono leading-tight font-bold">PPG-RG FIDELITY<br/>PWA IMMERSIVE</p>
              </div>
              <div className="text-left space-y-1.5 border-l-2 border-emerald-500/20 pl-3">
                <p className="text-white/60 text-[9px] font-bold tracking-widest uppercase">Analytics</p>
                <p className="text-emerald-300 text-[10px] font-mono leading-tight font-bold">HRV CLINICAL<br/>RMSSD / PNN50</p>
              </div>
              <div className="text-left space-y-1.5 border-l-2 border-emerald-500/20 pl-3">
                <p className="text-white/60 text-[9px] font-bold tracking-widest uppercase">Security</p>
                <p className="text-emerald-300 text-[10px] font-mono leading-tight font-bold">ANTI-SIM GUARDRAIL<br/>DATA INTEGRITY</p>
              </div>
            </div>

            <div className="pt-8 space-y-2 opacity-40 animate-in fade-in duration-1000 delay-700 fill-mode-both">
              <p className="text-white text-[9px] font-mono uppercase tracking-[0.3em]">Hardware: WebRTC Camera / Optical Sensor</p>
              <p className="text-white text-[9px] font-mono uppercase tracking-[0.3em]">Software: V-Sign Engine v4.0.2 • Build 2024.05</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 relative">

        {/* CÁMARA - Con ref directo */}
        <div className="absolute inset-0">
          <CameraView 
            ref={cameraRef}
            onStreamReady={handleStreamReady}
            isMonitoring={isCameraOn}
          />
        </div>

        {isMonitoring && !showResults && !fingerGuideDismissed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-28 z-20 flex justify-center px-3 sm:px-4">
            <div className="pointer-events-auto max-w-md w-full rounded-xl border border-emerald-500/35 bg-slate-950/90 px-3 py-2.5 shadow-2xl backdrop-blur-md sm:px-4 sm:py-3">
              <p className="text-emerald-400 text-[10px] font-bold uppercase tracking-wider mb-1.5">
                Cómo colocar el dedo en la cámara
              </p>
              <ul className="text-white/90 text-[11px] sm:text-xs leading-snug space-y-1 list-disc pl-3.5 marker:text-emerald-500">
                <li>
                  Usa la <span className="font-semibold text-white">yema del índice</span> (no la uña): debe cubrir a la vez el <span className="font-semibold text-white">flash LED y la lente</span> de la cámara trasera.
                </li>
                <li>
                  Presión <span className="font-semibold text-white">suave y constante</span>, sin mover el dedo; espera <span className="font-semibold text-white">5–15 s</span> a que suba la calidad y aparezcan latidos.
                </li>
                <li>
                  Ambiente oscuro y pantalla al máximo ayudan; evita luz solar directa sobre el dedo.
                </li>
              </ul>
              <button
                type="button"
                onClick={() => setFingerGuideDismissed(true)}
                className="mt-2 w-full rounded-lg bg-emerald-600/25 py-1.5 text-[11px] font-bold text-emerald-300 hover:bg-emerald-600/40 transition-colors"
              >
                Entendido, ocultar guía
              </button>
            </div>
          </div>
        )}

        {/* AJUSTES — Removido para simplificar la interfaz según preferencia del usuario */}
        {/* <button
          type="button"
          onClick={() => setShowSettings(true)}
          aria-label="Ajustes"
          className="absolute top-2 right-2 z-30 p-2 rounded-full bg-black/40 text-white/70 hover:text-white hover:bg-black/60 transition-colors"
        >
          <SettingsIcon className="h-4 w-4" />
        </button> */}

        {/* MODAL DE AJUSTES REMOVIDO PARA PRODUCCIÓN */}

        <div className="relative z-10 h-full">
          <div className="flex-1 h-full">
            <PPGSignalMeter 
              value={heartbeatSignal}
              quality={lastSignal?.quality || 0}
              isFingerDetected={lastSignal?.fingerDetected || false}
              onStartMeasurement={handleToggleMonitoring}
              onReset={handleReset}
              isMonitoring={isMonitoring}
              arrhythmiaStatus={vitalSigns.arrhythmia.value.status}
              rawArrhythmiaData={lastArrhythmiaData.current}
              preserveResults={showResults}
              isPeak={beatMarker === 1}
              bpm={vitalSigns.heartRate.value}
              spo2={vitalSigns.spo2.value || 0}
              arrhythmiaCount={vitalSigns.arrhythmia.value.count}
              rrIntervals={rrIntervals}
              elapsedTime={elapsedTime}
              perfusionIndex={lastSignal?.perfusionIndex || 0}
              pressure={vitalSigns.bloodPressure.value ?? { systolic: 0, diastolic: 0 }}
              diagnostics={currentDiagnostics}
            />
          </div>

          {/* RESUMEN ESTADÍSTICO POST-MEDICIÓN */}
          {showResults && measurementSummary && (() => {
            const { totalBeats, arrhythmiaBeats, normalPercent } = measurementSummary;
            const normalBeats = totalBeats - arrhythmiaBeats;
            const avgBpm = vitalSigns.heartRate.value > 0 ? Math.round(vitalSigns.heartRate.value) : '--';
            const statusColor = normalPercent >= 95 ? 'emerald' : normalPercent >= 80 ? 'yellow' : 'red';
            const statusText = normalPercent >= 95 ? 'RITMO NORMAL' : normalPercent >= 80 ? 'LEVE IRREGULARIDAD' : 'IRREGULARIDAD DETECTADA';
            const statusIcon = normalPercent >= 95 ? CheckCircle2 : normalPercent >= 80 ? AlertTriangle : AlertTriangle;
            const StatusIcon = statusIcon;
            
            return (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 animate-fade-in">
                <div className="bg-slate-950 border border-slate-700/50 rounded-2xl max-w-sm w-[92%] shadow-2xl overflow-hidden">
                  
                  {/* Header con estado */}
                  <div className={`px-4 py-3 bg-${statusColor}-500/10 border-b border-slate-800`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <StatusIcon className={`w-5 h-5 text-${statusColor}-400`} />
                        <div>
                          <h3 className="text-white text-sm font-bold tracking-wide">MEDICIÓN COMPLETADA</h3>
                          <p className={`text-${statusColor}-400 text-[10px] font-semibold tracking-wider`}>{statusText}</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => setMeasurementSummary(null)}
                        className="p-1.5 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors"
                      >
                        <X className="w-4 h-4 text-slate-400" />
                      </button>
                    </div>
                  </div>

                  {/* Métricas principales */}
                  <div className="p-4 space-y-2">
                    
                    {/* BPM y SpO2 en fila */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-slate-900/80 rounded-xl p-3 text-center border border-slate-800/50">
                        <Heart className="w-4 h-4 text-red-400 mx-auto mb-1" fill="currentColor" />
                        <div className="text-white text-2xl font-bold leading-none">{avgBpm}</div>
                        <div className="text-slate-500 text-[9px] mt-1 font-medium">BPM PROMEDIO</div>
                      </div>
                      <div className="bg-slate-900/80 rounded-xl p-3 text-center border border-slate-800/50">
                        <Activity className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
                        <div className="text-white text-2xl font-bold leading-none">
                          {vitalSigns.spo2.value != null && vitalSigns.spo2.value > 0 ? Math.round(vitalSigns.spo2.value) : '--'}
                          <span className="text-sm text-slate-400">%</span>
                        </div>
                        <div className="text-slate-500 text-[9px] mt-1 font-medium">SpO₂</div>
                      </div>
                    </div>

                    {/* Presión arterial */}
                    {vitalSigns.bloodPressure.value && vitalSigns.bloodPressure.value.systolic > 0 && (
                      <div className="bg-slate-900/80 rounded-xl p-3 border border-slate-800/50 flex items-center gap-3">
                        <Shield className="w-5 h-5 text-blue-400" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <div className="text-slate-500 text-[9px] font-medium tracking-tight">PRESIÓN ARTERIAL</div>
                            {vitalSigns.bloodPressure.calibration?.available ? (
                              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">CALIBRADO</span>
                            ) : (
                              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400">SIN CALIBRAR</span>
                            )}
                          </div>
                          <div className="text-white text-lg font-bold">
                            {Math.round(vitalSigns.bloodPressure.value.systolic)}/{Math.round(vitalSigns.bloodPressure.value.diastolic)}
                            <span className="text-xs text-slate-500 ml-1">mmHg</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Barras de ritmo */}
                    <div className="bg-slate-900/80 rounded-xl p-3 border border-slate-800/50">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-slate-400 text-[10px] font-semibold tracking-wide">ANÁLISIS DE RITMO</span>
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-slate-500" />
                          <span className="text-slate-500 text-[9px]">60s</span>
                        </div>
                      </div>
                      
                      {/* Latidos normales */}
                      <div className="mb-2">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="text-emerald-400 text-[9px] font-medium">■ Normales</span>
                          <span className="text-white text-xs font-bold">{normalBeats}</span>
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 rounded-full transition-all duration-1000 ease-out"
                               style={{ width: `${totalBeats > 0 ? (normalBeats / totalBeats) * 100 : 0}%` }} />
                        </div>
                      </div>
                      
                      {/* Arritmias */}
                      <div>
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="text-red-400 text-[9px] font-medium">■ Arrítmicos</span>
                          <span className="text-white text-xs font-bold">{arrhythmiaBeats}</span>
                        </div>
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-1000 ease-out ${arrhythmiaBeats > 0 ? 'bg-gradient-to-r from-red-600 to-red-400' : 'bg-slate-700'}`}
                               style={{ width: `${totalBeats > 0 ? (arrhythmiaBeats / totalBeats) * 100 : 100}%` }} />
                        </div>
                      </div>
                    </div>

                    {/* Porcentaje circular visual */}
                    <div className="flex items-center justify-center gap-4 pt-1">
                      <div className="relative w-16 h-16">
                        <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                fill="none" stroke="#1e293b" strokeWidth="3" />
                          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                fill="none"
                                className={`${statusColor === 'emerald' ? 'stroke-emerald-400' : statusColor === 'yellow' ? 'stroke-yellow-400' : 'stroke-red-400'}`}
                                strokeWidth="3"
                                strokeDasharray={`${normalPercent}, 100`}
                                strokeLinecap="round" />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className={`text-sm font-bold ${statusColor === 'emerald' ? 'text-emerald-400' : statusColor === 'yellow' ? 'text-yellow-400' : 'text-red-400'}`}>
                            {normalPercent}%
                          </span>
                        </div>
                      </div>
                      <div>
                        <div className="text-white text-xs font-semibold">Ritmo Normal</div>
                        <div className="text-slate-500 text-[9px]">{totalBeats} latidos analizados</div>
                        <div className={`text-[10px] font-semibold mt-0.5 ${statusColor === 'emerald' ? 'text-emerald-400' : statusColor === 'yellow' ? 'text-yellow-400' : 'text-red-400'}`}>
                          {statusText}
                        </div>
                      </div>
                    </div>
                    {/* Botón Análisis AI */}
                    <button
                      onClick={() => {
                        analyzeVitals({ vitalSigns, quality: lastSignal?.quality || 0 });
                        setShowAIAnalysis(true);
                      }}
                      disabled={isAnalyzing}
                      className="w-full mt-2 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-sm transition-all disabled:opacity-50"
                    >
                      {isAnalyzing ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Analizando...</>
                      ) : (
                        <><Brain className="w-4 h-4" /> Análisis AI de Salud</>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* MODAL ANÁLISIS AI */}
          {showAIAnalysis && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 animate-fade-in">
              <div className="bg-slate-950 border border-slate-700/50 rounded-2xl max-w-sm w-[92%] max-h-[80vh] shadow-2xl overflow-hidden flex flex-col">
                <div className="px-4 py-3 bg-purple-500/10 border-b border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Brain className="w-5 h-5 text-purple-400" />
                    <h3 className="text-white text-sm font-bold">Análisis AI de Salud</h3>
                  </div>
                  <button
                    onClick={() => { setShowAIAnalysis(false); clearAnalysis(); }}
                    className="p-1.5 rounded-full bg-slate-800 hover:bg-slate-700 transition-colors"
                  >
                    <X className="w-4 h-4 text-slate-400" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  {isAnalyzing ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
                      <p className="text-slate-400 text-sm">Analizando tus signos vitales...</p>
                    </div>
                  ) : analysis ? (
                    <div className="text-slate-300 text-xs leading-relaxed whitespace-pre-wrap">
                      {analysis}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <p className="text-slate-500 text-sm">No se pudo generar el análisis.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default Index;
