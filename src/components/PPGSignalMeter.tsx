import React, { useEffect, useRef, useCallback, useState, useLayoutEffect, useImperativeHandle } from 'react';
import { CircularBuffer } from '../utils/CircularBuffer';
import { isNative } from '@/lib/device/platform';
import { calculateHRV, isPhysiologicalRR } from '../utils/physio';
import {
  DISPLAY_SMOOTH_ALPHAS,
  lerpDisplayValue,
} from '@/lib/measurement/displaySmoothing';
import {
  BUFFER_SIZE,
  TREND_WINDOW_MS,
  TREND_MAX_POINTS,
  PpgLayout,
  PpgRenderState,
  drawBackground,
  drawHeader,
  drawMetricsBar,
  drawPressureGauge,
  drawSignal,
  drawAcquisitionOverlay,
  drawTrendStrip,
  drawFooter,
} from '@/lib/ui/ppgCanvasRenderer';
import { drawGrid3D } from '@/lib/ui/ppg3dProjection';
import { realSignalStrength } from '@/lib/ui/waveHonesty';
import { PulseIndicator } from './PulseIndicator';
import { ActionButtons } from './ActionButtons';

export interface PPGSignalMeterProps {
  value: number;
  quality: number;
  isFingerDetected: boolean;
  onStartMeasurement: () => void;
  onReset: () => void;
  isMonitoring?: boolean;
  arrhythmiaStatus?: string;
  rawArrhythmiaData?: {
    timestamp: number;
    rmssd: number;
    rrVariation: number;
  } | null;
  preserveResults?: boolean;
  isPeak?: boolean;
  bpm?: number | null;
  spo2?: number;
  rrIntervals?: number[];
  elapsedTime?: number;
  perfusionIndex?: number;
  pressure?: { systolic: number; diastolic: number; confidence?: string; featureQuality?: number };
  bpStatus?: string | undefined;
  arrhythmiaCount?: number;
  contactState?: string;
  acquisitionStatus?: string;
  diagnostics?: {
    status?: string;
    message?: string;
    placementHint?: string;
    hasPulsatility?: boolean;
    acquisitionStage?: 'SEARCHING' | 'STABILIZING' | 'READY';
    acquisitionProgress?: number;
    sqm?: {
      fpsEffective?: number;
      timestampJitterMs?: number;
      underexposureRatio?: number;
    };
    peakDetection?: {
      confidence?: number;
      agreement?: { elgendi?: number };
      fusedPeakTimes?: number[];
      elgendiPeakTimes?: number[];
      fusedPeakCount?: number;
      rejectedPeaks?: Array<{ index: number; reason: string; detector: string }>;
    };
  };
}

export interface PPGSignalMeterHandle {
  pushSignal: (value: number, timestamp: number) => void;
  clearBuffer: () => void;
}

function getSafeAreaBottom(): number {
  if (typeof document === 'undefined') return 0;
  const div = document.createElement('div');
  div.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  document.body.appendChild(div);
  const offset = parseInt(window.getComputedStyle(div).paddingBottom, 10) || 0;
  document.body.removeChild(div);
  return offset;
}

const REAL_BEAT_VISUAL_MORPHOLOGY = {
  /**
   * Morfología visual pura: reproduce el look cardiográfico sintético anterior,
   * pero el disparo temporal sale de picos PPG reales aceptados por el pipeline.
   * No alimenta BPM, SpO₂, HRV, presión, arritmias ni persistencia de mediciones.
   */
  MAX_PEAK: 8.0,
  MIN_VALLEY: -3.2,
  DICROTIC_SHOULDER: 1.25,
  DOWNSTROKE_MS: 60,
  RECOVERY_MS: 170,
  DICROTIC_START_MS: 185,
  DICROTIC_PEAK_MS: 238,
  DICROTIC_END_MS: 330,
  CYCLE_MAX_MS: 520,
  RAW_BASELINE_GAIN: 0.10,
  BASELINE_DECAY: 0.84,
  MIN_AMP_SCALE: 0.74,
  MAX_AMP_SCALE: 1.18,
};

interface VisualMorphologyState {
  lastOutput: number;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function easeOutCubic(t: number): number {
  const x = clampNumber(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

function easeInOutSine(t: number): number {
  const x = clampNumber(t, 0, 1);
  return -(Math.cos(Math.PI * x) - 1) / 2;
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * clampNumber(t, 0, 1);
}

function realBeatVisualValue(args: {
  rawValue: number;
  nowMs: number;
  lastPeakMs: number;
  lastRRMs: number;
  isFingerDetected: boolean;
  preserveResults: boolean;
  quality: number;
  perfusionIndex: number;
  previousValue: number;
}): number {
  const {
    rawValue,
    nowMs,
    lastPeakMs,
    lastRRMs,
    isFingerDetected,
    preserveResults,
    quality,
    perfusionIndex,
    previousValue,
  } = args;

  if (!isFingerDetected && !preserveResults) return 0;

  const rawMicroMotion = clampNumber(rawValue, -1, 1) * REAL_BEAT_VISUAL_MORPHOLOGY.RAW_BASELINE_GAIN;
  const baseline = previousValue * REAL_BEAT_VISUAL_MORPHOLOGY.BASELINE_DECAY + rawMicroMotion;

  if (lastPeakMs <= 0) return baseline;

  const ageMs = nowMs - lastPeakMs;
  const rrMs = isPhysiologicalRR(lastRRMs) ? lastRRMs : 800;
  const visibleCycleMs = Math.min(
    REAL_BEAT_VISUAL_MORPHOLOGY.CYCLE_MAX_MS,
    Math.max(360, rrMs * 0.82),
  );

  if (ageMs < 0 || ageMs > visibleCycleMs) return baseline;

  const qLift = clampNumber(quality / 100, 0, 1) * 0.20;
  const piLift = clampNumber(perfusionIndex / 0.012, 0, 1) * 0.24;
  const ampScale = clampNumber(
    0.74 + qLift + piLift,
    REAL_BEAT_VISUAL_MORPHOLOGY.MIN_AMP_SCALE,
    REAL_BEAT_VISUAL_MORPHOLOGY.MAX_AMP_SCALE,
  );

  let y = 0;
  if (ageMs <= REAL_BEAT_VISUAL_MORPHOLOGY.DOWNSTROKE_MS) {
    const t = ageMs / REAL_BEAT_VISUAL_MORPHOLOGY.DOWNSTROKE_MS;
    y = lerpNumber(
      REAL_BEAT_VISUAL_MORPHOLOGY.MAX_PEAK,
      REAL_BEAT_VISUAL_MORPHOLOGY.MIN_VALLEY,
      easeOutCubic(t),
    );
  } else if (ageMs <= REAL_BEAT_VISUAL_MORPHOLOGY.RECOVERY_MS) {
    const t = (ageMs - REAL_BEAT_VISUAL_MORPHOLOGY.DOWNSTROKE_MS) /
      (REAL_BEAT_VISUAL_MORPHOLOGY.RECOVERY_MS - REAL_BEAT_VISUAL_MORPHOLOGY.DOWNSTROKE_MS);
    y = lerpNumber(REAL_BEAT_VISUAL_MORPHOLOGY.MIN_VALLEY, 0, easeOutCubic(t));
  } else if (ageMs <= REAL_BEAT_VISUAL_MORPHOLOGY.DICROTIC_END_MS) {
    if (ageMs <= REAL_BEAT_VISUAL_MORPHOLOGY.DICROTIC_PEAK_MS) {
      const t = (ageMs - REAL_BEAT_VISUAL_MORPHOLOGY.DICROTIC_START_MS) /
        (REAL_BEAT_VISUAL_MORPHOLOGY.DICROTIC_PEAK_MS - REAL_BEAT_VISUAL_MORPHOLOGY.DICROTIC_START_MS);
      y = lerpNumber(0, REAL_BEAT_VISUAL_MORPHOLOGY.DICROTIC_SHOULDER, easeInOutSine(t));
    } else {
      const t = (ageMs - REAL_BEAT_VISUAL_MORPHOLOGY.DICROTIC_PEAK_MS) /
        (REAL_BEAT_VISUAL_MORPHOLOGY.DICROTIC_END_MS - REAL_BEAT_VISUAL_MORPHOLOGY.DICROTIC_PEAK_MS);
      y = lerpNumber(REAL_BEAT_VISUAL_MORPHOLOGY.DICROTIC_SHOULDER, 0, easeInOutSine(t));
    }
  }

  return y * ampScale + rawMicroMotion;
}

const PPGSignalMeter = React.forwardRef<PPGSignalMeterHandle, PPGSignalMeterProps>(({
  value,
  quality,
  isFingerDetected,
  onStartMeasurement,
  onReset,
  isMonitoring = false,
  arrhythmiaStatus,
  rawArrhythmiaData,
  preserveResults = false,
  isPeak = false,
  bpm = null,
  spo2 = 0,
  rrIntervals = [],
  elapsedTime = 0,
  perfusionIndex = 0,
  pressure,
  bpStatus,
  arrhythmiaCount = 0,
  contactState,
  acquisitionStatus,
  diagnostics,
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const isRunningRef = useRef(false);
  const dataBufferRef = useRef<CircularBuffer | null>(null);

  const propsRef = useRef({
    value, quality, isFingerDetected, isMonitoring, arrhythmiaStatus,
    arrhythmiaCount, preserveResults, isPeak, bpm, spo2, rrIntervals,
    rawArrhythmiaData, elapsedTime, perfusionIndex, pressure, bpStatus,
    contactState, acquisitionStatus, diagnostics,
  });

  const lastPeakTimeRef = useRef(0);
  const lastPeakProcessedRef = useRef(0);
  const arrActiveUntilRef = useRef(0);
  /** Latch: la onda se revela solo cuando la adquisición llega a READY (señal estable). */
  const traceRevealedRef = useRef(false);
  const [showPulse, setShowPulse] = useState(false);

  const lastArrhythmiaCountRef = useRef(0);
  const beatHistoryRef = useRef<{ isArrhythmia: boolean; time: number; rr: number }[]>([]);
  const visualMorphologyRef = useRef<VisualMorphologyState>({ lastOutput: 0 });

  const amplitudeStatsRef = useRef({ min: -50, max: 50, range: 100 });

  const ibiDisplayRef = useRef<number>(0);
  const hrvDisplayRef = useRef<{ sdnn: number; rmssd: number; pnn50: number; cv: number }>({ sdnn: 0, rmssd: 0, pnn50: 0, cv: 0 });
  const bpmStatsRef = useRef<{ min: number; max: number; sum: number; n: number }>({ min: 0, max: 0, sum: 0, n: 0 });
  const bpmTrendRef = useRef<{ t: number; bpm: number; isArr: boolean }[]>([]);
  const lastBpmSampleRef = useRef<number>(0);
  const pendingTrendArrRef = useRef(false);
  const smoothedBpmRef = useRef<number>(0);
  const displayBpmRef = useRef(0);
  const displaySpo2Ref = useRef(0);
  const displaySysRef = useRef(0);
  const displayDiaRef = useRef(0);
  const waveGainRef = useRef(4.5);

  useImperativeHandle(ref, () => ({
    pushSignal: (val: number, _ts: number) => {
      if (!dataBufferRef.current) return;
      const now = Date.now();
      const p = propsRef.current;
      const visualValue = realBeatVisualValue({
        rawValue: Number.isFinite(val) ? val : 0,
        nowMs: now,
        lastPeakMs: lastPeakTimeRef.current,
        lastRRMs: ibiDisplayRef.current,
        isFingerDetected: p.isFingerDetected,
        preserveResults: p.preserveResults,
        quality: p.quality,
        perfusionIndex: p.perfusionIndex ?? 0,
        previousValue: visualMorphologyRef.current.lastOutput,
      });
      visualMorphologyRef.current.lastOutput = visualValue;
      const scaledValue = visualValue * waveGainRef.current;
      const isArrhythmia = now < arrActiveUntilRef.current;
      dataBufferRef.current.push({
        time: now,
        value: scaledValue,
        isArrhythmia
      });
    },
    clearBuffer: () => {
      dataBufferRef.current?.clear();
      lastPeakTimeRef.current = 0;
      visualMorphologyRef.current = { lastOutput: 0 };
    }
  }));

  const layoutRef = useRef<PpgLayout>({
    width: 0, height: 0,
    header: { x: 0, y: 0, w: 0, h: 0 },
    metrics: { x: 0, y: 0, w: 0, h: 0 },
    plot: { x: 0, y: 0, w: 0, h: 0, centerY: 0 },
    trend: { x: 0, y: 0, w: 0, h: 0 },
    footer: { x: 0, y: 0, w: 0, h: 0 },
  });

  useEffect(() => {
    propsRef.current = {
      value, quality, isFingerDetected, isMonitoring, arrhythmiaStatus,
      arrhythmiaCount, preserveResults, isPeak, bpm, spo2, rrIntervals,
      rawArrhythmiaData, elapsedTime, perfusionIndex, pressure, bpStatus,
      contactState, acquisitionStatus, diagnostics,
    };

    if (rrIntervals && rrIntervals.length >= 2) {
      const last = rrIntervals[rrIntervals.length - 1];
      if (isPhysiologicalRR(last)) {
        ibiDisplayRef.current = Math.round(last);
      }
      const hrv = calculateHRV(rrIntervals);
      hrvDisplayRef.current = {
        sdnn: Math.round(hrv.sdnn),
        rmssd: Math.round(hrv.rmssd),
        pnn50: Math.round(hrv.pnn50 * 100),
        cv: Number(hrv.cv.toFixed(3)),
      };
    }

    const nowMs = Date.now();

    if (bpm != null && bpm > 0) {
      displayBpmRef.current = bpm;
      smoothedBpmRef.current = bpm;
    }

    const pi = perfusionIndex ?? 0;
    const q = quality ?? 0;
    const weakTarget =
      4.2 *
      (pi < 0.0025 ? 2.1 : pi < 0.005 ? 1.65 : pi < 0.01 ? 1.35 : 1.08) *
      (q < 20 ? 1.4 : q < 40 ? 1.2 : 1);
    waveGainRef.current = waveGainRef.current * 0.40 + weakTarget * 0.60;

    if (bpm != null && bpm > 30 && bpm < 220 && nowMs - lastBpmSampleRef.current > 500) {
      lastBpmSampleRef.current = nowMs;
      const s = bpmStatsRef.current;
      const valToRecord = Math.round(smoothedBpmRef.current);

      if (s.n === 0) { s.min = valToRecord; s.max = valToRecord; }
      else {
        if (valToRecord < s.min) s.min = valToRecord;
        if (valToRecord > s.max) s.max = valToRecord;
      }
      s.sum += valToRecord; s.n += 1;

      bpmTrendRef.current.push({ t: nowMs, bpm: valToRecord, isArr: pendingTrendArrRef.current });
      pendingTrendArrRef.current = false;

      const cutoff = nowMs - TREND_WINDOW_MS;
      while (bpmTrendRef.current.length > 0 && bpmTrendRef.current[0].t < cutoff) {
        bpmTrendRef.current.shift();
      }
      if (bpmTrendRef.current.length > TREND_MAX_POINTS) {
        bpmTrendRef.current = bpmTrendRef.current.slice(-TREND_MAX_POINTS);
      }
    }
    if (!isFingerDetected && !preserveResults) {
      bpmStatsRef.current = { min: 0, max: 0, sum: 0, n: 0 };
      bpmTrendRef.current = [];
      pendingTrendArrRef.current = false;
      smoothedBpmRef.current = 0;
      lastPeakTimeRef.current = 0;
      visualMorphologyRef.current = { lastOutput: 0 };
    }

    if (!isFingerDetected && !preserveResults) {
      displayBpmRef.current = 0;
      displaySpo2Ref.current = 0;
      displaySysRef.current = 0;
      displayDiaRef.current = 0;
    }
  }, [
    value, quality, isFingerDetected, arrhythmiaStatus, preserveResults,
    isPeak, bpm, spo2, rrIntervals, rawArrhythmiaData, elapsedTime,
    perfusionIndex, pressure, bpStatus, arrhythmiaCount, isMonitoring,
    contactState, acquisitionStatus, diagnostics,
  ]);

  useEffect(() => {
    if (isPeak && isFingerDetected) {
      const now = Date.now();
      if (now - lastPeakTimeRef.current > 250) {
        lastPeakTimeRef.current = now;
        visualMorphologyRef.current.lastOutput = REAL_BEAT_VISUAL_MORPHOLOGY.MAX_PEAK;
        setShowPulse(true);
        const t = window.setTimeout(() => setShowPulse(false), 120);
        return () => window.clearTimeout(t);
      }
    }
  }, [isPeak, isFingerDetected]);

  useEffect(() => {
    if (!dataBufferRef.current) {
      dataBufferRef.current = new CircularBuffer(BUFFER_SIZE);
    }
  }, []);

  useEffect(() => {
    if (preserveResults && !isFingerDetected) {
      dataBufferRef.current?.clear();
    }
  }, [preserveResults, isFingerDetected]);

  const recomputeLayout = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const maxDpr = isNative() ? 1.5 : 2.5;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const cssW = Math.max(320, Math.floor(rect.width));
    const cssH = Math.max(480, Math.floor(rect.height));
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const header = { x: 0, y: 0, w: cssW, h: 36 };
    const metricsH = Math.max(92, Math.min(108, Math.round(cssH * 0.11)));
    const metrics = { x: 0, y: header.h, w: cssW, h: metricsH };

    const lowerH = Math.max(68, Math.min(86, Math.round(cssH * 0.095)));
    const footerH = 46;
    const safeAreaBottom = getSafeAreaBottom();
    const buttonsH = 48 + safeAreaBottom;
    const plotY = header.h + metricsH;
    const plotH = cssH - plotY - lowerH - footerH - buttonsH;

    const plotX = 12;
    const plotW = cssW - plotX * 2;
    const plot = { x: plotX, y: plotY + 6, w: plotW, h: Math.max(180, plotH - 6), centerY: 0 };
    plot.centerY = plot.y + plot.h / 2;

    const lowerY = plot.y + plot.h + 4;
    const trend = { x: plotX, y: lowerY, w: plotW, h: Math.max(64, lowerH - 4) };

    const footer = { x: 0, y: cssH - buttonsH - footerH, w: cssW, h: footerH };

    layoutRef.current = { width: cssW, height: cssH, header, metrics, plot, trend, footer };
  }, []);

  useLayoutEffect(() => {
    recomputeLayout();
    const ro = new ResizeObserver(() => recomputeLayout());
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('orientationchange', recomputeLayout);
    return () => {
      ro.disconnect();
      window.removeEventListener('orientationchange', recomputeLayout);
    };
  }, [recomputeLayout]);

  useEffect(() => {
    if (isRunningRef.current) return;
    isRunningRef.current = true;

    // Sin throttle manual: renderizamos en CADA rAF. El throttle con Date.now()
    // + rAF (~60Hz) generaba frames "saltados" cuando el reloj y el vsync se
    // desincronizaban (parpadeo visible en la onda). rAF ya limita al refresh.
    const render = () => {
      if (!isRunningRef.current) return;
      const canvas = canvasRef.current;
      const buffer = dataBufferRef.current;
      if (!canvas || !buffer) {
        animationRef.current = requestAnimationFrame(render);
        return;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        animationRef.current = requestAnimationFrame(render);
        return;
      }
      const now = Date.now();

      const p = propsRef.current;
      const fingerOn = p.isFingerDetected;
      const preserve = p.preserveResults;
      const targetBpm = !fingerOn && !preserve ? 0 : Math.max(0, p.bpm ?? 0);
      const targetSpo2 = fingerOn || preserve ? p.spo2 ?? 0 : 0;
      const targetSys = fingerOn || preserve ? p.pressure?.systolic ?? 0 : 0;
      const targetDia = fingerOn || preserve ? p.pressure?.diastolic ?? 0 : 0;
      displayBpmRef.current = Math.round(
        lerpDisplayValue(displayBpmRef.current, targetBpm, DISPLAY_SMOOTH_ALPHAS.hr),
      );
      displaySpo2Ref.current = Math.round(
        lerpDisplayValue(displaySpo2Ref.current, targetSpo2, DISPLAY_SMOOTH_ALPHAS.spo2),
      );
      displaySysRef.current = Math.round(
        lerpDisplayValue(displaySysRef.current, targetSys, DISPLAY_SMOOTH_ALPHAS.bp),
      );
      displayDiaRef.current = Math.round(
        lerpDisplayValue(displayDiaRef.current, targetDia, DISPLAY_SMOOTH_ALPHAS.bp),
      );

      // La onda se muestra SIEMPRE, con altura honesta (signalStrength). El latch
      // solo controla el indicador fino de progreso (barra), que desaparece al
      // estabilizar (READY). No se oculta ni se limpia el trazo → onda continua.
      const diagRec = p.diagnostics as
        | { acquisitionStage?: string; sqm?: { periodicity?: number } }
        | undefined;
      const acqStage = diagRec?.acquisitionStage;
      if (!fingerOn && !preserve) {
        traceRevealedRef.current = false;
      } else if (!traceRevealedRef.current && acqStage === 'READY') {
        traceRevealedRef.current = true;
      }
      // Fuerza pulsátil real → comprime la altura de la onda (inerte → plana).
      const periodicityNow =
        typeof diagRec?.sqm?.periodicity === 'number' ? diagRec.sqm.periodicity : 0;
      const signalStrengthNow = fingerOn
        ? realSignalStrength(p.perfusionIndex ?? 0, periodicityNow)
        : 0;


      const renderState: PpgRenderState = {
        layout: layoutRef.current,
        props: {
          value: p.value, quality: p.quality, isFingerDetected: p.isFingerDetected,
          isMonitoring: p.isMonitoring, isPeak: p.isPeak ?? false, preserveResults: p.preserveResults,
          bpm: p.bpm, spo2: p.spo2 ?? 0, rrIntervals: p.rrIntervals ?? [],
          elapsedTime: p.elapsedTime ?? 0, perfusionIndex: p.perfusionIndex ?? 0,
          pressure: p.pressure, bpStatus: p.bpStatus,
          arrhythmiaStatus: p.arrhythmiaStatus, arrhythmiaCount: p.arrhythmiaCount ?? 0,
          contactState: p.contactState, acquisitionStatus: p.acquisitionStatus,
          diagnostics: p.diagnostics,
        },
        now,
        displayBpm: displayBpmRef.current,
        displaySpo2: displaySpo2Ref.current,
        displaySys: displaySysRef.current,
        displayDia: displayDiaRef.current,
        hrv: hrvDisplayRef.current,
        bpmStats: bpmStatsRef.current,
        bpmTrend: bpmTrendRef.current,
        beatHistory: beatHistoryRef.current,
        amplitudeStats: amplitudeStatsRef.current,
        waveGain: waveGainRef.current,
        ibiDisplay: ibiDisplayRef.current,
        buffer: dataBufferRef.current,
        lastArrhythmiaCount: lastArrhythmiaCountRef.current,
        pendingTrendArr: pendingTrendArrRef.current,
        lastPeakProcessedTime: lastPeakProcessedRef.current,
        arrActiveUntil: arrActiveUntilRef.current,
        traceRevealed: traceRevealedRef.current,
        signalStrength: signalStrengthNow,
      };

      drawBackground(ctx, layoutRef.current.width, layoutRef.current.height);
      drawHeader(ctx, renderState);
      drawMetricsBar(ctx, renderState);
      drawGrid3D(ctx, renderState);
      drawPressureGauge(ctx, renderState);
      drawSignal(ctx, renderState);
      drawAcquisitionOverlay(ctx, renderState);
      drawTrendStrip(ctx, renderState);
      drawFooter(ctx, renderState);

      lastPeakProcessedRef.current = renderState.lastPeakProcessedTime;
      arrActiveUntilRef.current = renderState.arrActiveUntil;
      lastArrhythmiaCountRef.current = renderState.lastArrhythmiaCount;
      pendingTrendArrRef.current = renderState.pendingTrendArr;
      beatHistoryRef.current = renderState.beatHistory;
      amplitudeStatsRef.current = renderState.amplitudeStats;

      animationRef.current = requestAnimationFrame(render);
    };

    animationRef.current = requestAnimationFrame(render);

    return () => {
      isRunningRef.current = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  const handleReset = useCallback(() => {
    dataBufferRef.current?.clear();
    amplitudeStatsRef.current = { min: -50, max: 50, range: 100 };
    beatHistoryRef.current = [];
    lastArrhythmiaCountRef.current = 0;
    lastPeakProcessedRef.current = 0;
    arrActiveUntilRef.current = 0;
    ibiDisplayRef.current = 0;
    hrvDisplayRef.current = { sdnn: 0, rmssd: 0, pnn50: 0, cv: 0 };
    bpmStatsRef.current = { min: 0, max: 0, sum: 0, n: 0 };
    bpmTrendRef.current = [];
    lastPeakTimeRef.current = 0;
    visualMorphologyRef.current = { lastOutput: 0 };
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas!.width, canvas!.height);
    }
    onReset();
  }, [onReset]);

  return (
    <div ref={containerRef} className="fixed inset-0 bg-slate-950 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
      />
      <PulseIndicator showPulse={showPulse} />
      <ActionButtons
        isMonitoring={isMonitoring}
        onStartMeasurement={onStartMeasurement}
        onReset={handleReset}
      />
    </div>
  );
});

export default PPGSignalMeter;
