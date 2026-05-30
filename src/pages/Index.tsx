import React, { useState, useRef, useEffect, useCallback } from "react";
import { Heart, AlertTriangle, Activity, X, Shield, Clock, CheckCircle2, XCircle, Brain, Loader2 } from "lucide-react";
import CameraView, { CameraViewHandle } from "@/components/CameraView";
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useHeartBeatProcessor } from "@/hooks/useHeartBeatProcessor";
import { useVitalSignsProcessor } from "@/hooks/useVitalSignsProcessor";
import { useSaveMeasurement } from "@/hooks/useSaveMeasurement";
import { useHealthAnalysis } from "@/hooks/useHealthAnalysis";
import { useFrameLoop } from "@/hooks/useFrameLoop";
import { useSignalRouter } from "@/hooks/useSignalRouter";
import { useMeasurementSession } from "@/hooks/useMeasurementSession";
import PPGSignalMeter from "@/components/PPGSignalMeter";
import { resolveAcquisitionStatus } from "@/lib/acquisition/resolveAcquisitionStatus";
import { inferCameraRuntimeHints } from "@/lib/device/cameraDeviceProfile";
import type { ContactState } from "@/types/signal";
import { usePerfTelemetry } from "@/hooks/usePerfTelemetry";
import type { BackpressureConfig } from "@/lib/perf/backpressureConfig";

const Index = () => {
  // Canvas sincrónico (render-phase, fuera de effects)
  const cameraRef = useRef<CameraViewHandle>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  if (!canvasRef.current && typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    canvasRef.current = c;
    ctxRef.current = c.getContext('2d', { willReadFrequently: true, alpha: false });
  }

  // Hooks de procesamiento
  const { 
    startProcessing, 
    stopProcessing, 
    lastSignal, 
    processFrame, 
    isProcessing: _isProcessing, 
    getRGBStats,
    getBackpressureState,
    getBackpressureConfig,
    setBackpressureConfig,
    currentStride,
    setSignalCallback,
    setCameraRuntimeHints,
  } = useSignalProcessor();

  const {
    processSignal: processHeartBeat,
    setRuntimeHints: setHeartBeatRuntimeHints,
    reset: resetHeartBeat,
    reacquirePeaks: reacquireHeartPeaks,
  } = useHeartBeatProcessor();

  const { 
    processSignal: processVitalSigns,
    setPlacementMode: setVitalsPlacementMode,
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

  // Camera hints (shared)
  const cameraHintsRef = useRef(inferCameraRuntimeHints());
  const syncCameraHints = useCallback(() => {
    const d = cameraRef.current?.getDiagnostics?.() as Record<string, unknown> | undefined;
    if (!d?.active) return;
    cameraHintsRef.current = inferCameraRuntimeHints(d);
    setCameraRuntimeHints(d);
    setHeartBeatRuntimeHints(cameraHintsRef.current);
  }, [setCameraRuntimeHints, setHeartBeatRuntimeHints]);

  // Frame loop
  const { startFrameLoop, stopFrameLoop } = useFrameLoop({
    cameraRef,
    canvasRef,
    ctxRef,
    processFrame,
  });

  // Signal router (encapsula todo el routing de señal, throttling, latch, sanity)
  const router = useSignalRouter({
    processHeartBeat: {
      processSignal: processHeartBeat,
      setFingerPlacementMode: (_mode) => { /* via processHeartBeat */ },
      setRuntimeHints: setHeartBeatRuntimeHints,
      reacquirePeaks: reacquireHeartPeaks,
      reset: resetHeartBeat,
    },
    processVitalSigns: {
      processSignal: processVitalSigns,
      setPlacementMode: setVitalsPlacementMode,
      setRGBData,
      getRGBStats,
    },
    cameraHintsRef,
  });

  // Session management
  const session = useMeasurementSession({
    cameraRef,
    startFrameLoop,
    stopFrameLoop,
    startProcessing,
    stopProcessing,
    startCalibration,
    forceCalibrationCompletion,
    resetVitalSigns,
    fullResetVitalSigns,
    resetHeartBeat,
    saveMeasurement,
    setCameraRuntimeHints,
    syncCameraHints,
    resetFingerContactSession: router.resetFingerContactSession,
    resetSessionRefs: router.resetSessionRefs,
    setShowResults: (v) => session.setLocalShowResults(v),
    setMeasurementSummary: (v) => session.setLocalMeasurementSummary(v),
    setHeartbeatSignal: (v) => router.setHeartbeatSignal(v),
    setBeatMarker: (v) => router.setBeatMarker(v),
    setRRIntervals: (v) => router.setRRIntervals(v),
    setVitalSigns: router.setVitalSigns,
    vitalSignsRef: router.vitalSignsRef,
    totalBeatsRef: router.totalBeatsRef,
    arrhythmiaBeatsRef: router.arrhythmiaBeatsRef,
    motionArtifactFramesRef: router.motionArtifactFramesRef,
    saturationFramesRef: router.saturationFramesRef,
    underexposedFramesRef: router.underexposedFramesRef,
    artifactCheckFramesRef: router.artifactCheckFramesRef,
    lastArrhythmiaData: router.lastArrhythmiaData,
    isMonitoringRef: router.isMonitoringRef,
    lastSignal,
    sanityProfileId: router.sanityProfileId,
    getBackpressureConfig,
    setHeartBeatRuntimeHints,
  });

  // Conectar handleSignalRealtime al pipeline
  useEffect(() => {
    setSignalCallback(router.handleSignalRealtime);
    return () => setSignalCallback(null);
  }, [setSignalCallback, router.handleSignalRealtime]);

  // Sincronizar isMonitoringRef
  useEffect(() => {
    router.setIsMonitoringRef(session.isMonitoring);
  }, [session.isMonitoring, router]);

  // Al estabilizarse el contacto, bloquear la exposición de la cámara a la
  // escena real del dedo iluminado. Frena la deriva del auto-exposure (causa del
  // arranque errático de ~25-30 s). Se re-arma al perder el contacto.
  const exposureLockedRef = useRef(false);
  // Ref con el último rojo medido: el effect de abajo lo lee en la transición a
  // STABLE_CONTACT sin depender de él (no re-ejecuta por frame ni queda obsoleto).
  const lastRawRedRef = useRef(0);
  if (typeof lastSignal?.rawRed === 'number') lastRawRedRef.current = lastSignal.rawRed;
  useEffect(() => {
    const cs = lastSignal?.contactState;
    if (cs === 'NO_CONTACT' || cs == null) {
      exposureLockedRef.current = false;
      return;
    }
    if (!exposureLockedRef.current && cs === 'STABLE_CONTACT') {
      exposureLockedRef.current = true;
      // Acción concreta sobre el hardware: foco cercano + WB bloqueado + exposición
      // auto-optimizada según el nivel REAL del rojo del dedo (no un valor fijo).
      cameraRef.current?.optimizeForFinger?.(lastRawRedRef.current);
    }
  }, [lastSignal?.contactState]);

  // Sincronizar resultados post-medición
  useEffect(() => {
    if (lastValidResults && !session.isMonitoring) {
      router.setVitalSigns(lastValidResults);
      session.setLocalShowResults(true);
    }
  }, [lastValidResults, session.isMonitoring, router, session]);

  // UI states
  const [showAIAnalysis, setShowAIAnalysis] = useState(false);
  const [_bpCfg, setBpCfg] = useState<BackpressureConfig>(() => getBackpressureConfig());
  const _updateBp = useCallback((patch: Partial<BackpressureConfig>) => {
    const next = setBackpressureConfig(patch);
    setBpCfg(next);
  }, [setBackpressureConfig]);

  usePerfTelemetry({
    enabled: false,
    intervalMs: 15000,
    context: {
      getCamera: () => cameraRef.current?.getDiagnostics?.() ?? {},
      getPipeline: () => ({
        sqi: lastSignal?.quality ?? 0,
        fingerDetected: !!lastSignal?.fingerDetected,
        perfusionIndex: lastSignal?.perfusionIndex ?? 0,
        bpm: router.vitalSigns.heartRate.value,
        spo2: router.vitalSigns.spo2.value,
        confidence: router.vitalSigns.heartRate.status === 'VALID' ? 'HIGH' : 'INVALID',
        backpressure: getBackpressureState(),
      }),
    },
  });

  // Backpressure toast notification
  const prevStrideRef = useRef<number>(currentStride);
  useEffect(() => {
    if (session.isMonitoring && prevStrideRef.current === currentStride) return;
    const prev = prevStrideRef.current;
    prevStrideRef.current = currentStride;
    if (!session.isMonitoring || currentStride === prev) return;
    try {
      const cfg = getBackpressureConfig();
      if (typeof cfg.forceStride === 'number' || !cfg.enabled) return;
    } catch { return; }
    if (currentStride > prev) {
      import('@/hooks/use-toast').then(({ toast }) => toast({
        title: "⚡ Modo ahorro activado",
        description: `Rendimiento bajo detectado (stride ${currentStride}).`,
        duration: 3000,
      }));
    } else {
      import('@/hooks/use-toast').then(({ toast }) => toast({
        title: "✓ Rendimiento restaurado",
        description: `Muestreo completo (stride ${currentStride}).`,
        duration: 2500,
      }));
    }
  }, [currentStride, session.isMonitoring, getBackpressureConfig]);

  // Adquisición status para UI
  const acquisitionStatusLabel = React.useMemo(() => {
    if (!lastSignal) return "WARMUP";
    const d = lastSignal.diagnostics as Record<string, unknown> | undefined;
    const sqm = d?.sqm as Record<string, number> | undefined;
    const cam = cameraRef.current?.getDiagnostics?.() as Record<string, unknown> | undefined;
    const cs: ContactState =
      lastSignal.contactState ??
      (lastSignal.fingerDetected ? "UNSTABLE_CONTACT" : "NO_CONTACT");
    return resolveAcquisitionStatus({
      contactState: cs,
      fingerDetected: !!lastSignal.fingerDetected,
      coverageRatio: (d?.coverageRatio as number) ?? 0,
      perfusionIndex: lastSignal.perfusionIndex ?? 0,
      motionScore: sqm?.motionScore ?? 0,
      saturationRatio: sqm?.saturationRatio ?? 0,
      underexposureRatio: sqm?.underexposureRatio ?? 0,
      fpsEffective: sqm?.fpsEffective ?? 30,
      frameDropRatio: sqm?.frameDropRatio ?? 0,
      timestampJitterMs: sqm?.timestampJitterMs ?? 0,
      torchActive: cam?.torchActive as boolean | undefined,
      torchSupported: cam?.torchSupported as boolean | undefined,
    });
  }, [lastSignal]);

  // CONTROL DE CALIBRACIÓN
  useEffect(() => {
    if (!router.vitalSigns.isCalibrating) return;
    
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
  }, [router.vitalSigns.isCalibrating, getCalibrationProgress]);

  // Camera error toast
  useEffect(() => {
    const handler = () => {
      import('@/hooks/use-toast').then(({ toast }) => toast({
        title: "Cámara trasera no disponible",
        description: "Verifica los permisos de cámara e intenta nuevamente.",
        duration: 5000,
      }));
    };
    window.addEventListener('camera-error', handler);
    return () => window.removeEventListener('camera-error', handler);
  }, []);

  const handleToggleMonitoring = () => {
    if (session.isMonitoring) {
      session.finalizeMeasurement();
    } else {
      session.startMonitoring();
    }
  };

  const handleReset = () => {
    session.handleReset();
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
      {!session.isFullscreen && (
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
              onClick={session.enterFullScreen}
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

        {/* CÁMARA */}
        <div className="absolute inset-0">
          <CameraView 
            ref={cameraRef}
            onStreamReady={session.handleStreamReady}
            isMonitoring={session.isCameraOn}
          />
        </div>

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
              value={router.heartbeatSignal}
              quality={lastSignal?.quality || 0}
              isFingerDetected={
                !!lastSignal?.fingerDetected &&
                lastSignal?.contactState !== 'NO_CONTACT'
              }
              onStartMeasurement={handleToggleMonitoring}
              onReset={handleReset}
              isMonitoring={session.isMonitoring}
              arrhythmiaStatus={router.vitalSigns.arrhythmia.value?.status ?? ''}
              rawArrhythmiaData={router.lastArrhythmiaData.current}
              preserveResults={session.showResults}
              isPeak={router.beatMarker === 1}
              bpm={router.vitalSigns.heartRate.value ?? null}
              spo2={router.vitalSigns.spo2.value || 0}
              arrhythmiaCount={router.vitalSigns.arrhythmia.value?.count ?? 0}
              rrIntervals={router.rrIntervals}
              elapsedTime={session.elapsedTime}
              perfusionIndex={lastSignal?.perfusionIndex || 0}
              pressure={{
                ...(router.vitalSigns.bloodPressure.value ?? { systolic: 0, diastolic: 0 }),
                confidence: router.vitalSigns.bloodPressure.status,
                featureQuality:
                  typeof router.vitalSigns.bloodPressure.diagnostics?.featureQuality === 'number'
                    ? router.vitalSigns.bloodPressure.diagnostics.featureQuality
                    : undefined,
              }}
              bpStatus={router.vitalSigns.bloodPressure.status}
              contactState={
                lastSignal?.contactState ??
                (lastSignal?.fingerDetected ? 'UNSTABLE_CONTACT' : 'NO_CONTACT')
              }
              acquisitionStatus={acquisitionStatusLabel}
              diagnostics={router.currentDiagnostics as unknown as import('@/components/PPGSignalMeter').PPGSignalMeterProps['diagnostics']}
            />
          </div>

          {/* RESUMEN ESTADÍSTICO POST-MEDICIÓN */}
          {session.showResults && session.measurementSummary && (() => {
            const { totalBeats, arrhythmiaBeats, normalPercent } = session.measurementSummary;
            const normalBeats = totalBeats - arrhythmiaBeats;
            const avgBpm = (router.vitalSigns.heartRate.value ?? 0) > 0 ? Math.round(router.vitalSigns.heartRate.value!) : '--';
            const statusColor = normalPercent >= 95 ? 'emerald' : normalPercent >= 80 ? 'yellow' : 'red';
            const statusText = normalPercent >= 95 ? 'RITMO NORMAL' : normalPercent >= 80 ? 'LEVE IRREGULARIDAD' : 'IRREGULARIDAD DETECTADA';
            const statusIcon = normalPercent >= 95 ? CheckCircle2 : normalPercent >= 80 ? AlertTriangle : XCircle;
            const bgClass = statusColor === 'emerald' ? 'bg-emerald-500/10' : statusColor === 'yellow' ? 'bg-yellow-500/10' : 'bg-red-500/10';
            const textClass = statusColor === 'emerald' ? 'text-emerald-400' : statusColor === 'yellow' ? 'text-yellow-400' : 'text-red-400';
            const strokeClass = statusColor === 'emerald' ? 'stroke-emerald-400' : statusColor === 'yellow' ? 'stroke-yellow-400' : 'stroke-red-400';
            const StatusIcon = statusIcon;
            
            return (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 animate-fade-in">
                <div className="bg-slate-950 border border-slate-700/50 rounded-2xl max-w-sm w-[92%] shadow-2xl overflow-hidden">
                  
                  {/* Header con estado */}
                  <div className={`px-4 py-3 ${bgClass} border-b border-slate-800`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <StatusIcon className={`w-5 h-5 ${textClass}`} />
                        <div>
                          <h3 className="text-white text-sm font-bold tracking-wide">MEDICIÓN COMPLETADA</h3>
                          <p className={`${textClass} text-[10px] font-semibold tracking-wider`}>{statusText}</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => session.setLocalMeasurementSummary(null)}
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
                          {router.vitalSigns.spo2.value != null && router.vitalSigns.spo2.value > 0 ? Math.round(router.vitalSigns.spo2.value) : '--'}
                          <span className="text-sm text-slate-400">%</span>
                        </div>
                        <div className="text-slate-500 text-[9px] mt-1 font-medium">SpO₂</div>
                      </div>
                    </div>

                    {/* Presión arterial */}
                    {router.vitalSigns.bloodPressure.value && router.vitalSigns.bloodPressure.value.systolic > 0 && (
                      <div className="bg-slate-900/80 rounded-xl p-3 border border-slate-800/50 flex items-center gap-3">
                        <Shield className="w-5 h-5 text-blue-400" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <div className="text-slate-500 text-[9px] font-medium tracking-tight">PRESIÓN ARTERIAL</div>
                            {router.vitalSigns.bloodPressure.calibration?.available ? (
                              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">CALIBRADO</span>
                            ) : (
                              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400">SIN CALIBRAR</span>
                            )}
                          </div>
                          <div className="text-white text-lg font-bold">
                            {Math.round(router.vitalSigns.bloodPressure.value.systolic)}/{Math.round(router.vitalSigns.bloodPressure.value.diastolic)}
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
                                className={strokeClass}
                                strokeWidth="3"
                                strokeDasharray={`${normalPercent}, 100`}
                                strokeLinecap="round" />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className={`text-sm font-bold ${textClass}`}>
                            {normalPercent}%
                          </span>
                        </div>
                      </div>
                      <div>
                        <div className="text-white text-xs font-semibold">Ritmo Normal</div>
                        <div className="text-slate-500 text-[9px]">{totalBeats} latidos analizados</div>
                        <div className={`text-[10px] font-semibold mt-0.5 ${textClass}`}>
                          {statusText}
                        </div>
                      </div>
                    </div>
                    {/* Botón Análisis AI */}
                    <button
                      onClick={() => {
                        analyzeVitals({ vitalSigns: router.vitalSigns, quality: lastSignal?.quality || 0 });
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
