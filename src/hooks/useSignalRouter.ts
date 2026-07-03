import { useState, useRef, useCallback, useEffect } from 'react';
import type { ProcessedSignal, ContactState, FingerPlacementMode } from '@/types/signal';
import type { VitalSignsResult, RGBData } from '@/modules/vital-signs/VitalSignsProcessor';
import type { SignalQualityMetrics } from '@/types/measurements';
import type { CameraRuntimeHints } from '@/lib/device/cameraDeviceProfile';

import { SignalQualityIndex } from '@/modules/signal-quality/SignalQualityIndex';
import {
  createMeasurementSessionLatch,
  SESSION_LATCH,
  updateMeasurementSessionLatch,
} from '@/lib/measurement/measurementSessionLatch';
import { evaluateMeasurementReadiness } from '@/lib/measurement/measurementReadiness';
import { bpmFromEmittedRr } from '@/lib/measurement/peakEmitPolicy';
import {
  createStabilizationState,
  updateStabilization,
} from '@/lib/measurement/signalStabilization';
import { instantAcquisitionConfidence } from '@/lib/acquisition/AcquisitionStabilizer';
import { FrameReservoir } from '@/lib/acquisition/FrameReservoir';
import {
  DISPLAY_SMOOTH_ALPHAS,
  smoothDisplayPair,
  smoothDisplayValue,
} from '@/lib/measurement/displaySmoothing';
import { createDefaultVitalSignsResult } from '@/lib/vitals/defaultVitalSignsResult';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { VitalsSanityChecker } from '@/lib/sanity/vitalsSanity';
import {
  getActiveProfileId,
  getCustomOverrides,
  resolveProfile,
} from '@/lib/sanity/sanityProfiles';
import { recordVerdict as recordAuditVerdict } from '@/lib/sanity/sanityAuditLog';
import { toast } from '@/hooks/use-toast';
import { triggerArrhythmiaHaptic } from '@/utils/haptics';

interface HeartBeatProcessorAPI {
  processSignal: (
    value: number,
    contactState: ContactState,
    timestamp?: number,
    fingerConfirmed?: boolean,
    ppgQuality?: { sqi: number; perfusionIndex?: number; motionScore?: number },
  ) => {
    bpm: number;
    confidence: number;
    isPeak: boolean;
    filteredValue: number;
    signalQuality: number;
    internalSqi?: number;
    externalSqi?: number;
    ensembleDiagnostics?: Record<string, unknown>;
    rrData?: { intervals: number[]; lastPeakTime: number | null; timestampNow?: number };
  };
  setFingerPlacementMode: (mode: FingerPlacementMode) => void;
  setRuntimeHints: (hints: CameraRuntimeHints) => void;
  reacquirePeaks: (timestamp?: number) => void;
  reset: () => void;
}

interface VitalSignsProcessorAPI {
  processSignal: (
    value: number,
    quality: number,
    bpm: number,
    rrData?: { intervals: number[]; lastPeakTime: number | null; timestampNow?: number },
    perfusionIndexFromPpg?: number,
    sqmBundle?: Partial<SignalQualityMetrics>,
    morphologyValue?: number,
    splitterChannels?: {
      morphologyFiltered?: number;
      respirationFiltered?: number;
      arrhythmiaFiltered?: number;
      spo2Channels?: {
        acRed: number;
        dcRed: number;
        acGreen: number;
        dcGreen: number;
        acBlue?: number;
        dcBlue?: number;
      };
    },
    faceBvp?: number,
    faceBpm?: number,
    faceQuality?: number,
    accelRespiration?: { rpm: number; quality: number },
  ) => VitalSignsResult;
  setPlacementMode: (mode: FingerPlacementMode) => void;
  setRGBData: (data: RGBData) => void;
  getRGBStats: () => { redAC: number; redDC: number; greenAC: number; greenDC: number; blueAC?: number; blueDC?: number; rgRatio: number; ratioOfRatios: number };
}

interface UseSignalRouterInput {
  processHeartBeat: HeartBeatProcessorAPI;
  processVitalSigns: VitalSignsProcessorAPI;
  cameraHintsRef: React.MutableRefObject<CameraRuntimeHints>;
  ppgMeterRef?: React.RefObject<import('@/components/PPGSignalMeter').PPGSignalMeterHandle | null>;
}

// Frame-gates de contacto y throttles/cadencia DSP — fuente única en VITAL_THRESHOLDS.
// A scope de módulo: react-hooks los reconoce como constantes estables (no deps).
const {
  UNSTABLE_ZERO_THRESHOLD_FRAMES: UNSTABLE_ZERO_THRESHOLD,
  SESSION_RESET_FRAMES: NO_CONTACT_SESSION_RESET_FRAMES,
  REGAIN_RESET_MIN_FRAMES: CONTACT_REGAIN_RESET_MIN_FRAMES,
  STALE_PEAK_REACQUIRE_FRAMES,
} = VITAL_THRESHOLDS.CONTACT;
const {
  HR_PUSH_THROTTLE_MS,
  VITALS_PUSH_THROTTLE_MS,
  RR_PUSH_THROTTLE_MS,
  DIAG_PUSH_THROTTLE_MS,
  VITALS_PROCESS_EVERY_N_FRAMES,
} = VITAL_THRESHOLDS.ROUTER;

export function useSignalRouter({ processHeartBeat, processVitalSigns, cameraHintsRef, ppgMeterRef }: UseSignalRouterInput) {
  // Estados de salida
  const [vitalSigns, setVitalSigns] = useState<VitalSignsResult>(createDefaultVitalSignsResult);
  const [heartbeatSignal, setHeartbeatSignal] = useState(0);
  const [beatMarker, setBeatMarker] = useState(0);
  const [rrIntervals, setRRIntervals] = useState<number[]>([]);
  const [currentDiagnostics, setCurrentDiagnostics] = useState<Record<string, unknown> | null>(null);

  // Refs de sesión compartidos
  const vitalSignsRef = useRef<VitalSignsResult>(vitalSigns);
  const totalBeatsRef = useRef(0);
  const arrhythmiaBeatsRef = useRef(0);
  const lastArrhythmiaCountForBeatsRef = useRef(0);
  const arrhythmiaDetectedRef = useRef(false);
  const lastArrhythmiaData = useRef<{ timestamp: number; rmssd: number; rrVariation: number } | null>(null);

  const motionArtifactFramesRef = useRef(0);
  const saturationFramesRef = useRef(0);
  const underexposedFramesRef = useRef(0);
  const artifactCheckFramesRef = useRef(0);

  // Signal routing internals
  const vitalSignsFrameCounter = useRef<number>(0);
  const unstableFrameCounter = useRef<number>(0);
  const measurementLatchRef = useRef(createMeasurementSessionLatch());
  const lastRrSnapshotRef = useRef<{ intervals: number[]; lastPeakTime: number | null } | null>(null);
  const lastGoodBpmRef = useRef(0);
  const lastBpmSeenAtRef = useRef(0);
  const prevHasUsableContactRef = useRef(false);
  const noContactSessionFramesRef = useRef(0);
  const lastHbInputRef = useRef(0);
  const displayHrRef = useRef(0);
  const displaySpo2Ref = useRef(0);
  const displayBpRef = useRef({ systolic: 0, diastolic: 0 });
  // Latch de estabilización de adquisición: hasta que la señal estabiliza
  // (acquisitionStage READY) no se publica el número de HR (evita BPM errático
  // mientras la cámara/AE y el contacto se asientan). Una vez estabilizado, se
  // mantiene durante toda la sesión de contacto.
  const acqReadyLatchRef = useRef(false);
  const stabilizationRef = useRef(createStabilizationState());
  // Buffer elástico de "buenos frames" para colocación robusta: desacopla el
  // ritmo de captura del de consumo y aporta una COBERTURA suavizada por
  // ventana (goodCoverage) tolerante a microdescuadres. Solo alimenta la UX de
  // colocación (diagnostics.placementCoverage/placementStable): NO toca la onda
  // del pulso ni las compuertas de contacto/detección.
  const placementReservoirRef = useRef(new FrameReservoir<number>());

  // Throttle timers
  const lastHrPushRef = useRef(0);
  const lastVitalsPushRef = useRef(0);
  const lastSignalPushRef = useRef(0);
  const lastRrPushRef = useRef(0);
  const lastDiagPushRef = useRef(0);
  const beatMarkerTimerRef = useRef<number | null>(null);
  const lastPeakTimestampRef = useRef<number>(0);
  const lastPeakAmplitudeRef = useRef<number>(1.0);
  const runningPeakAverageRef = useRef<number>(0);

  // Sanity checker
  const [sanityProfileId, setSanityProfileId] = useState<string>(() => getActiveProfileId());
  const [customJSON, setCustomJSON] = useState<string>(() => {
    const o = getCustomOverrides();
    return Object.keys(o).length ? JSON.stringify(o, null, 2) : "";
  });
  const bpmSanityRef = useRef<VitalsSanityChecker>(
    new VitalsSanityChecker({
      ...resolveProfile(getActiveProfileId()).effective,
      onVerdict: (sample, verdict, win) => {
        recordAuditVerdict(sample, verdict, win);
      },
    })
  );
  // Dedup de error de sanity: el ref es la única fuente de verdad (no hay UI que
  // renderice el mensaje; el aviso al usuario va por toast más abajo).
  const sanityErrorRef = useRef<string | null>(null);
  const sanityToastAtRef = useRef<number>(0);
  const isMonitoringRef = useRef(false);

  useEffect(() => {
    vitalSignsRef.current = vitalSigns;
  }, [vitalSigns]);

  // Cleanup: cancela cualquier timer pendiente al desmontar para evitar
  // setBeatMarker sobre un componente desmontado.
  useEffect(() => {
    return () => {
      if (beatMarkerTimerRef.current) {
        window.clearTimeout(beatMarkerTimerRef.current);
        beatMarkerTimerRef.current = null;
      }
    };
  }, []);

  const applyLiveDisplaySmooth = useCallback((vitals: VitalSignsResult): VitalSignsResult => {
    const hr = vitals.heartRate.value ?? 0;
    const spo2 = typeof vitals.spo2.value === "number" ? vitals.spo2.value : 0;
    const sys = vitals.bloodPressure.value?.systolic ?? 0;
    const dia = vitals.bloodPressure.value?.diastolic ?? 0;

    displayHrRef.current = Math.round(
      smoothDisplayValue(displayHrRef.current, hr, DISPLAY_SMOOTH_ALPHAS.hr),
    );
    displaySpo2Ref.current = Math.round(
      smoothDisplayValue(displaySpo2Ref.current, spo2, DISPLAY_SMOOTH_ALPHAS.spo2),
    );
    displayBpRef.current = smoothDisplayPair(
      displayBpRef.current,
      { systolic: sys, diastolic: dia },
      DISPLAY_SMOOTH_ALPHAS.bp,
    );

    return {
      ...vitals,
      heartRate: { ...vitals.heartRate, value: displayHrRef.current },
      spo2: { ...vitals.spo2, value: displaySpo2Ref.current },
      bloodPressure: {
        ...vitals.bloodPressure,
        value: displayBpRef.current,
      },
    };
  }, []);

  const resetFingerContactSession = useCallback(() => {
    processHeartBeat.reset();
    measurementLatchRef.current = createMeasurementSessionLatch();
    lastGoodBpmRef.current = 0;
    lastBpmSeenAtRef.current = 0;
    lastRrSnapshotRef.current = null;
    unstableFrameCounter.current = 0;
    acqReadyLatchRef.current = false;
    stabilizationRef.current = createStabilizationState();
    placementReservoirRef.current.reset();
    setRRIntervals([]);
    setBeatMarker(0);
    if (beatMarkerTimerRef.current) {
      window.clearTimeout(beatMarkerTimerRef.current);
      beatMarkerTimerRef.current = null;
    }
    bpmSanityRef.current.reset();
    sanityErrorRef.current = null;
    displayHrRef.current = 0;
    displaySpo2Ref.current = 0;
    displayBpRef.current = { systolic: 0, diastolic: 0 };
    lastHbInputRef.current = 0;
    lastHrPushRef.current = 0;
    lastVitalsPushRef.current = 0;
    lastRrPushRef.current = 0;
    lastSignalPushRef.current = 0;
    lastDiagPushRef.current = 0;
    lastPeakTimestampRef.current = 0;
    lastPeakAmplitudeRef.current = 1.0;
    runningPeakAverageRef.current = 0;
    ppgMeterRef?.current?.clearBuffer();

  }, [processHeartBeat, ppgMeterRef]);


  const resetSessionRefs = useCallback(() => {
    totalBeatsRef.current = 0;
    arrhythmiaBeatsRef.current = 0;
    lastArrhythmiaCountForBeatsRef.current = 0;
    unstableFrameCounter.current = 0;
    measurementLatchRef.current = createMeasurementSessionLatch();
    lastGoodBpmRef.current = 0;
    lastBpmSeenAtRef.current = 0;
    prevHasUsableContactRef.current = false;
    noContactSessionFramesRef.current = 0;
    lastRrSnapshotRef.current = null;
    motionArtifactFramesRef.current = 0;
    saturationFramesRef.current = 0;
    underexposedFramesRef.current = 0;
    artifactCheckFramesRef.current = 0;
    bpmSanityRef.current.reset();
    sanityErrorRef.current = null;
    lastArrhythmiaData.current = null;
    arrhythmiaDetectedRef.current = false;
    lastPeakTimestampRef.current = 0;
    lastPeakAmplitudeRef.current = 1.0;
    runningPeakAverageRef.current = 0;
    ppgMeterRef?.current?.clearBuffer();

  }, [ppgMeterRef]);

  const handleSignalRealtime = useCallback((lastSignal: ProcessedSignal) => {
    if (!isMonitoringRef.current) return;
    const signalValue = lastSignal.filteredValue;
    const contactState: ContactState =
      lastSignal.contactState ??
      (lastSignal.fingerDetected ? "UNSTABLE_CONTACT" : "NO_CONTACT");
    const diag = lastSignal.diagnostics;
    const placementMode =
      lastSignal.placementMode ??
      (diag && typeof diag === 'object' && typeof diag.placementMode === 'string'
        ? (diag.placementMode as FingerPlacementMode)
        : 'hybrid');
    processHeartBeat.setFingerPlacementMode(placementMode);
    processVitalSigns.setPlacementMode(placementMode);
    const fingerConfirmed = !!lastSignal.fingerDetected;
    const nowT = performance.now();
    const hasUsableContact =
      fingerConfirmed && contactState !== 'NO_CONTACT';

    if (
      hasUsableContact &&
      !prevHasUsableContactRef.current &&
      noContactSessionFramesRef.current >= CONTACT_REGAIN_RESET_MIN_FRAMES
    ) {
      resetFingerContactSession();
    }
    prevHasUsableContactRef.current = hasUsableContact;

    if (!hasUsableContact) {
      noContactSessionFramesRef.current += 1;
      if (noContactSessionFramesRef.current === NO_CONTACT_SESSION_RESET_FRAMES) {
        resetFingerContactSession();
      }
    } else {
      noContactSessionFramesRef.current = 0;
    }

    artifactCheckFramesRef.current += 1;
    if (lastSignal.motionArtifact) {
      motionArtifactFramesRef.current += 1;
    }
    const sqm = diag && typeof diag === 'object' && diag.sqm && typeof diag.sqm === 'object'
      ? diag.sqm as Record<string, unknown>
      : {};
    if (typeof sqm.saturationRatio === 'number' && sqm.saturationRatio > VITAL_THRESHOLDS.ROUTER.SATURATION_FRAME_RATIO) {
      saturationFramesRef.current += 1;
    }
    if (typeof sqm.underexposureRatio === 'number' && sqm.underexposureRatio > VITAL_THRESHOLDS.ROUTER.UNDEREXPOSURE_FRAME_RATIO) {
      underexposedFramesRef.current += 1;
    }

    const hints = cameraHintsRef.current;
    const Q = VITAL_THRESHOLDS.QUALITY;
    const minConf =
      (contactState === 'STABLE_CONTACT'
        ? Q.MIN_ENSEMBLE_CONF_STABLE
        : Q.MIN_ENSEMBLE_CONF_UNSTABLE) * hints.ensembleConfScale;
    const rawSqi =
      (diag && typeof diag === 'object' && diag.sqm && typeof diag.sqm.sqi === 'number'
        ? diag.sqm.sqi
        : lastSignal.quality) || 0;

    let hbInput = 0;
    if (fingerConfirmed) {
      if (Math.abs(signalValue) > 1e-7) {
        lastHbInputRef.current = signalValue;
        hbInput = signalValue;
      } else if (Math.abs(lastHbInputRef.current) > 1e-7) {
        hbInput = lastHbInputRef.current;
      }
    } else {
      lastHbInputRef.current = 0;
    }

    const heartBeatResult = processHeartBeat.processSignal(
      hbInput,
      contactState,
      nowT,
      fingerConfirmed,
      {
        sqi: rawSqi,
        perfusionIndex: lastSignal.perfusionIndex ?? 0,
        motionScore: typeof sqm.motionScore === 'number' ? sqm.motionScore : 0,
      },
    );

    const mergedDiag =
      diag && typeof diag === 'object'
        ? { ...diag, peakDetection: heartBeatResult.ensembleDiagnostics }
        : { peakDetection: heartBeatResult.ensembleDiagnostics };
    // El push del diag se hace MÁS ABAJO, tras sobreescribir el stage/progress de
    // estabilización con el criterio REAL por convergencia (necesita bpmLive).

    const bpmForLatch =
      heartBeatResult.bpm > 0
        ? heartBeatResult.bpm
        : hasUsableContact
          ? lastGoodBpmRef.current
          : 0;
    if (bpmForLatch > 0 && hasUsableContact) lastGoodBpmRef.current = bpmForLatch;

    measurementLatchRef.current = updateMeasurementSessionLatch(
      measurementLatchRef.current,
      hasUsableContact,
      bpmForLatch,
      rawSqi,
      nowT,
      heartBeatResult.isPeak,
    );
    const latchPeakMs = measurementLatchRef.current.lastPeakMs;
    const peakRecent =
      fingerConfirmed &&
      latchPeakMs > 0 &&
      nowT - latchPeakMs < SESSION_LATCH.MAX_PEAK_GAP_MS;

    const rrForBpm = heartBeatResult.rrData?.intervals ?? [];
    const bpmFromRr =
      rrForBpm.length >= 1 ? Math.round(bpmFromEmittedRr(rrForBpm)) : 0;
    const bpmProcessor =
      heartBeatResult.bpm >= VITAL_THRESHOLDS.HR.MIN &&
      heartBeatResult.bpm <= VITAL_THRESHOLDS.HR.MAX
        ? heartBeatResult.bpm
        : 0;
    const bpmLive =
      fingerConfirmed && (bpmProcessor > 0 || bpmFromRr > 0)
        ? bpmProcessor > 0
          ? bpmProcessor
          : bpmFromRr
        : 0;

    if (bpmLive > 0) {
      lastGoodBpmRef.current = bpmLive;
      lastBpmSeenAtRef.current = nowT;
    }

    const bpmOut =
      hasUsableContact && fingerConfirmed && bpmLive > 0 ? bpmLive : 0;

    // ESTABILIZACIÓN POR CONVERGENCIA (criterio REAL, reemplaza el warm-up fijo).
    // La señal está estable cuando la LECTURA DE HR convergió (dejó de moverse) y
    // la calidad se sostiene — el tiempo lo dicta la señal, no un reloj. Robusto a
    // arritmia: usa el BPM suavizado (la frecuencia media se asienta). Solo aquí se
    // revela la onda y el número.
    const stab = updateStabilization(stabilizationRef.current, {
      hasContact: hasUsableContact,
      bpm: bpmLive,
      sqi: rawSqi,
      perfusionIndex: lastSignal.perfusionIndex ?? 0,
      periodicity: typeof sqm.periodicity === 'number' ? sqm.periodicity : 0,
      motionScore: typeof sqm.motionScore === 'number' ? sqm.motionScore : 0,
      nowMs: nowT,
    });
    if (stab.stabilized) acqReadyLatchRef.current = true;
    const acqStabilized = acqReadyLatchRef.current;
    const bpmDisplay = acqStabilized ? bpmOut : 0;

    // Sobreescribe el stage/progress del diag con el criterio REAL de convergencia
    // (la UI revela la onda con ESTO, no con el warm-up por tiempo del procesador).
    const md = mergedDiag as Record<string, unknown>;
    md.acquisitionStage = hasUsableContact ? stab.stage : 'SEARCHING';
    md.acquisitionProgress = stab.progress;
    md.stabilizationReason = stab.reason;

    // Buffer elástico de colocación: calidad de contacto por frame (primitiva ya
    // probada) → reservorio → cobertura suavizada tolerante a microdescuadres.
    const contactQuality = hasUsableContact
      ? instantAcquisitionConfidence({
          fingerDetected: fingerConfirmed,
          contactState,
          perfusionIndex: lastSignal.perfusionIndex ?? 0,
          periodicity: typeof sqm.periodicity === 'number' ? sqm.periodicity : 0,
          sqi: rawSqi,
          motionScore: typeof sqm.motionScore === 'number' ? sqm.motionScore : 0,
          coverageRatio:
            diag && typeof diag === 'object' && typeof diag.coverageRatio === 'number'
              ? diag.coverageRatio
              : 0,
        })
      : 0;
    const reservoir = placementReservoirRef.current;
    reservoir.push(signalValue, contactQuality, nowT);
    const reservoirOut = reservoir.consume();
    const placementCoverage = reservoirOut ? reservoirOut.goodCoverage : 0;
    md.placementCoverage = placementCoverage;
    md.placementStable =
      placementCoverage >= VITAL_THRESHOLDS.ROUTER.PLACEMENT_STABLE_COVERAGE;
    if (nowT - lastDiagPushRef.current >= DIAG_PUSH_THROTTLE_MS) {
      lastDiagPushRef.current = nowT;
      setCurrentDiagnostics(mergedDiag);
    }

    const piMin = Q.MIN_PI * Math.max(
      VITAL_THRESHOLDS.ROUTER.PI_MIN_READINESS_FLOOR,
      hints.minPiScale * VITAL_THRESHOLDS.ROUTER.PI_MIN_READINESS_SCALE,
    );
    const readiness = evaluateMeasurementReadiness({
      hasUsableContact,
      contactState,
      rawSqi,
      perfusionIndex: lastSignal.perfusionIndex ?? 0,
      piMin,
      bpm: bpmOut,
      peakRecent,
      ensembleConfidence: heartBeatResult.confidence,
      minEnsembleConf: minConf,
      latch: measurementLatchRef.current,
      nowMs: nowT,
    });
    const { vitalsDspReady, fullVitalsReady, hrDisplayReady: hrReady } = readiness;

    if (hasUsableContact && heartBeatResult.isPeak) {
      lastPeakTimestampRef.current = nowT;
      // Measure raw peak amplitude of unnormalized filtered signal (hbInput)
      const currentPeakAmp = Math.abs(hbInput);
      if (runningPeakAverageRef.current === 0) {
        runningPeakAverageRef.current = currentPeakAmp;
      } else {
        // Slow Exponential Moving Average to track general baseline scale of this device/placement
        runningPeakAverageRef.current = runningPeakAverageRef.current * 0.85 + currentPeakAmp * 0.15;
      }
      // Relative scale of this heartbeat compared to recent average
      let ampScale = 1.0;
      if (runningPeakAverageRef.current > 1e-5) {
        ampScale = currentPeakAmp / runningPeakAverageRef.current;
      }
      // Clamp to visually appealing range (e.g. 0.5 to 1.6) to guarantee no excessive clipping
      lastPeakAmplitudeRef.current = Math.max(0.5, Math.min(1.6, ampScale));
    }

    if (!hasUsableContact) {
      lastPeakTimestampRef.current = 0;
      lastPeakAmplitudeRef.current = 1.0;
      runningPeakAverageRef.current = 0;
    }

    let eegValue = 0;
    if (hasUsableContact && lastPeakTimestampRef.current > 0) {
      const elapsed = nowT - lastPeakTimestampRef.current;
      const ampScale = lastPeakAmplitudeRef.current;
      
      const maxPeak = 10.0 * ampScale;
      const minPeak = -4.0 * ampScale;
      const peakRange = maxPeak - minPeak; // 14.0 * ampScale

      // EEG-style heartbeat spike:
      // 0ms: reached maximum peak (+10.0 * scale) at the exact moment of peak detection
      // 0ms - 60ms: instant descent from maxPeak to minPeak (below baseline)
      // 60ms - 170ms: return from minPeak to 0.0
      // > 170ms: rest at 0.0
      if (elapsed >= 0 && elapsed < 60) {
        const t = elapsed / 60;
        eegValue = maxPeak - t * peakRange;
      } else if (elapsed >= 60 && elapsed < 170) {
        const t = (elapsed - 60) / 110;
        eegValue = minPeak + t * Math.abs(minPeak);
      } else {
        eegValue = 0.0;
      }
    }

    const showWaveform = hasUsableContact;

    if (ppgMeterRef?.current) {
      ppgMeterRef.current.pushSignal(showWaveform ? eegValue : 0, Date.now());
    }

    if (hasUsableContact && nowT - lastHrPushRef.current >= HR_PUSH_THROTTLE_MS) {
      lastHrPushRef.current = nowT;
      const sqRounded = Math.round(rawSqi);
      const hrStatus: import('@/types/measurements').MeasurementStatus =
        acqStabilized && contactState === 'STABLE_CONTACT' && bpmLive > 0 && hrReady
          ? 'VALID'
          : bpmDisplay > 0
            ? 'WARMUP'
            : 'NO_VALID_SIGNAL';
      setVitalSigns(prev => {
        const next = {
          ...prev,
          heartRate: { ...prev.heartRate, value: bpmDisplay, status: hrStatus },
          signalQuality: sqRounded,
        };
        vitalSignsRef.current = next;
        return applyLiveDisplaySmooth(next);
      });
    }

    // Limpieza INMEDIATA del BPM ante NO_CONTACT inequívoco: evita el "BPM sin
    // dedo" fantasma que persistía mientras el contador de inestabilidad llegaba
    // a su umbral (~2 s) tras retirar el dedo. Solo dispara con NO_CONTACT (no con
    // UNSTABLE), así no afecta la tolerancia a artefactos breves con el dedo puesto.
    // Resetea también el ref del EMA para que el valor caiga a 0 sin decaer.
    if (
      !hasUsableContact &&
      contactState === 'NO_CONTACT' &&
      nowT - lastHrPushRef.current >= HR_PUSH_THROTTLE_MS &&
      vitalSignsRef.current.heartRate.value !== 0
    ) {
      lastHrPushRef.current = nowT;
      displayHrRef.current = 0;
      setVitalSigns(prev => {
        const next = {
          ...prev,
          heartRate: { ...prev.heartRate, value: 0, status: 'NO_VALID_SIGNAL' as const },
        };
        vitalSignsRef.current = next;
        return next;
      });
    }

    if (hrReady && bpmOut > 0) {
      unstableFrameCounter.current = 0;
      if (bpmLive > 0) {
        const verdict = bpmSanityRef.current.push(bpmLive);
        if (verdict.ok === false) {
          const msg = `BPM stream ${verdict.reason} (${verdict.detail})`;
          if (sanityErrorRef.current !== verdict.reason) {
            sanityErrorRef.current = verdict.reason;
            const now = performance.now();
            if (now - sanityToastAtRef.current > VITAL_THRESHOLDS.ROUTER.SANITY_TOAST_COOLDOWN_MS) {
              sanityToastAtRef.current = now;
              toast({
                variant: "destructive",
                title: "⚠ Señal sospechosa detectada",
                description: msg,
              });
            }
          }
        } else if (sanityErrorRef.current) {
          sanityErrorRef.current = null;
        }
      }
    } else {
      if (!hasUsableContact) {
        unstableFrameCounter.current++;
      } else if (bpmOut <= 0) {
        unstableFrameCounter.current = Math.min(
          unstableFrameCounter.current + 1,
          UNSTABLE_ZERO_THRESHOLD,
        );
        if (
          hasUsableContact &&
          unstableFrameCounter.current === STALE_PEAK_REACQUIRE_FRAMES
        ) {
          processHeartBeat.reacquirePeaks(nowT);
        }
        const STALE_FINGER_NO_BPM = VITAL_THRESHOLDS.CONTACT.STALE_NO_BPM_FRAMES;
        if (
          hasUsableContact &&
          unstableFrameCounter.current === STALE_FINGER_NO_BPM
        ) {
          processHeartBeat.reacquirePeaks(nowT);
          setVitalSigns(prev => ({
            ...prev,
            spo2: { ...prev.spo2, value: 0, status: 'NO_VALID_SIGNAL' },
            bloodPressure: {
              ...prev.bloodPressure,
              value: { systolic: 0, diastolic: 0 },
              status: 'NO_VALID_SIGNAL',
            },
          }));
          vitalSignsRef.current = {
            ...vitalSignsRef.current,
            spo2: { ...vitalSignsRef.current.spo2, value: 0, status: 'NO_VALID_SIGNAL' },
            bloodPressure: {
              ...vitalSignsRef.current.bloodPressure,
              value: { systolic: 0, diastolic: 0 },
              status: 'NO_VALID_SIGNAL',
            },
          };
        }
      } else {
        unstableFrameCounter.current = Math.max(0, unstableFrameCounter.current - 2);
      }
      if (unstableFrameCounter.current >= UNSTABLE_ZERO_THRESHOLD && !hasUsableContact) {
        vitalSignsFrameCounter.current = 0;
        setBeatMarker(0);
        setRRIntervals([]);
        arrhythmiaDetectedRef.current = false;
        measurementLatchRef.current = createMeasurementSessionLatch();
        lastGoodBpmRef.current = 0;
        lastRrSnapshotRef.current = null;
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
    }

    if (
      hasUsableContact &&
      heartBeatResult.rrData &&
      heartBeatResult.rrData.intervals.length >= 2
    ) {
      lastRrSnapshotRef.current = heartBeatResult.rrData;
    } else if (!hasUsableContact) {
      lastRrSnapshotRef.current = null;
    }

    const emittedPeak = hasUsableContact && heartBeatResult.isPeak;

    if (emittedPeak) {
      setBeatMarker(1);
      if (beatMarkerTimerRef.current) window.clearTimeout(beatMarkerTimerRef.current);
      beatMarkerTimerRef.current = window.setTimeout(() => {
        setBeatMarker(0);
        beatMarkerTimerRef.current = null;
      }, VITAL_THRESHOLDS.ROUTER.BEAT_MARKER_MS);
    }

    if (emittedPeak) {
      totalBeatsRef.current++;
      const currentArrCount = vitalSignsRef.current.arrhythmia.value?.count ?? 0;
      if (currentArrCount > lastArrhythmiaCountForBeatsRef.current) {
        arrhythmiaBeatsRef.current++;
        lastArrhythmiaCountForBeatsRef.current = currentArrCount;
      }
    }

    if (
      emittedPeak &&
      heartBeatResult.rrData?.intervals &&
      heartBeatResult.rrData.intervals.length > 0 &&
      nowT - lastRrPushRef.current >= RR_PUSH_THROTTLE_MS
    ) {
      lastRrPushRef.current = nowT;
      setRRIntervals(heartBeatResult.rrData.intervals.slice(-5));
    }

    if (!vitalsDspReady) {
      if (
        hasUsableContact &&
        (vitalSignsRef.current.spo2.value ?? 0) > 0 &&
        nowT - lastVitalsPushRef.current >= VITALS_PUSH_THROTTLE_MS
      ) {
        lastVitalsPushRef.current = nowT;
        setVitalSigns(prev => ({
          ...prev,
          spo2: vitalSignsRef.current.spo2,
          bloodPressure: vitalSignsRef.current.bloodPressure,
          signalQuality: Math.round(rawSqi),
        }));
      }
      return;
    }

    vitalSignsFrameCounter.current++;

    const dspDue = vitalSignsFrameCounter.current >= VITALS_PROCESS_EVERY_N_FRAMES;
    if (dspDue) {
      vitalSignsFrameCounter.current = 0;
      const rgbStats = processVitalSigns.getRGBStats();

      if (rgbStats.redDC > 0 && rgbStats.greenDC > 0) {
        processVitalSigns.setRGBData({
          redAC: rgbStats.redAC,
          redDC: rgbStats.redDC,
          greenAC: rgbStats.greenAC,
          greenDC: rgbStats.greenDC,
          blueAC: rgbStats.blueAC,
          blueDC: rgbStats.blueDC,
        });
      }

      const peakDiag = heartBeatResult.ensembleDiagnostics as
        | { agreement?: { elgendi?: number; spectral?: number }; confidence?: number }
        | undefined;
      const sqmRaw = diag?.sqm && typeof diag.sqm === "object" ? diag.sqm : {};
      const enrichedSqm = SignalQualityIndex.enrichMetrics(
        {
          ...sqmRaw,
          sqi: rawSqi || lastSignal.quality || 0,
          perfusionIndex: lastSignal.perfusionIndex ?? 0,
        },
        {
          agreement: peakDiag?.agreement,
          elgendiConfidence: peakDiag?.agreement?.elgendi,
        },
      );

      const rrForVitals =
        fullVitalsReady &&
        heartBeatResult.rrData &&
        heartBeatResult.rrData.intervals.length >= 2
          ? { ...heartBeatResult.rrData, timestampNow: nowT }
          : fullVitalsReady &&
              lastRrSnapshotRef.current &&
              lastRrSnapshotRef.current.intervals.length >= 2
            ? { ...lastRrSnapshotRef.current, timestampNow: nowT }
            : undefined;

      // Extraer canales del banco de filtros especializado (PPGSignalSplitter)
      const splitterChannels = {
        morphologyFiltered: lastSignal.morphologyFiltered,
        respirationFiltered: lastSignal.respirationFiltered,
        arrhythmiaFiltered: lastSignal.arrhythmiaFiltered,
        spo2Channels: lastSignal.spo2Channels,
      };

      const effectiveBpm = bpmOut || lastGoodBpmRef.current;

      const vitals = processVitalSigns.processSignal(
        lastSignal.filteredValue,
        rawSqi || lastSignal.quality || 0,
        effectiveBpm,
        rrForVitals,
        lastSignal.perfusionIndex,
        enrichedSqm,
        lastSignal.morphologyValue ?? lastSignal.filteredValue,
        splitterChannels
      );

      vitalSignsRef.current = vitals;

      const uiDue = nowT - lastVitalsPushRef.current >= VITALS_PUSH_THROTTLE_MS;
      if (uiDue) {
        lastVitalsPushRef.current = nowT;
        setVitalSigns(applyLiveDisplaySmooth(vitals));
      }

      if (
        fullVitalsReady &&
        heartBeatResult.rrData &&
        heartBeatResult.rrData.intervals.length >= 2 &&
        heartBeatResult.confidence > VITAL_THRESHOLDS.ROUTER.ARRHYTHMIA_MIN_CONF &&
        vitals.heartRate.status === 'VALID'
      ) {
        const arrhythmiaStatus = vitals.arrhythmia.value?.status ?? '';
        if (arrhythmiaStatus) {
          lastArrhythmiaData.current = vitals.lastArrhythmiaData || null;

          const isArrhythmiaDetected = arrhythmiaStatus.includes("ARRITMIA DETECTADA");
          if (isArrhythmiaDetected !== arrhythmiaDetectedRef.current) {
            arrhythmiaDetectedRef.current = isArrhythmiaDetected;

            if (isArrhythmiaDetected) {
              triggerArrhythmiaHaptic().catch(() => undefined);
              toast({
                title: "⚠️ Arritmia detectada",
                description: `Latido irregular #${vitals.arrhythmia.value?.count ?? 0}`,
                variant: "destructive",
                duration: 4000
              });
            }
          }
        }
      }
    }
  }, [
    processHeartBeat,
    processVitalSigns,
    cameraHintsRef,
    resetFingerContactSession,
    applyLiveDisplaySmooth,
    ppgMeterRef,
  ]);



  // Conectar isMonitoringRef externamente
  const setIsMonitoringRef = useCallback((val: boolean) => {
    isMonitoringRef.current = val;
  }, []);

  return {
    // State outputs
    vitalSigns,
    setVitalSigns,
    heartbeatSignal,
    setHeartbeatSignal,
    beatMarker,
    setBeatMarker,
    rrIntervals,
    setRRIntervals,
    currentDiagnostics,
    setCurrentDiagnostics,


    // Refs for save
    vitalSignsRef,
    totalBeatsRef,
    arrhythmiaBeatsRef,
    lastArrhythmiaData,
    motionArtifactFramesRef,
    saturationFramesRef,
    underexposedFramesRef,
    artifactCheckFramesRef,
    isMonitoringRef: isMonitoringRef,

    // Sanity state
    sanityProfileId,
    setSanityProfileId,
    customJSON,
    setCustomJSON,

    // Callbacks
    handleSignalRealtime,

    resetFingerContactSession,
    resetSessionRefs,
    setIsMonitoringRef,
    bpmSanityRef,
    applyLiveDisplaySmooth,
  };
}
