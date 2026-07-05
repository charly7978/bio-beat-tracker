import React, { useEffect, useRef, useCallback, useState, useLayoutEffect, useImperativeHandle } from 'react';
import { CircularBuffer } from '../utils/CircularBuffer';
import { isNative } from '@/lib/device/platform';
import { calculateHRV, isPhysiologicalRR } from '../utils/physio';
import {
  DISPLAY_SMOOTH_ALPHAS,
  lerpDisplayValue,
} from '@/lib/measurement/displaySmoothing';
import {
  TARGET_FPS,
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
import CameraView, { CameraViewHandle } from './CameraView';

export interface PPGSignalMeterProps {
  value: number;
  quality: number;
  isFingerDetected: boolean;
  onStartMeasurement: () => void;
  onReset: () => void;
  isMonitoring?: boolean;
  cameraRef?: React.Ref<CameraViewHandle>;
  isCameraOn?: boolean;
  onStreamReady?: (stream: MediaStream) => void;
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

const PPGSignalMeter = React.forwardRef<PPGSignalMeterHandle, PPGSignalMeterProps>(({
  value,
  quality,
  isFingerDetected,
  onStartMeasurement,
  onReset,
  isMonitoring = false,
  cameraRef,
  isCameraOn = false,
  onStreamReady,
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
  /** Capa superior SIN máscara: grillas + onda PPG siempre a opacidad plena. */
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
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

  const sweepPulseRef = useRef(0);
  const lastPeakTimeRef = useRef(0);
  const lastPeakProcessedRef = useRef(0);
  const arrActiveUntilRef = useRef(0);
  /** Latch: la onda se revela solo cuando la adquisición llega a READY (señal estable). */
  const traceRevealedRef = useRef(false);
  const [showPulse, setShowPulse] = useState(false);
  const [layoutInfo, setLayoutInfo] = useState<{ plotX: number; plotY: number; plotW: number; plotH: number; floorCenterY: number } | null>(null);

  const lastArrhythmiaCountRef = useRef(0);
  const beatHistoryRef = useRef<{ isArrhythmia: boolean; time: number; rr: number }[]>([]);

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
  const waveGainRef = useRef(4.2);

  useImperativeHandle(ref, () => ({
    pushSignal: (val: number, _ts: number) => {
      if (!dataBufferRef.current) return;
      const scaledValue = val * waveGainRef.current;
      const now = Date.now();
      const isArrhythmia = now < arrActiveUntilRef.current;
      dataBufferRef.current.push({
        time: now,
        value: scaledValue,
        isArrhythmia
      });
    },
    clearBuffer: () => {
      dataBufferRef.current?.clear();
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
    for (const c of [canvas, waveCanvasRef.current]) {
      if (!c) continue;
      c.width = Math.floor(cssW * dpr);
      c.height = Math.floor(cssH * dpr);
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
      const ctx = c.getContext('2d', { alpha: true });
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

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

    const horizonY = plot.y + plot.h * 0.08;
    const nearY = plot.y + plot.h - 30;
    const floorCenterY = (horizonY + nearY) / 2;

    setLayoutInfo({
      plotX: plot.x,
      plotY: plot.y,
      plotW: plot.w,
      plotH: plot.h,
      floorCenterY,
    });
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

    const frameTime = 1000 / TARGET_FPS;
    let lastRenderTime = 0;

    const render = () => {
      if (!isRunningRef.current) return;
      const canvas = canvasRef.current;
      const waveCanvas = waveCanvasRef.current;
      const buffer = dataBufferRef.current;
      if (!canvas || !waveCanvas || !buffer) {
        animationRef.current = requestAnimationFrame(render);
        return;
      }
      const ctx = canvas.getContext('2d', { alpha: true });
      const waveCtx = waveCanvas.getContext('2d', { alpha: true });
      if (!ctx || !waveCtx) {
        animationRef.current = requestAnimationFrame(render);
        return;
      }
      const now = Date.now();
      if (now - lastRenderTime < frameTime) {
        animationRef.current = requestAnimationFrame(render);
        return;
      }
      lastRenderTime = now;

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
        sweepPulse: sweepPulseRef.current,
        ibiDisplay: ibiDisplayRef.current,
        buffer: dataBufferRef.current,
        lastArrhythmiaCount: lastArrhythmiaCountRef.current,
        pendingTrendArr: pendingTrendArrRef.current,
        lastPeakProcessedTime: lastPeakProcessedRef.current,
        arrActiveUntil: arrActiveUntilRef.current,
        traceRevealed: traceRevealedRef.current,
        signalStrength: signalStrengthNow,
      };

      // Capa base (canvas enmascarado): fondo y paneles del monitor.
      drawBackground(ctx, layoutRef.current.width, layoutRef.current.height);
      drawHeader(ctx, renderState);
      drawMetricsBar(ctx, renderState);
      // Fondo negro del área de plot (la grilla vive en la capa superior).
      ctx.fillStyle = '#000000';
      ctx.fillRect(
        layoutRef.current.plot.x,
        layoutRef.current.plot.y,
        layoutRef.current.plot.w,
        layoutRef.current.plot.h,
      );
      drawTrendStrip(ctx, renderState);
      drawFooter(ctx, renderState);

      // Capa superior (canvas SIN máscara): grillas, onda PPG y overlays del
      // plot a opacidad plena, siempre por encima de la ventana del dedo.
      waveCtx.clearRect(0, 0, layoutRef.current.width, layoutRef.current.height);
      drawGrid3D(waveCtx, renderState, { skipBackground: true });
      drawPressureGauge(waveCtx, renderState);
      drawSignal(waveCtx, renderState);
      drawAcquisitionOverlay(waveCtx, renderState);

      sweepPulseRef.current = renderState.sweepPulse;
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
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas!.width, canvas!.height);
    }
    const waveCanvas = waveCanvasRef.current;
    const waveCtx = waveCanvas?.getContext('2d');
    if (waveCtx) {
      waveCtx.clearRect(0, 0, waveCanvas!.width, waveCanvas!.height);
    }
    onReset();
  }, [onReset]);

  return (
    <div ref={containerRef} className="fixed inset-0 overflow-hidden">
      <style>{`
        @keyframes scan {
          0% { transform: translateY(-70px); opacity: 0.2; }
          50% { transform: translateY(70px); opacity: 0.8; }
          100% { transform: translateY(-70px); opacity: 0.2; }
        }
        @keyframes spinClockwise {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes spinCounterClockwise {
          from { transform: rotate(0deg); }
          to { transform: rotate(-360deg); }
        }
        @keyframes pulseTelemetry {
          0% { opacity: 0.35; }
          50% { opacity: 0.85; }
          100% { opacity: 0.35; }
        }
      `}</style>

      {/* Base Canvas: Background, panels. Mask removed. */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ zIndex: 1 }}
      />

      {/* 3D Camera Preview Window reposado en la grilla del piso en 3D */}
      {isCameraOn && layoutInfo && (
        <div 
          className="absolute pointer-events-none font-mono"
          style={{
            position: 'absolute',
            left: layoutInfo.plotX + layoutInfo.plotW / 2,
            top: layoutInfo.floorCenterY,
            width: '180px',
            height: '180px',
            transform: 'translate(-50%, -50%) perspective(450px) rotateX(55deg)',
            transformStyle: 'preserve-3d',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          {/* Outer Corner Brackets (Tech HUD) */}
          <svg className="absolute inset-0 w-full h-full text-emerald-500/30" viewBox="0 0 180 180" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M 12,28 L 12,12 L 28,12" />
            <path d="M 152,12 L 168,12 L 168,28" />
            <path d="M 12,152 L 12,168 L 28,168" />
            <path d="M 168,152 L 168,168 L 152,168" />
          </svg>

          {/* Telemetry HUD Labels (Flat inside 3D space) */}
          <div className="absolute top-[12px] left-[14px] text-[6.5px] text-emerald-400/50 tracking-wider" style={{ animation: 'pulseTelemetry 3s infinite' }}>
            SYS.MODE: {isFingerDetected ? 'PPG_ACTIVE' : 'PPG_STANDBY'}
          </div>
          <div className="absolute top-[12px] right-[14px] text-[6.5px] text-emerald-400/50 tracking-wider" style={{ animation: 'pulseTelemetry 3s infinite' }}>
            WL: 660nm
          </div>
          <div className="absolute bottom-[12px] left-[14px] text-[6.5px] text-emerald-400/50 tracking-wider" style={{ animation: 'pulseTelemetry 3s infinite' }}>
            SENS: {isFingerDetected ? 'SIGNAL_LOCK' : 'SEARCH_SCAN'}
          </div>
          <div className="absolute bottom-[12px] right-[14px] text-[6.5px] text-emerald-400/50 tracking-wider" style={{ animation: 'pulseTelemetry 3s infinite' }}>
            GAIN: {quality > 0 ? `${Math.round(quality)}%` : 'AUTO'}
          </div>

          {/* Central Circular Camera Viewport */}
          <div 
            className="absolute left-[20px] top-[20px] w-[140px] h-[140px] rounded-full overflow-hidden transition-all duration-700" 
            style={{
              border: isFingerDetected ? '1px solid rgba(34, 197, 94, 0.45)' : '1px solid rgba(245, 158, 11, 0.35)',
              boxShadow: isFingerDetected 
                ? '0 0 15px rgba(34, 197, 94, 0.2), inset 0 0 15px rgba(34, 197, 94, 0.15)' 
                : '0 0 10px rgba(245, 158, 11, 0.12), inset 0 0 10px rgba(245, 158, 11, 0.08)',
              backgroundColor: '#000000',
            }}
          >
            {/* CameraView with soft blur filter to smooth out skin/blood details */}
            <div className="w-full h-full" style={{ filter: 'blur(10px) saturate(1.7) brightness(0.8)' }}>
              <CameraView 
                ref={cameraRef}
                onStreamReady={onStreamReady}
                isMonitoring={isCameraOn}
              />
            </div>
            
            {/* CRT scanlines overlay */}
            <div 
              className="absolute inset-0 pointer-events-none" 
              style={{
                background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.15), rgba(0,0,0,0.15) 1px, transparent 1px, transparent 3px)',
                opacity: 0.5
              }}
            />
            
            {/* Vignette overlay */}
            <div 
              className="absolute inset-0 pointer-events-none" 
              style={{
                background: 'radial-gradient(circle, rgba(0,0,0,0) 45%, rgba(0,0,0,0.85) 100%)'
              }}
            />
            
            {/* Spinning HUD Reticle Circles */}
            <svg 
              className="absolute inset-0 w-full h-full pointer-events-none" 
              viewBox="0 0 140 140" 
              fill="none" 
              stroke="currentColor"
            >
              {/* Outer ticking ring (spinning clockwise) */}
              <circle 
                cx="70" 
                cy="70" 
                r="64" 
                className={isFingerDetected ? 'text-emerald-500/20' : 'text-amber-500/15'}
                strokeWidth="0.75" 
                strokeDasharray="2 6" 
                style={{
                  transformOrigin: '70px 70px',
                  animation: 'spinClockwise 15s linear infinite'
                }}
              />
              
              {/* Inner segmented tech ring (spinning counter-clockwise) */}
              <circle 
                cx="70" 
                cy="70" 
                r="56" 
                className={isFingerDetected ? 'text-emerald-500/12' : 'text-amber-500/8'}
                strokeWidth="1" 
                strokeDasharray="40 12 5 12" 
                style={{
                  transformOrigin: '70px 70px',
                  animation: 'spinCounterClockwise 10s linear infinite'
                }}
              />

              {/* Cardinal ticks / Crosshair (static) */}
              <path d="M 70 4 L 70 10 M 70 130 L 70 136 M 4 70 L 10 70 M 130 70 L 136 70" stroke={isFingerDetected ? 'rgba(34,197,94,0.35)' : 'rgba(245,158,11,0.25)'} strokeWidth="0.75" />
            </svg>
            
            {/* Holographic Fingerprint Icon */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <svg
                viewBox="0 0 64 64"
                className={`w-14 h-14 transition-all duration-700 ${
                  isFingerDetected 
                    ? 'text-emerald-500/10 scale-90 rotate-6 opacity-20' 
                    : 'text-emerald-400/80 animate-pulse'
                }`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                style={{
                  filter: isFingerDetected ? 'none' : 'drop-shadow(0 0 6px rgba(52,211,153,0.35))'
                }}
              >
                <path d="M20 50 C20 42, 24 38, 32 38 C40 38, 44 42, 44 50" />
                <path d="M16 50 C16 38, 22 32, 32 32 C42 32, 48 38, 48 50" />
                <path d="M12 50 C12 34, 20 26, 32 26 C44 26, 52 34, 52 50" />
                <path d="M8 50 C8 30, 18 20, 32 20 C46 20, 56 30, 56 50" />
                <path d="M24 50 C24 46, 28 44, 32 44 C36 44, 40 46, 40 50" />
                <path d="M28 50 C28 48, 30 47, 32 47 C34 47, 36 48, 36 50" />
                <path d="M32 50 L32 49" />
              </svg>
              
              {/* Rotating target ring */}
              {!isFingerDetected && (
                <div 
                  className="absolute w-20 h-20 border border-dashed border-emerald-400/15 rounded-full animate-spin" 
                  style={{ animationDuration: '20s' }}
                />
              )}
            </div>
            
            {/* Laser scanning line */}
            {!isFingerDetected && (
              <div 
                className="absolute left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-emerald-400/80 to-transparent shadow-[0_0_8px_rgba(52,211,153,0.6)]"
                style={{
                  top: '50%',
                  animation: 'scan 3s infinite ease-in-out'
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* Subtle Pointer HUD Card */}
      {isCameraOn && layoutInfo && (
        <div 
          className="absolute left-1/2 -translate-x-1/2 pointer-events-none flex flex-col items-center"
          style={{
            top: layoutInfo.floorCenterY - 110,
            width: '260px',
            transition: 'top 0.3s ease-in-out',
            zIndex: 4,
          }}
        >
          <div 
            className={`border px-3 py-1.5 rounded-xl font-mono text-[9px] tracking-wider text-center transition-all duration-500 shadow-lg ${
              isFingerDetected 
                ? (diagnostics?.acquisitionStage === 'READY' 
                    ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-400' 
                    : 'bg-cyan-950/80 border-cyan-500/40 text-cyan-400')
                : 'bg-amber-950/80 border-amber-500/40 text-amber-400'
            }`}
          >
            {isFingerDetected ? (
              diagnostics?.acquisitionStage === 'READY' ? (
                <div className="flex items-center gap-1.5 justify-center">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                  <span>ANALIZANDO SEÑAL CARDIACA</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 justify-center">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  <span>ESTABILIZANDO CONTACTO...</span>
                </div>
              )
            ) : (
              <div className="flex items-center gap-1.5 justify-center animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
                <span>CUBRE LA CÁMARA TRASERA CON TU DEDO</span>
              </div>
            )}
          </div>
          <div className="w-[1px] h-[35px] border-l border-dashed border-slate-600/40 mt-1" />
        </div>
      )}

      {/* Capa de señal: grillas + onda PPG, sin máscara, opacidad plena. */}
      <canvas
        ref={waveCanvasRef}
        className="pointer-events-none absolute inset-0 w-full h-full"
        style={{ zIndex: 3 }}
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
