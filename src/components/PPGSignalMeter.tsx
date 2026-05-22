import React, { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react';
import { CircularBuffer } from '../utils/CircularBuffer';
import { calculateHRV, isPhysiologicalRR } from '../utils/physio';
import {
  DISPLAY_SMOOTH_ALPHAS,
  lerpDisplayValue,
} from '@/lib/measurement/displaySmoothing';
import {
  COLORS,
  FONT_MONO,
  TARGET_FPS,
  WINDOW_MS,
  BUFFER_SIZE,
  TREND_WINDOW_MS,
  TREND_MAX_POINTS,
  BEAT_HISTORY_MAX,
  VISUAL_DELAY_MS,
  AMP_ATTACK,
  AMP_RELEASE,
  RR_TACHO_H,
  PpgLayout,
  PpgRenderState,
  drawBackground,
  drawHeader,
  drawMetricsBar,
  drawECGGrid,
  drawSignal,
  drawTrendStrip,
  drawFooter,
} from '@/lib/ui/ppgCanvasRenderer';
import { PulseIndicator } from './PulseIndicator';
import { ActionButtons } from './ActionButtons';

interface PPGSignalMeterProps {
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

const PPGSignalMeter = ({
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
}: PPGSignalMeterProps) => {
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

  const sweepPulseRef = useRef(0);
  const lastPeakTimeRef = useRef(0);
  const [showPulse, setShowPulse] = useState(false);

  const beatArrhythmiaRef = useRef(false);
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
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
    const buttonsH = 48;
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

    const frameTime = 1000 / TARGET_FPS;
    let lastRenderTime = 0;

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
      };

      drawBackground(ctx, layoutRef.current.width, layoutRef.current.height);
      drawHeader(ctx, renderState);
      drawMetricsBar(ctx, renderState);
      drawECGGrid(ctx, renderState);
      drawSignal(ctx, renderState);
      drawTrendStrip(ctx, renderState);
      drawFooter(ctx, renderState);

      sweepPulseRef.current = renderState.sweepPulse;
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
};

export default PPGSignalMeter;
