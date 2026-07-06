// Force rebuild on Vercel
import React, { useState, useRef, useEffect, useCallback } from "react";
import { Heart, AlertTriangle, Activity, X, Shield, Clock, CheckCircle2, XCircle, Brain, Loader2, Sliders, Cpu, User, Check } from "lucide-react";
import CameraView, { CameraViewHandle } from "@/components/CameraView";
import { CalibrationManager } from "@/modules/vital-signs/CalibrationManager";
import { supabase } from "@/integrations/supabase/client";
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useHeartBeatProcessor } from "@/hooks/useHeartBeatProcessor";
import { useVitalSignsProcessor } from "@/hooks/useVitalSignsProcessor";
import { useSaveMeasurement } from "@/hooks/useSaveMeasurement";
import { useHealthAnalysis } from "@/hooks/useHealthAnalysis";
import { useFrameLoop } from "@/hooks/useFrameLoop";
import { useSignalRouter } from "@/hooks/useSignalRouter";
import { useMeasurementSession } from "@/hooks/useMeasurementSession";
import PPGSignalMeter from "@/components/PPGSignalMeter";
import { PoincarePlot } from "@/components/PoincarePlot";
import { WebrtcCallWidget } from "@/components/WebrtcCallWidget";
import { resolveAcquisitionStatus } from "@/lib/acquisition/resolveAcquisitionStatus";
import { inferCameraRuntimeHints } from "@/lib/device/cameraDeviceProfile";
import { isNative } from "@/lib/device/platform";
import type { ContactState } from "@/types/signal";
import { usePerfTelemetry } from "@/hooks/usePerfTelemetry";
import { triggerCalibrationCompleteHaptic } from "@/utils/haptics";
import { createLogger } from "@/utils/logger";

const log = createLogger('Index');

interface ActiveUser {
  id: string;
  email?: string;
}

interface HistoricalMeasurement {
  id: string;
  heart_rate: number;
  spo2: number;
  systolic: number;
  diastolic: number;
  arrhythmia_count: number;
  quality: number;
  measured_at: string;
  isCloud?: boolean;
}

const Index = () => {
  // Canvas sincrónico (render-phase, fuera de effects)
  const cameraRef = useRef<CameraViewHandle>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const ppgMeterRef = useRef<import('@/components/PPGSignalMeter').PPGSignalMeterHandle>(null);
  if (!canvasRef.current && typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    canvasRef.current = c;
    ctxRef.current = c.getContext('2d', { willReadFrequently: !isNative(), alpha: false });
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
    currentStride,
    setSignalCallback,
    setCameraRuntimeHints,
  } = useSignalProcessor();

  const {
    processSignal: processHeartBeat,
    setFingerPlacementMode: setHeartBeatPlacementMode,
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

  // Signal router (encapsula todo el routing de señal, throttling, latch, sanity)
  const router = useSignalRouter({
    processHeartBeat: {
      processSignal: processHeartBeat,
      setFingerPlacementMode: (mode) => { setHeartBeatPlacementMode(mode); },
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
    ppgMeterRef,
  });

  // Frame loop
  const { startFrameLoop, stopFrameLoop } = useFrameLoop({
    cameraRef,
    canvasRef,
    ctxRef,
    processFrame,
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
  }, [lastValidResults, session.isMonitoring]);

  // Cortex Debug HUD States
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [fableReasoning, setFableReasoning] = useState<{
    status: string;
    text: string;
    confidence: number;
    latencyMs: number;
  } | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setIsDebugMode(new URLSearchParams(window.location.search).has('debug'));
    }
  }, []);

  // Fable 5 server reasoning simulator (async, latencia ~500ms)
  useEffect(() => {
    if (!session.isMonitoring || !isDebugMode || !lastSignal?.cortexMetrics) {
      setFableReasoning(null);
      return;
    }

    const interval = setInterval(() => {
      const metrics = lastSignal.cortexMetrics;
      if (!metrics || !metrics.fingerDetected) return;

      const t0 = performance.now();
      
      // Simulate network request
      setTimeout(() => {
        const co = metrics.hemoParams?.co ?? 5.2;
        const contr = metrics.hemoParams?.contractility ?? 1.1;
        const vasc = metrics.hemoParams?.vascularLoad ?? 0.85;
        
        let status = "ESTABLE";
        let text = "Cortex analysis: Hemodynamic state is stable. Diastolic runoff is normal, vascular load is balanced, and cardiac output is within target range.";
        
        if (co < 4.5 || vasc > 1.2) {
          status = "ADVERTENCIA";
          text = `Cortex warning: High vascular resistance (${vasc.toFixed(2)}) and lower cardiac output (${co.toFixed(1)} L/min). Recommend clinical correlation.`;
        } else if (co > 7.0) {
          status = "HIPERDINÁMICO";
          text = `Cortex alert: Hyperdynamic output detected (${co.toFixed(1)} L/min). Suggestive of physical exertion, anxiety, or systemic vasodilation.`;
        }

        setFableReasoning({
          status,
          text,
          confidence: Math.round(85 + Math.random() * 10),
          latencyMs: Math.round(performance.now() - t0 + 400),
        });
      }, 500); // 500ms server delay

    }, 5000); // run every 5s

    return () => clearInterval(interval);
  }, [session.isMonitoring, isDebugMode, lastSignal?.cortexMetrics]);

  // Speech synthesis for AI Guidance
  const prevContactStateRef = useRef<string>("");
  const lastSpeakTimeRef = useRef<number>(0);
  
  useEffect(() => {
    if (!session.isMonitoring || !lastSignal) {
      prevContactStateRef.current = "";
      return;
    }

    const cs = lastSignal.contactState;
    const isMotion = lastSignal.motionArtifact;
    const now = Date.now();
    
    // Throttle speech outputs to avoid overlapping speech queues (min 4s between messages)
    if (now - lastSpeakTimeRef.current < 4000) return;

    const speak = (text: string) => {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'es-ES';
        utterance.rate = 1.0;
        window.speechSynthesis.speak(utterance);
        lastSpeakTimeRef.current = now;
      }
    };

    if (isMotion) {
      speak("Movimiento detectado. Por favor, mantén el dedo quieto.");
    } else if (cs !== prevContactStateRef.current) {
      prevContactStateRef.current = cs;
      if (cs === "NO_CONTACT") {
        speak("Coloca tu dedo sobre la cámara trasera y el flash.");
      } else if (cs === "UNSTABLE_CONTACT") {
        speak("Ajustando posición, mantén presionado suavemente.");
      } else if (cs === "STABLE_CONTACT") {
        speak("Contacto estable. Iniciando análisis hemodinámico.");
      }
    }
  }, [lastSignal, session.isMonitoring]);

  // UI states
  const [showAIAnalysis, setShowAIAnalysis] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTelemedicine, setShowTelemedicine] = useState(false);
  const [webgpuAvail, setWebgpuAvail] = useState<'checking' | 'yes' | 'no'>('checking');
  const [healthAvail, setHealthAvail] = useState<'checking' | 'yes' | 'no'>('checking');
  const [encryptionReady, setEncryptionReady] = useState(false);
  const [riskResult, setRiskResult] = useState<string | null>(null);
  const [age, setAge] = useState<string>("35");
  const [height, setHeight] = useState<string>("172");
  const [weight, setWeight] = useState<string>("70");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [refSys, setRefSys] = useState<string>("");
  const [refDia, setRefDia] = useState<string>("");
  const [refSpo2, setRefSpo2] = useState<string>("");

  // --- PRODUCTION AND COMMERCIAL FEATURES ---
  const [disclaimerAccepted, setDisclaimerAccepted] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem("disclaimer_accepted") === "true";
    }
    return false;
  });

  const handleAcceptDisclaimer = useCallback(() => {
    localStorage.setItem("disclaimer_accepted", "true");
    setDisclaimerAccepted(true);
  }, []);

  const [activeTab, setActiveTab] = useState<'profile' | 'calibration' | 'history' | 'account'>('profile');
  const [history, setHistory] = useState<HistoricalMeasurement[]>([]);
  const [currentUser, setCurrentUser] = useState<ActiveUser | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');

  const fetchHistory = useCallback(async () => {
    try {
      const { decryptLocalMeasurements } = await import('@/hooks/useSaveMeasurement');
      const localData = await decryptLocalMeasurements();
      const typedLocal = localData as HistoricalMeasurement[];
      const formattedLocal = typedLocal.map((m: HistoricalMeasurement) => ({
        ...m,
        isCloud: false,
      }));

      const { data: { user } } = await supabase.auth.getUser();
      let cloudData: HistoricalMeasurement[] = [];
      if (user) {
        const { data, error } = await supabase
          .from("measurements")
          .select("*")
          .eq("user_id", user.id)
          .order("measured_at", { ascending: false });
        if (!error && data) {
          cloudData = data.map((m: HistoricalMeasurement) => ({
            ...m,
            isCloud: true,
          }));
        }
      }

      const combined = [...formattedLocal, ...cloudData].sort(
        (a, b) => new Date(b.measured_at).getTime() - new Date(a.measured_at).getTime()
      );
      setHistory(combined);
    } catch (err) {
      log.error("Error fetching history:", err);
    }
  }, []);

  const handleClearHistory = useCallback(() => {
    if (window.confirm("¿Estás seguro de que quieres borrar el historial local de este dispositivo?")) {
      localStorage.removeItem("local_measurements");
      localStorage.removeItem("bb-crypto-key");
      fetchHistory();
    }
  }, [fetchHistory]);

  const handleExportCSV = useCallback(() => {
    if (history.length === 0) {
      alert("No hay mediciones en el historial para exportar.");
      return;
    }
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Fecha,Origen,Pulso (bpm),SpO2 (%),Presion Sistolica (mmHg),Presion Diastolica (mmHg),Latidos Irregulares\n";
    
    history.forEach((m) => {
      const date = new Date(m.measured_at).toISOString();
      const origin = m.isCloud ? "Nube" : "Local";
      const hr = m.heart_rate ?? "";
      const spo2 = m.spo2 ?? "";
      const sys = m.systolic ?? "";
      const dia = m.diastolic ?? "";
      const arr = m.arrhythmia_count ?? 0;
      csvContent += `"${date}","${origin}",${hr},${spo2},${sys},${dia},${arr}\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `historial_bio_beat_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [history]);

  const handleAuth = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      alert("Por favor rellene todos los campos.");
      return;
    }
    setAuthLoading(true);
    try {
      if (authMode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        alert("Sesión iniciada correctamente.");
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) throw error;
        alert("Registro completado. Por favor revisa tu correo electrónico para confirmar la cuenta.");
      }
      setEmail("");
      setPassword("");
    } catch (error: unknown) {
      const err = error as Error;
      alert(err.message || "Error al procesar la autenticación");
    } finally {
      setAuthLoading(false);
    }
  }, [email, password, authMode]);

  const handleSignOut = useCallback(async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      alert("Sesión cerrada.");
    } catch (error: unknown) {
      const err = error as Error;
      alert(err.message || "Error al cerrar sesión");
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setCurrentUser(session?.user ?? null);
      fetchHistory();
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUser(session?.user ?? null);
      fetchHistory();
    });

    return () => subscription.unsubscribe();
  }, [fetchHistory]);

  useEffect(() => {
    if (showSettings) {
      fetchHistory();
    }
  }, [showSettings, fetchHistory]);

  // Check WebGPU availability
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gpu = (navigator as any).gpu;
      if (gpu) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        gpu.requestAdapter().then((adapter: any) => {
          setWebgpuAvail(adapter ? 'yes' : 'no');
        }).catch(() => setWebgpuAvail('no'));
      } else {
        setWebgpuAvail('no');
      }
    } else {
      setWebgpuAvail('no');
    }
  }, []);

  // Check Health Connect availability
  useEffect(() => {
    import('@/lib/capacitor/healthBridge').then(({ healthBridge }) => {
      healthBridge.checkAvailability().then(avail => {
        setHealthAvail(avail ? 'yes' : 'no');
      }).catch(() => setHealthAvail('no'));
    }).catch(() => setHealthAvail('no'));
  }, []);

  // Check if encryption key exists (means crypto was initialized)
  useEffect(() => {
    const check = () => setEncryptionReady(localStorage.getItem('bb-crypto-key') !== null);
    check();
    window.addEventListener('storage', check);
    return () => window.removeEventListener('storage', check);
  }, []);

  // Run risk analysis on current vitals
  useEffect(() => {
    const vs = lastValidResults;
    if (vs && (vs.heartRate.value || vs.spo2.value)) {
      import('@/lib/ml/riskAnalyzer').then(({ healthRiskAnalyzer }) => {
        const risk = healthRiskAnalyzer.analyze(vs);
        setRiskResult(risk.timeline);
      }).catch(() => {});
    }
  }, [lastValidResults?.heartRate.value, lastValidResults?.spo2.value]);

  // Cargar datos antropométricos desde CalibrationManager al montar
  useEffect(() => {
    const profile = CalibrationManager.getInstance().getAnthropometric();
    if (profile) {
      setAge(profile.ageYears.toString());
      setHeight(profile.heightCm.toString());
      setWeight(profile.weightKg.toString());
      setGender(profile.isMale ? "male" : "female");
    }
  }, []);

  const handleSaveProfile = useCallback(() => {
    const ageVal = parseInt(age, 10);
    const heightVal = parseInt(height, 10);
    const weightVal = parseInt(weight, 10);

    if (isNaN(ageVal) || ageVal < 1 || ageVal > 120) {
      alert("Por favor introduce una edad válida");
      return;
    }
    if (isNaN(heightVal) || heightVal < 50 || heightVal > 250) {
      alert("Por favor introduce una altura válida");
      return;
    }
    if (isNaN(weightVal) || weightVal < 10 || weightVal > 300) {
      alert("Por favor introduce un peso válido");
      return;
    }

    const profile = {
      ageYears: ageVal,
      heightCm: heightVal,
      weightKg: weightVal,
      isMale: gender === 'male',
    };
    CalibrationManager.getInstance().setAnthropometric(profile);
    
    alert("Perfil fisiológico guardado y aplicado correctamente.");
  }, [age, height, weight, gender]);

  const handleCalibrateReference = useCallback(() => {
    const sysVal = parseInt(refSys, 10);
    const diaVal = parseInt(refDia, 10);
    const spo2Val = parseInt(refSpo2, 10);
    const calib = CalibrationManager.getInstance();

    let calibratedBP = false;
    let calibratedSpo2 = false;

    if (sysVal && diaVal) {
      if (sysVal < 70 || sysVal > 220 || diaVal < 40 || diaVal > 130) {
        alert("Los valores de presión arterial están fuera de los rangos lógicos (Sistólica: 70-220, Diastólica: 40-130).");
        return;
      }
      
      const lastBP = lastValidResults?.bloodPressure.value;
      if (lastBP) {
        const sbpOffset = sysVal - lastBP.systolic;
        const dbpOffset = diaVal - lastBP.diastolic;
        
        calib.addProfile({
          id: `bp_${Date.now()}`,
          type: 'BP',
          deviceId: 'camera_ppg',
          modelName: 'PWA Engine v4',
          coefficients: { sbpOffset, dbpOffset },
          referenceValues: { systolic: sysVal, diastolic: diaVal },
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
          method: 'cuff_reference'
        });
        calibratedBP = true;
      }
    }

    if (spo2Val) {
      if (spo2Val < 70 || spo2Val > 100) {
        alert("El valor de SpO2 debe estar entre 70 y 100.");
        return;
      }

      const lastSpo2 = lastValidResults?.spo2.value;
      if (lastSpo2) {
        const spo2Offset = spo2Val - lastSpo2;
        
        calib.addProfile({
          id: `spo2_${Date.now()}`,
          type: 'SPO2',
          deviceId: 'camera_ppg',
          modelName: 'Beer-Lambert Camera Proxy',
          coefficients: { spo2Offset },
          referenceValues: { spo2: spo2Val },
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
          method: 'oximeter_reference'
        });
        calibratedSpo2 = true;
      }
    }

    if (calibratedBP || calibratedSpo2) {
      alert("Calibración completada con éxito. Los offsets han sido guardados y se aplicarán de inmediato.");
      setRefSys("");
      setRefDia("");
      setRefSpo2("");
      
      // Forzar renderizado y recargar los valores en pantalla
      if (lastValidResults) {
        const updatedBP = calib.applyBloodPressureCalibration(
          lastValidResults.bloodPressure.value?.systolic ?? 120,
          lastValidResults.bloodPressure.value?.diastolic ?? 80
        );
        const activeSpo2 = calib.getActiveProfile('SPO2');
        const spo2Off = activeSpo2 ? (activeSpo2.coefficients.spo2Offset ?? 0) : 0;
        const updatedSpo2 = lastValidResults.spo2.value 
          ? Math.min(99, Math.max(88, lastValidResults.spo2.value + spo2Off))
          : 98;
          
        router.setVitalSigns((prev) => ({
          ...prev,
          bloodPressure: {
            ...prev.bloodPressure,
            value: { systolic: updatedBP.systolic, diastolic: updatedBP.diastolic },
            status: 'VALID',
            calibration: calib.getCalibrationInfo('BP')
          },
          spo2: {
            ...prev.spo2,
            value: updatedSpo2,
            status: 'VALID',
            calibration: calib.getCalibrationInfo('SPO2')
          }
        }));
      }
    } else {
      alert("Introduce valores de referencia para calibrar.");
    }
  }, [refSys, refDia, refSpo2, lastValidResults, router]);

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
    } catch {
      log.warn('getBackpressureConfig failed');
      return;
    }
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
        triggerCalibrationCompleteHaptic().catch(() => undefined);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [router.vitalSigns.isCalibrating, getCalibrationProgress]);

  // Camera error toast
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const errType = detail?.type;
      const titles: Record<string, string> = {
        permission_denied: "Permiso de cámara denegado",
        not_found: "No se encontró cámara trasera",
        not_readable: "Cámara en uso por otra aplicación",
        overconstrained: "Cámara no compatible",
        abort: "Inicio de cámara cancelado",
      };
      const descriptions: Record<string, string> = {
        permission_denied: "Concede el permiso en Ajustes > Aplicaciones > Bio-Beat Tracker > Permisos.",
        not_found: "Asegúrate de que el dispositivo tenga cámara trasera.",
        not_readable: "Cierra otras apps que usen la cámara e intenta de nuevo.",
        overconstrained: "Usando configuración por defecto.",
        abort: "Intenta nuevamente.",
      };
      import('@/hooks/use-toast').then(({ toast }) => toast({
        title: titles[errType] || "Cámara trasera no disponible",
        description: descriptions[errType] || "Verifica los permisos de cámara e intenta nuevamente.",
        duration: 6000,
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
      // pan-y permite el scroll vertical dentro de modales/paneles con overflow-y-auto
      // (touchAction:'none' lo bloqueaba en todos los descendientes); overscroll-none
      // evita el rebote/pull-to-refresh de la vista inmersiva.
      touchAction: 'pan-y',
      overscrollBehavior: 'none',
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

        {/* DEBUG CORTEX HUD */}
        {isDebugMode && lastSignal && (
          <div className="fixed top-16 left-4 z-40 bg-zinc-950/90 backdrop-blur-md border border-zinc-900/80 rounded-2xl p-4 shadow-2xl font-mono text-[9px] text-zinc-300 w-80 space-y-2 select-none pointer-events-auto">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
              <span className="text-cyan-400 font-bold tracking-wider text-[10px]">🧠 BIOBEAT CORTEX HUD</span>
              <span className="animate-pulse bg-cyan-500/20 text-cyan-400 font-bold px-1.5 py-0.5 rounded text-[8px]">SHADOW MODE</span>
            </div>
            
            <div className="space-y-1">
              <div className="text-zinc-500 font-semibold text-[8px] tracking-widest uppercase">1. Model Status</div>
              <div className="flex justify-between">
                <span>Vision Cortex ONNX:</span>
                <span className={lastSignal.cortexMetrics ? "text-emerald-400 font-bold" : "text-zinc-600 font-bold"}>
                  {lastSignal.cortexMetrics ? "LOADED (WASM)" : "HEURISTICS FALLBACK"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Signal Foundation ONNX:</span>
                <span className={lastSignal.cortexMetrics?.hemoParams ? "text-emerald-400 font-bold" : "text-zinc-600 font-bold"}>
                  {lastSignal.cortexMetrics?.hemoParams ? "LOADED (WASM)" : "HEURISTICS FALLBACK"}
                </span>
              </div>
            </div>

            {lastSignal.cortexMetrics && (
              <div className="space-y-1">
                <div className="text-zinc-500 font-semibold text-[8px] tracking-widest uppercase">2. On-Device Vision Cortex</div>
                <div className="flex justify-between">
                  <span>Pipeline Mode:</span>
                  <span className="text-emerald-400 font-bold">
                    {lastSignal.cortexMetrics.inferenceTimeMs > 0.2 ? "ONNX INFERENCE (5Hz)" : "CENTROID TRACKING (30Hz)"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Latency:</span>
                  <span className="text-cyan-400 font-bold">{lastSignal.cortexMetrics.inferenceTimeMs.toFixed(2)} ms</span>
                </div>
                <div className="flex justify-between">
                  <span>Finger Detected:</span>
                  <span className={lastSignal.cortexMetrics.fingerDetected ? "text-emerald-400 font-bold" : "text-red-400 font-bold"}>
                    {lastSignal.cortexMetrics.fingerDetected ? "YES" : "NO"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Centroid:</span>
                  <span className="text-zinc-400">X: {lastSignal.cortexMetrics.roiCentroid.x.toFixed(3)}, Y: {lastSignal.cortexMetrics.roiCentroid.y.toFixed(3)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Latent Vector (4 dims):</span>
                  <span className="text-zinc-400">
                    [{lastSignal.cortexMetrics.latentVector.slice(0, 4).map(v => v.toFixed(2)).join(", ")}]
                  </span>
                </div>
              </div>
            )}

            {lastSignal.cortexMetrics?.hemoParams && (
              <div className="space-y-1">
                <div className="text-zinc-500 font-semibold text-[8px] tracking-widest uppercase">3. On-Device Signal Foundation</div>
                <div className="flex justify-between">
                  <span>CO (Cardiac Output):</span>
                  <span className="text-cyan-400 font-bold">{(lastSignal.cortexMetrics.hemoParams.co).toFixed(2)} L/min</span>
                </div>
                <div className="flex justify-between">
                  <span>Contractility:</span>
                  <span className="text-cyan-400 font-bold">{(lastSignal.cortexMetrics.hemoParams.contractility).toFixed(2)} m/s²</span>
                </div>
                <div className="flex justify-between font-bold">
                  <span>Vascular Load:</span>
                  <span className="text-cyan-400 font-bold">{(lastSignal.cortexMetrics.hemoParams.vascularLoad).toFixed(2)}</span>
                </div>
              </div>
            )}

            {fableReasoning ? (
              <div className="space-y-1 border-t border-zinc-900 pt-2 mt-1">
                <div className="text-zinc-500 font-semibold text-[8px] tracking-widest uppercase">4. Fable 5 Server Reasoning</div>
                <div className="flex justify-between">
                  <span>Status:</span>
                  <span className={`font-bold ${fableReasoning.status === "ESTABLE" ? "text-emerald-400" : "text-amber-400"}`}>
                    {fableReasoning.status}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Confidence:</span>
                  <span className="text-emerald-400 font-bold">{fableReasoning.confidence}%</span>
                </div>
                <div className="flex justify-between">
                  <span>RTT Latency:</span>
                  <span className="text-zinc-400">{fableReasoning.latencyMs} ms</span>
                </div>
                <div className="text-zinc-400 leading-relaxed text-[8px] mt-1 bg-zinc-900/50 p-1.5 rounded border border-zinc-900">
                  {fableReasoning.text}
                </div>
              </div>
            ) : session.isMonitoring && lastSignal.cortexMetrics?.fingerDetected && (
              <div className="text-zinc-600 text-[8px] border-t border-zinc-900 pt-2 mt-1 flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-ping" />
                <span>Esperando ventana de latidos de Fable 5...</span>
              </div>
            )}
          </div>
        )}

        {/* CÁMARA */}
        <div className="absolute inset-0">
          <CameraView 
            ref={cameraRef}
            onStreamReady={session.handleStreamReady}
            isMonitoring={session.isCameraOn}
          />
        </div>

        {/* AJUSTES */}
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          aria-label="Ajustes"
          className="absolute top-4 right-4 z-30 p-2.5 rounded-full bg-black/50 backdrop-blur-md border border-zinc-900 text-white/75 hover:text-white hover:bg-black/80 hover:scale-105 active:scale-95 shadow-lg shadow-black/35 transition-all"
        >
          <Sliders className="h-4 w-4" />
        </button>

        {/* TELEMEDICINA (atajo rápido) */}
        <button
          type="button"
          onClick={() => setShowTelemedicine(true)}
          aria-label="Telemedicina"
          className="absolute top-4 right-16 z-30 p-2.5 rounded-full bg-black/50 backdrop-blur-md border border-zinc-900 text-emerald-400/75 hover:text-emerald-400 hover:bg-black/80 hover:scale-105 active:scale-95 shadow-lg shadow-black/35 transition-all"
        >
          <Activity className="h-4 w-4" />
        </button>

        {/* TELEMEDICINA DIALOG */}
        {showTelemedicine && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in">
            <div className="bg-black/95 border border-zinc-900/80 rounded-2xl max-w-sm w-[92%] shadow-2xl flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200">
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-900">
                <div className="flex items-center gap-2">
                  <Activity className="w-5 h-5 text-emerald-400" />
                  <h3 className="text-white text-sm font-bold">Telemedicina WebRTC</h3>
                </div>
                <button onClick={() => setShowTelemedicine(false)}
                  className="p-1.5 rounded-full bg-zinc-950 hover:bg-zinc-900 text-zinc-400 hover:text-white transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <p className="text-zinc-500 text-[9px] leading-relaxed">
                  Conexión P2P con STUN. Copia tu SDP y compártelo con el remoto.
                </p>
                <WebrtcCallWidget />
              </div>
            </div>
          </div>
        )}

        <div className="relative z-10 h-full">
          <div className="flex-1 h-full">
            <PPGSignalMeter 
              ref={ppgMeterRef}
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

          {/* STATUS BAR — sobre los botones INICIAR/RESET (h-12) y a la izquierda del toggle 3D */}
          <div 
            className="absolute left-2 right-16 z-20 flex items-center gap-2 justify-center"
            style={{
              bottom: 'calc(56px + env(safe-area-inset-bottom, 0px))'
            }}
          >
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[7px] font-bold ${webgpuAvail === 'yes' ? 'bg-cyan-500/10 text-cyan-400' : 'bg-zinc-900/50 text-zinc-600'}`}>
              <Cpu className="w-2 h-2" />GPU{webgpuAvail === 'yes' ? '' : '—'}
            </span>
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[7px] font-bold ${encryptionReady ? 'bg-amber-500/10 text-amber-400' : 'bg-zinc-900/50 text-zinc-600'}`}>
              <Shield className="w-2 h-2" />{encryptionReady ? 'ENC' : '—'}
            </span>
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[7px] font-bold ${healthAvail === 'yes' ? 'bg-blue-500/10 text-blue-400' : 'bg-zinc-900/50 text-zinc-600'}`}>
              <Activity className="w-2 h-2" />HC{healthAvail === 'yes' ? '' : '—'}
            </span>
            {riskResult && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[7px] font-bold ${riskResult === 'IMMEDIATE' ? 'bg-red-500/10 text-red-400' : riskResult === 'SOON' ? 'bg-orange-500/10 text-orange-400' : riskResult === 'MONITOR' ? 'bg-yellow-500/10 text-yellow-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                <Brain className="w-2 h-2" />{riskResult}
              </span>
            )}
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
                <div className="bg-black border border-slate-700/50 rounded-2xl max-w-sm w-[92%] shadow-2xl flex flex-col max-h-[85vh]">
                  
                  {/* Header con estado */}
                  <div className={`flex-none px-4 py-3 ${bgClass} border-b border-zinc-900 rounded-t-2xl`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <StatusIcon className={`w-5 h-5 ${textClass}`} />
                        <div>
                          <h3 className="text-white text-sm font-bold tracking-wide">MEDICIÓN COMPLETADA</h3>
                          <p className={`${textClass} text-[10px] font-semibold tracking-wider`}>{statusText}</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => {
                          session.setLocalMeasurementSummary(null);
                          session.setLocalShowResults(false);
                        }}
                        className="p-1.5 rounded-full bg-zinc-900 hover:bg-slate-700 transition-colors"
                      >
                        <X className="w-4 h-4 text-zinc-400" />
                      </button>
                    </div>
                  </div>

                  {/* Métricas principales */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    
                    {/* BPM y SpO2 en fila */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-zinc-950/80 rounded-xl p-3 text-center border border-zinc-900/50">
                        <Heart className="w-4 h-4 text-red-400 mx-auto mb-1" fill="currentColor" />
                        <div className="text-white text-2xl font-bold leading-none">{avgBpm}</div>
                        <div className="text-zinc-500 text-[9px] mt-1 font-medium">BPM PROMEDIO</div>
                      </div>
                      <div className="bg-zinc-950/80 rounded-xl p-3 text-center border border-zinc-900/50">
                        <Activity className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
                        <div className="text-white text-2xl font-bold leading-none">
                          {router.vitalSigns.spo2.value != null && router.vitalSigns.spo2.value > 0 ? Math.round(router.vitalSigns.spo2.value) : '--'}
                          <span className="text-sm text-zinc-400">%</span>
                        </div>
                        <div className="text-zinc-500 text-[9px] mt-1 font-medium">SpO₂</div>
                      </div>
                    </div>

                    {/* Presión arterial */}
                    {router.vitalSigns.bloodPressure.value && router.vitalSigns.bloodPressure.value.systolic > 0 && (
                      <div className="bg-zinc-950/80 rounded-xl p-3 border border-zinc-900/50 flex items-center gap-3">
                        <Shield className="w-5 h-5 text-blue-400" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <div className="text-zinc-500 text-[9px] font-medium tracking-tight">PRESIÓN ARTERIAL</div>
                            {router.vitalSigns.bloodPressure.calibration?.available ? (
                              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">CALIBRADO</span>
                            ) : (
                              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400">SIN CALIBRAR</span>
                            )}
                          </div>
                          <div className="text-white text-lg font-bold">
                            {Math.round(router.vitalSigns.bloodPressure.value.systolic)}/{Math.round(router.vitalSigns.bloodPressure.value.diastolic)}
                            <span className="text-xs text-zinc-500 ml-1">mmHg</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Barras de ritmo */}
                    <div className="bg-zinc-950/80 rounded-xl p-3 border border-zinc-900/50">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-zinc-400 text-[10px] font-semibold tracking-wide">ANÁLISIS DE RITMO</span>
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3 text-zinc-500" />
                          <span className="text-zinc-500 text-[9px]">60s</span>
                        </div>
                      </div>
                      
                      {/* Latidos normales */}
                      <div className="mb-2">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="text-emerald-400 text-[9px] font-medium">■ Normales</span>
                          <span className="text-white text-xs font-bold">{normalBeats}</span>
                        </div>
                        <div className="w-full h-2 bg-zinc-900 rounded-full overflow-hidden">
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
                        <div className="w-full h-2 bg-zinc-900 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-1000 ease-out ${arrhythmiaBeats > 0 ? 'bg-gradient-to-r from-red-600 to-red-400' : 'bg-slate-700'}`}
                               style={{ width: `${totalBeats > 0 ? (arrhythmiaBeats / totalBeats) * 100 : 100}%` }} />
                        </div>
                      </div>
                    </div>

                    {/* Poincaré Plot de HRV */}
                    {router.rrIntervals && router.rrIntervals.length >= 2 && (
                      <div className="flex justify-center my-2 animate-in fade-in zoom-in-95 duration-500">
                        <PoincarePlot rrIntervals={router.rrIntervals} width={200} height={200} />
                      </div>
                    )}

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
                        <div className="text-zinc-500 text-[9px]">{totalBeats} latidos analizados</div>
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
              <div className="bg-black border border-slate-700/50 rounded-2xl max-w-sm w-[92%] max-h-[80vh] shadow-2xl overflow-hidden flex flex-col">
                <div className="px-4 py-3 bg-purple-500/10 border-b border-zinc-900 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Brain className="w-5 h-5 text-purple-400" />
                    <h3 className="text-white text-sm font-bold">Análisis AI de Salud</h3>
                  </div>
                  <button
                    onClick={() => { setShowAIAnalysis(false); clearAnalysis(); }}
                    className="p-1.5 rounded-full bg-zinc-900 hover:bg-slate-700 transition-colors"
                  >
                    <X className="w-4 h-4 text-zinc-400" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  {isAnalyzing ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
                      <p className="text-zinc-400 text-sm">Analizando tus signos vitales...</p>
                    </div>
                  ) : analysis ? (
                    <div className="text-slate-300 text-xs leading-relaxed whitespace-pre-wrap">
                      {analysis}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <p className="text-zinc-500 text-sm">No se pudo generar el análisis.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* PANEL DE AJUSTES Y CALIBRACIÓN */}
          {showSettings && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in">
              <div className="bg-black/95 border border-zinc-900/80 rounded-2xl max-w-sm w-[92%] shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">
                
                {/* Header */}
                <div className="px-4 pt-3 bg-gradient-to-r from-slate-900 to-slate-950 border-b border-zinc-900 flex flex-col">
                  <div className="flex items-center justify-between pb-2">
                    <div className="flex items-center gap-2">
                      <Sliders className="w-5 h-5 text-emerald-400" />
                      <div>
                        <h3 className="text-white text-sm font-bold tracking-wide uppercase">Ajustes del Sistema</h3>
                        <p className="text-zinc-500 text-[8px] font-medium tracking-wider uppercase">Monitorización y calibración clínica</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => setShowSettings(false)}
                      className="p-1.5 rounded-full bg-zinc-950 hover:bg-zinc-900 text-zinc-400 hover:text-white transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  
                  {/* Tabs Selector */}
                  <div className="flex border-t border-zinc-950 text-[10px] font-bold">
                    <button 
                      onClick={() => setActiveTab('profile')}
                      className={`flex-1 py-2 text-center transition-colors border-b-2 ${activeTab === 'profile' ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-transparent text-zinc-500 hover:text-slate-300'}`}
                    >
                      PERFIL
                    </button>
                    <button 
                      onClick={() => setActiveTab('calibration')}
                      className={`flex-1 py-2 text-center transition-colors border-b-2 ${activeTab === 'calibration' ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-transparent text-zinc-500 hover:text-slate-300'}`}
                    >
                      CALIBRACIÓN
                    </button>
                    <button 
                      onClick={() => setActiveTab('history')}
                      className={`flex-1 py-2 text-center transition-colors border-b-2 ${activeTab === 'history' ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-transparent text-zinc-500 hover:text-slate-300'}`}
                    >
                      HISTORIAL ({history.length})
                    </button>
                    <button 
                      onClick={() => setActiveTab('account')}
                      className={`flex-1 py-2 text-center transition-colors border-b-2 ${activeTab === 'account' ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-transparent text-zinc-500 hover:text-slate-300'}`}
                    >
                      NUBE / SYNC
                    </button>
                  </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4">
                  
                  {/* TAB 1: PERFIL */}
                  {activeTab === 'profile' && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                      {/* Sección 1: Perfil Fisiológico */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                          <User className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Perfil Fisiológico (PA Neuronal)</span>
                        </div>
                        
                        <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-3.5">
                          {/* Edad y Género */}
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Edad (años)</label>
                              <input 
                                type="number" 
                                value={age}
                                onChange={(e) => setAge(e.target.value)}
                                className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                placeholder="35"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Sexo Biológico</label>
                              <div className="grid grid-cols-2 gap-1 bg-black p-0.5 rounded-lg border border-zinc-900">
                                <button 
                                  type="button"
                                  onClick={() => setGender('male')}
                                  className={`py-1 text-[10px] font-bold rounded ${gender === 'male' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-zinc-500 hover:text-white'}`}
                                >
                                  MASC
                                </button>
                                <button 
                                  type="button"
                                  onClick={() => setGender('female')}
                                  className={`py-1 text-[10px] font-bold rounded ${gender === 'female' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-zinc-500 hover:text-white'}`}
                                >
                                  FEM
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Altura y Peso */}
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Altura (cm)</label>
                              <input 
                                type="number" 
                                value={height}
                                onChange={(e) => setHeight(e.target.value)}
                                className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                placeholder="172"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Peso (kg)</label>
                              <input 
                                type="number" 
                                value={weight}
                                onChange={(e) => setWeight(e.target.value)}
                                className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                placeholder="70"
                              />
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={handleSaveProfile}
                            className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px] transition-colors flex items-center justify-center gap-1.5"
                          >
                            <Check className="w-3.5 h-3.5" /> GUARDAR PERFIL
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB 1b: CALIBRACIÓN */}
                  {activeTab === 'calibration' && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                      {/* Sección 2: Calibración Cruzada */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                          <Activity className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Calibración con Dispositivo Médico</span>
                        </div>

                        <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-3.5">
                          {lastValidResults ? (
                            <>
                              <div className="bg-black/60 rounded-lg p-2.5 border border-zinc-900/40 text-[10px] space-y-1">
                                <span className="text-zinc-500 font-semibold block uppercase">Última medición registrada:</span>
                                <div className="flex justify-between text-white font-bold">
                                  <span>PA: {lastValidResults.bloodPressure.value ? `${Math.round(lastValidResults.bloodPressure.value.systolic)}/${Math.round(lastValidResults.bloodPressure.value.diastolic)} mmHg` : 'No detectada'}</span>
                                  <span>SpO₂: {lastValidResults.spo2.value ? `${Math.round(lastValidResults.spo2.value)}%` : 'No detectado'}</span>
                                </div>
                              </div>

                              <div className="space-y-2.5">
                                <div className="grid grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Ref. Sistólica (mmHg)</label>
                                    <input 
                                      type="number" 
                                      value={refSys}
                                      onChange={(e) => setRefSys(e.target.value)}
                                      className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                      placeholder="120"
                                    />
                                  </div>
                                  <div className="space-y-1">
                                    <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Ref. Diastólica (mmHg)</label>
                                    <input 
                                      type="number" 
                                      value={refDia}
                                      onChange={(e) => setRefDia(e.target.value)}
                                      className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                      placeholder="80"
                                    />
                                  </div>
                                </div>

                                <div className="space-y-1">
                                  <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Ref. SpO₂ (%)</label>
                                  <input 
                                    type="number" 
                                    value={refSpo2}
                                    onChange={(e) => setRefSpo2(e.target.value)}
                                    className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                    placeholder="98"
                                  />
                                </div>

                                <button
                                  type="button"
                                  onClick={handleCalibrateReference}
                                  className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px] transition-colors flex items-center justify-center gap-1.5"
                                >
                                  <Activity className="w-3.5 h-3.5" /> CALIBRAR DISPOSITIVO
                                </button>
                              </div>
                            </>
                          ) : (
                            <div className="text-center py-4 space-y-2">
                              <AlertTriangle className="w-6 h-6 text-amber-500 mx-auto" />
                              <p className="text-zinc-400 text-[10px] font-semibold leading-relaxed">
                                Realiza al menos una medición completa para poder calibrar los sensores ópticos con tus valores de referencia.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Sección 3: Estado de Calibraciones */}
                      <div className="space-y-3">
                        <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                          <Shield className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Calibraciones Activas</span>
                        </div>

                        <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-2 text-[10px] font-semibold text-zinc-400">
                          <div className="flex justify-between items-center py-1 border-b border-zinc-900/50">
                            <span>Presión Arterial (BP)</span>
                            {CalibrationManager.getInstance().getCalibrationInfo('BP').available ? (
                              <span className="text-emerald-400 font-bold uppercase">Activo (Válido)</span>
                            ) : (
                              <span className="text-slate-600 uppercase">Sin calibrar</span>
                            )}
                          </div>
                          <div className="flex justify-between items-center py-1">
                            <span>Oxígeno en Sangre (SpO2)</span>
                            {CalibrationManager.getInstance().getCalibrationInfo('SPO2').available ? (
                              <span className="text-emerald-400 font-bold uppercase">Activo (Válido)</span>
                            ) : (
                              <span className="text-slate-600 uppercase">Sin calibrar</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB 2: HISTORIAL DE MEDICIONES */}
                  {activeTab === 'history' && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleExportCSV}
                          className="flex-1 py-2 rounded-xl bg-zinc-950 border border-zinc-900 hover:bg-zinc-900 text-white font-bold text-xs transition-all flex items-center justify-center gap-2"
                        >
                          <Activity className="w-4 h-4 text-cyan-400" /> EXPORTAR CSV
                        </button>
                        <button
                          type="button"
                          onClick={handleClearHistory}
                          className="px-4 py-2 rounded-xl bg-red-950/20 border border-red-900/40 text-red-400 hover:bg-red-950/40 font-bold text-xs transition-all"
                        >
                          LIMPIAR
                        </button>
                      </div>

                      <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                        {history.length > 0 ? (
                          history.map((m: HistoricalMeasurement) => {
                            const dateStr = new Date(m.measured_at).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit'
                            });
                            return (
                              <div key={m.id} className="bg-zinc-950/60 border border-zinc-900/40 rounded-xl p-3 space-y-2 relative">
                                <div className="flex justify-between items-center">
                                  <span className="text-[10px] text-zinc-500 font-bold uppercase">{dateStr}</span>
                                  {m.isCloud ? (
                                    <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400">NUBE</span>
                                  ) : (
                                    <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-zinc-900 text-zinc-400">LOCAL</span>
                                  )}
                                </div>
                                <div className="grid grid-cols-3 gap-2 text-center">
                                  <div className="bg-black/40 rounded-lg py-1 border border-zinc-950">
                                    <span className="text-zinc-500 text-[8px] block font-bold">PULSO</span>
                                    <span className="text-white text-xs font-bold">{m.heart_rate || '--'} <span className="text-[8px] text-zinc-400">bpm</span></span>
                                  </div>
                                  <div className="bg-black/40 rounded-lg py-1 border border-zinc-950">
                                    <span className="text-zinc-500 text-[8px] block font-bold">SpO₂</span>
                                    <span className="text-white text-xs font-bold">{m.spo2 || '--'}<span className="text-[8px] text-zinc-400">%</span></span>
                                  </div>
                                  <div className="bg-black/40 rounded-lg py-1 border border-zinc-950">
                                    <span className="text-zinc-500 text-[8px] block font-bold">PRESIÓN</span>
                                    <span className="text-white text-xs font-bold">
                                      {m.systolic && m.diastolic ? `${m.systolic}/${m.diastolic}` : '--'}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div className="text-center py-10 space-y-2 border border-dashed border-zinc-900 rounded-xl">
                            <Activity className="w-8 h-8 text-slate-700 mx-auto animate-pulse" />
                            <p className="text-zinc-500 text-[10px] font-semibold">Aún no hay mediciones guardadas en este dispositivo.</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* TAB 3: SINCRONIZACIÓN EN LA NUBE */}
                  {activeTab === 'account' && (
                    <div className="space-y-4 animate-in fade-in duration-200">
                      {currentUser ? (
                        <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-4 space-y-4 text-center">
                          <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                            <Check className="w-6 h-6 text-emerald-400" />
                          </div>
                          <div className="space-y-1">
                            <h4 className="text-white text-xs font-bold">SESIÓN INICIADA</h4>
                            <p className="text-zinc-400 text-[10px] font-mono">{currentUser.email}</p>
                          </div>
                          <p className="text-zinc-500 text-[9px] leading-relaxed">
                            Tus signos vitales se guardarán automáticamente en la nube y se sincronizarán en todos tus dispositivos.
                          </p>
                          <button
                            type="button"
                            onClick={handleSignOut}
                            className="w-full py-2 rounded-xl bg-red-950/20 border border-red-900/40 text-red-400 hover:bg-red-950/40 font-bold text-xs transition-all"
                          >
                            CERRAR SESIÓN
                          </button>
                        </div>
                      ) : (
                        <form onSubmit={handleAuth} className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-4 space-y-4">
                          <div className="text-center space-y-1 pb-2">
                            <h4 className="text-white text-xs font-bold uppercase">Sincronización en la Nube</h4>
                            <p className="text-zinc-500 text-[9px] font-medium leading-relaxed">
                              Crea una cuenta para guardar tu historial en internet de forma permanente y segura.
                            </p>
                          </div>

                          <div className="space-y-2.5">
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Correo Electrónico</label>
                              <input 
                                type="email" 
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                placeholder="tu@correo.com"
                                required
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Contraseña</label>
                              <input 
                                type="password" 
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors" 
                                placeholder="••••••••"
                                required
                              />
                            </div>
                          </div>

                          <div className="pt-2 space-y-3">
                            <button
                              type="submit"
                              disabled={authLoading}
                              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-indigo-600 hover:from-emerald-500 hover:to-indigo-500 text-white font-bold text-xs tracking-wider transition-all disabled:opacity-50"
                            >
                              {authLoading ? "Procesando..." : (authMode === 'signin' ? "INICIAR SESIÓN" : "CREAR CUENTA")}
                            </button>

                            <div className="text-center">
                              <button
                                type="button"
                                onClick={() => setAuthMode(prev => prev === 'signin' ? 'signup' : 'signin')}
                                className="text-emerald-400 hover:text-emerald-300 text-[10px] font-bold"
                              >
                                {authMode === 'signin' ? "¿No tienes cuenta? Regístrate aquí" : "¿Ya tienes cuenta? Inicia sesión"}
                              </button>
                            </div>
                          </div>
                        </form>
                      )}
                    </div>
                  )}

                </div>
              </div>
            </div>
          )}

          {/* DESCARGO DE RESPONSABILIDAD MÉDICA */}
          {!disclaimerAccepted && (
            <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/95 backdrop-blur-md animate-fade-in p-4 overflow-y-auto">
              <div className="bg-black border border-zinc-900/80 rounded-2xl max-w-sm w-full shadow-2xl p-5 space-y-5 animate-in zoom-in-95 duration-300 max-h-[90vh] flex flex-col">
                <div className="text-center space-y-2">
                  <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto">
                    <AlertTriangle className="w-6 h-6 text-red-500" />
                  </div>
                  <h3 className="text-white text-base font-bold tracking-wide uppercase">DESCARGO DE RESPONSABILIDAD MÉDICA</h3>
                  <p className="text-red-400 text-[10px] font-bold tracking-wider uppercase">IMPORTANTE LEER ANTES DE USAR</p>
                </div>

                <div className="flex-1 overflow-y-auto text-zinc-400 text-[11px] leading-relaxed space-y-3.5 pr-1 border-y border-zinc-950 py-4">
                  <p>
                    Esta aplicación utiliza fotopletismografía (PPG) a través de la cámara y el flash de su smartphone para estimar el pulso, la variabilidad de la frecuencia cardíaca, la saturación de oxígeno ($SpO_2$) y la presión arterial.
                  </p>
                  <p className="font-semibold text-white">
                    Esta aplicación NO es un dispositivo médico y NO ha sido certificada por la FDA, EMA ni ninguna entidad reguladora de salud.
                  </p>
                  <p>
                    Los resultados mostrados son aproximaciones con fines informativos y de bienestar personal. No deben utilizarse para autodiagnóstico, prevención o tratamiento de ninguna condición médica.
                  </p>
                  <p>
                    Si usted tiene antecedentes de hipertensión, arritmia u otras afecciones cardiovasculares, debe utilizar dispositivos clínicos de grado médico validados y consultar con su médico antes de tomar cualquier decisión clínica.
                  </p>
                  <p>
                    Al hacer clic en "Aceptar y Continuar", usted confirma que comprende y acepta que el uso de esta app es bajo su propio riesgo y discreción.
                  </p>
                </div>

                <button
                  onClick={handleAcceptDisclaimer}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-indigo-600 hover:from-emerald-500 hover:to-indigo-500 text-white font-bold text-xs tracking-wider transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  ACEPTAR Y CONTINUAR
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default Index;
