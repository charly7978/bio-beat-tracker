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
import {
  recordVerdict as recordAuditVerdict,
  getNegativeCount as getAuditNegativeCount,
} from '@/lib/sanity/sanityAuditLog';
import { toast } from '@/components/ui/use-toast';

interface HeartBeatProcessorAPI {
  processSignal: (
    value: number,
    contactState: ContactState,
    timestamp?: number,
    fingerConfirmed?: boolean,
    ppgQuality?: { sqi: number; perfusionIndex?: number },
  ) => {
    bpm: number;
    confidence: number;
    isPeak: boolean;
    filteredValue: number;
    signalQuality: number;
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
  ) => VitalSignsResult;
  setPlacementMode: (mode: FingerPlacementMode) => void;
  setRGBData: (data: RGBData) => void;
  getRGBStats: () => { redAC: number; redDC: number; greenAC: number; greenDC: number; blueAC: number; blueDC: number; rgRatio: number; ratioOfRatios: number };
}

interface UseSignalRouterInput {
  processHeartBeat: HeartBeatProcessorAPI;
  processVitalSigns: VitalSignsProcessorAPI;
  cameraHintsRef: React.MutableRefObject<CameraRuntimeHints>;
}

export function useSignalRouter({ processHeartBeat, processVitalSigns, cameraHintsRef }: UseSignalRouterInput) {
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
  const UNSTABLE_ZERO_THRESHOLD = 60;
  const NO_CONTACT_SESSION_RESET_FRAMES = 25;
  const CONTACT_REGAIN_RESET_MIN_FRAMES = 30;
  const STALE_PEAK_REACQUIRE_FRAMES = 40;
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

  // Throttle timers
  const lastHrPushRef = useRef(0);
  const lastVitalsPushRef = useRef(0);
  const lastSignalPushRef = useRef(0);
  const lastRrPushRef = useRef(0);
  const lastDiagPushRef = useRef(0);
  const beatMarkerTimerRef = useRef<number | null>(null);
  const HR_PUSH_THROTTLE_MS = 80;
  const VITALS_PUSH_THROTTLE_MS = 300;
  const RR_PUSH_THROTTLE_MS = 250;
  const SIGNAL_PUSH_THROTTLE_MS = 16;
  const DIAG_PUSH_THROTTLE_MS = 200;
  const VITALS_PROCESS_EVERY_N_FRAMES = 3;

  // Sanity checker
  const [sanityProfileId, setSanityProfileId] = useState<string>(() => getActiveProfileId());
  const [customJSON, setCustomJSON] = useState<string>(() => {
    const o = getCustomOverrides();
    return Object.keys(o).length ? JSON.stringify(o, null, 2) : "";
  });
  const [_auditNegativeCount, setAuditNegativeCount] = useState(0);
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
  const [_sanityError, setSanityError] = useState<string | null>(null);
  const isMonitoringRef = useRef(false);

  useEffect(() => {
    vitalSignsRef.current = vitalSigns;
  }, [vitalSigns]);

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
    setRRIntervals([]);
    setBeatMarker(0);
    if (beatMarkerTimerRef.current) {
      window.clearTimeout(beatMarkerTimerRef.current);
      beatMarkerTimerRef.current = null;
    }
    bpmSanityRef.current.reset();
    sanityErrorRef.current = null;
    setSanityError(null);
    displayHrRef.current = 0;
    displaySpo2Ref.current = 0;
    displayBpRef.current = { systolic: 0, diastolic: 0 };
    lastHbInputRef.current = 0;
    lastHrPushRef.current = 0;
    lastVitalsPushRef.current = 0;
    lastRrPushRef.current = 0;
    lastSignalPushRef.current = 0;
    lastDiagPushRef.current = 0;
  }, [processHeartBeat]);

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
    setSanityError(null);
    lastArrhythmiaData.current = null;
    arrhythmiaDetectedRef.current = false;
  }, []);

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
    if (typeof sqm.saturationRatio === 'number' && sqm.saturationRatio > 0.75) {
      saturationFramesRef.current += 1;
    }
    if (typeof sqm.underexposureRatio === 'number' && sqm.underexposureRatio > 0.82) {
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
      },
    );

    const mergedDiag =
      diag && typeof diag === 'object'
        ? { ...diag, peakDetection: heartBeatResult.ensembleDiagnostics }
        : { peakDetection: heartBeatResult.ensembleDiagnostics };
    if (nowT - lastDiagPushRef.current >= DIAG_PUSH_THROTTLE_MS) {
      lastDiagPushRef.current = nowT;
      setCurrentDiagnostics(mergedDiag);
    }

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

    const piMin = Q.MIN_PI * Math.max(0.04, hints.minPiScale * 0.18);
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

    const showWaveform = hasUsableContact;

    if (nowT - lastSignalPushRef.current >= SIGNAL_PUSH_THROTTLE_MS) {
      lastSignalPushRef.current = nowT;
      setHeartbeatSignal(showWaveform ? signalValue : 0);
    }

    if (hasUsableContact && nowT - lastHrPushRef.current >= HR_PUSH_THROTTLE_MS) {
      lastHrPushRef.current = nowT;
      const sqRounded = Math.round(rawSqi);
      const hrStatus: import('@/types/measurements').MeasurementStatus =
        contactState === 'STABLE_CONTACT' && bpmLive > 0 && hrReady
          ? 'VALID'
          : bpmOut > 0
            ? 'WARMUP'
            : 'NO_VALID_SIGNAL';
      setVitalSigns(prev => {
        const next = {
          ...prev,
          heartRate: { ...prev.heartRate, value: bpmOut, status: hrStatus },
          signalQuality: sqRounded,
        };
        vitalSignsRef.current = next;
        return applyLiveDisplaySmooth(next);
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
        } else if (sanityErrorRef.current) {
          sanityErrorRef.current = null;
          setSanityError(null);
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
        const STALE_FINGER_NO_BPM = 90;
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
      }, 300);
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

      const vitals = processVitalSigns.processSignal(
        lastSignal.filteredValue,
        rawSqi || lastSignal.quality || 0,
        bpmOut || lastGoodBpmRef.current,
        rrForVitals,
        lastSignal.perfusionIndex,
        enrichedSqm,
        lastSignal.morphologyValue ?? lastSignal.filteredValue,
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
        heartBeatResult.confidence > 0.15 &&
        vitals.heartRate.status === 'VALID'
      ) {
        const arrhythmiaStatus = vitals.arrhythmia.value?.status ?? '';
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
