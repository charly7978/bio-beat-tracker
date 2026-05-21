import React, { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react';
import { Heart, Activity } from 'lucide-react';
import { CircularBuffer, PPGDataPoint } from '../utils/CircularBuffer';
import { calculateHRV, isPhysiologicalRR } from '../utils/physio';
import {
  DISPLAY_SMOOTH_ALPHAS,
  lerpDisplayValue,
} from '@/lib/measurement/displaySmoothing';
import {
  buildRhythmPanel,
  formatContactState,
  ibiSegmentLabel,
  levelColor,
} from '@/lib/ui/ppgMonitorClinical';

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
    /** Telemetría del ensemble Elgendi + Pan–Tompkins (desde HeartBeatProcessor) */
    peakDetection?: {
      confidence?: number;
      agreement?: { elgendi?: number; panTompkins?: number; spectral?: number };
      fusedPeakTimes?: number[];
      elgendiPeakTimes?: number[];
      panTompkinsPeakTimes?: number[];
      fusedPeakCount?: number;
      rejectedPeaks?: Array<{ index: number; reason: string; detector: string }>;
    };
  };
}

const TARGET_FPS = 60;            // (ANTES 30)
const WINDOW_MS = 2000;          // 2.0s ondas aún más holgadas (antes 3600)
const BUFFER_SIZE = 2500;        // Incrementar buffer para soportar hasta 300 FPS sin perder la cola
const TREND_WINDOW_MS = 60_000;  // 60 s de tendencia BPM
const TREND_MAX_POINTS = 240;
const BEAT_HISTORY_MAX = 30;
const VISUAL_DELAY_MS = 166;
const AMP_ATTACK = 0.44;
const AMP_RELEASE = 0.56;
const RR_TACHO_H = 34;

const COLORS = {
  BG_TOP: '#06090f',
  BG_BOTTOM: '#020409',
  PANEL_BG: 'rgba(10, 18, 30, 0.92)',
  PANEL_BORDER: 'rgba(34, 197, 94, 0.32)',
  PANEL_BORDER_DIM: 'rgba(148, 163, 184, 0.18)',
  GRID_MINOR: 'rgba(255, 255, 255, 0.05)',
  GRID_MAJOR: 'rgba(255, 255, 255, 0.12)',
  GRID_SEC: 'rgba(255, 255, 255, 0.20)',
  SCANLINE: 'rgba(255, 255, 255, 0.012)',
  BASELINE: 'rgba(255, 255, 255, 0.25)',
  SIGNAL: '#22c55e',
  SIGNAL_GLOW: 'rgba(34, 197, 94, 0.45)',
  SIGNAL_ARR: '#ef4444',
  SIGNAL_ARR_GLOW: 'rgba(239, 68, 68, 0.45)',
  PEAK_NORMAL: '#3b82f6',
  PEAK_ARR: '#ef4444',
  VALLEY: '#64748b',
  TEXT_PRIMARY: '#22c55e',
  TEXT_SECONDARY: '#94a3b8',
  TEXT_DIM: 'rgba(255, 255, 255, 0.6)',
  TEXT_WARN: '#f59e0b',
  TEXT_DANGER: '#ef4444',
  TEXT_INFO: '#67e8f9',
  TEXT_VIOLET: '#a78bfa',
  SPO2: '#06b6d4',
  BP: '#818cf8',
};

const FONT_MONO = '"SF Mono", Consolas, "Roboto Mono", monospace';

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

  // Latest props captured via ref so the RAF loop doesn't re-create per render
  const propsRef = useRef({ 
    value, quality, isFingerDetected, isMonitoring, arrhythmiaStatus, 
    arrhythmiaCount, preserveResults, isPeak, bpm, spo2, rrIntervals, 
    rawArrhythmiaData,
    elapsedTime,
    perfusionIndex,
    pressure,
    bpStatus,
    contactState,
    acquisitionStatus,
    diagnostics,
  });

  const sweepPulseRef = useRef(0);
  const lastPeakTimeRef = useRef(0);
  const [showPulse, setShowPulse] = useState(false);

  // Beat tracking
  const beatArrhythmiaRef = useRef(false);
  const lastArrhythmiaCountRef = useRef(0);
  const beatHistoryRef = useRef<{ isArrhythmia: boolean; time: number; rr: number }[]>([]);

  // Amplitude auto-scaling
  const amplitudeStatsRef = useRef({ min: -50, max: 50, range: 100 });

  // Derived metrics
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

  // Layout — recomputed on resize, DPR-aware
  const layoutRef = useRef({
    dpr: 1,
    width: 0,
    height: 0,
    header: { x: 0, y: 0, w: 0, h: 0 },
    metrics: { x: 0, y: 0, w: 0, h: 0 },
    plot: { x: 0, y: 0, w: 0, h: 0, centerY: 0 },
    trend: { x: 0, y: 0, w: 0, h: 0 },
    footer: { x: 0, y: 0, w: 0, h: 0 },
  });

  // === Sync props into ref + compute HRV / trends ===
  useEffect(() => {
    propsRef.current = { 
      value, quality, isFingerDetected, isMonitoring, arrhythmiaStatus, 
      arrhythmiaCount, preserveResults, isPeak, bpm, spo2, rrIntervals, 
      rawArrhythmiaData,
      elapsedTime,
      perfusionIndex,
      pressure,
      bpStatus,
      contactState,
      acquisitionStatus,
      diagnostics,
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
    waveGainRef.current = waveGainRef.current * 0.82 + weakTarget * 0.18;

    if (bpm > 30 && bpm < 220 && nowMs - lastBpmSampleRef.current > 500) {
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
      pendingTrendArrRef.current = false; // Reset for next point

      // Drop trend points older than window
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
    value,
    quality,
    isFingerDetected,
    arrhythmiaStatus,
    preserveResults,
    isPeak,
    bpm,
    spo2,
    rrIntervals,
    rawArrhythmiaData,
    elapsedTime,
    perfusionIndex,
    pressure,
    bpStatus,
    arrhythmiaCount,
    isMonitoring,
    contactState,
    acquisitionStatus,
    diagnostics,
  ]);

  // Pulse animation on peak (UI overlay only)
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

  // Initialize ring buffer once
  useEffect(() => {
    if (!dataBufferRef.current) {
      dataBufferRef.current = new CircularBuffer(BUFFER_SIZE);
    }
  }, []);

  // Clear buffer when results preserved & finger removed
  useEffect(() => {
    if (preserveResults && !isFingerDetected) {
      dataBufferRef.current?.clear();
    }
  }, [preserveResults, isFingerDetected]);

  // === DPR-aware sizing with ResizeObserver ===
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

    // Compute zones in CSS pixels.
    // Heights are proportional, but with sensible minima.
    const header = { x: 0, y: 0, w: cssW, h: 36 };
    const metricsH = Math.max(92, Math.min(108, Math.round(cssH * 0.11)));
    const metrics = { x: 0, y: header.h, w: cssW, h: metricsH };

    // Franja de tendencia compacta → más altura para el monitor (onda PPG).
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

    layoutRef.current = { dpr, width: cssW, height: cssH, header, metrics, plot, trend, footer };
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

  // ============= DRAWING HELPERS =============

  const drawBackground = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width: W, height: H } = layoutRef.current;
    
    // 1. Pure Black Background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);

    // 2. Scanline overlay (CRT effect)
    ctx.fillStyle = COLORS.SCANLINE;
    for (let y = 0; y < H; y += 3) {
      ctx.fillRect(0, y, W, 1);
    }
  }, []);

  const drawHeader = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const { header } = layoutRef.current;
    const { quality, isFingerDetected: detected, elapsedTime: elapsed } = propsRef.current;

    ctx.fillStyle = 'rgba(8, 16, 28, 0.7)';
    ctx.fillRect(header.x, header.y, header.w, header.h);
    ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
    ctx.beginPath();
    ctx.moveTo(0, header.y + header.h);
    ctx.lineTo(header.w, header.y + header.h);
    ctx.stroke();

    // Status dot + label
    const pulse = (Math.sin(now / 400) + 1) / 2;
    const statusColor = isMonitoring ? COLORS.SIGNAL : (preserveResults ? COLORS.TEXT_INFO : COLORS.TEXT_DIM);
    ctx.beginPath();
    ctx.arc(16, header.y + 18, 5, 0, Math.PI * 2);
    ctx.fillStyle = isMonitoring
      ? `rgba(34, 197, 94, ${0.55 + pulse * 0.45})`
      : statusColor;
    ctx.fill();

    ctx.font = `bold 11px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.textAlign = 'left';
    ctx.fillText(isMonitoring ? 'MONITOREANDO' : (preserveResults ? 'RESULTADOS' : 'EN ESPERA'), 28, header.y + 22);

    // Time + elapsed
    const d = new Date(now);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const t = Math.max(0, Math.floor(elapsed || 0));
    const em = String(Math.floor(t / 60)).padStart(2, '0');
    const es = String(t % 60).padStart(2, '0');

    ctx.font = `11px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'center';
    ctx.fillText(`${hh}:${mm}:${ss}`, header.w / 2, header.y + 22);

    // Quality on the right
    ctx.textAlign = 'right';
    const qColor = quality > 60 ? COLORS.TEXT_PRIMARY : quality > 30 ? COLORS.TEXT_WARN : (quality > 0 ? COLORS.TEXT_DANGER : COLORS.TEXT_DIM);
    ctx.fillStyle = qColor;
    ctx.fillText(`SQI ${Math.round(quality)}%`, header.w - 16, header.y + 22);

    // Elapsed badge (left side, secondary)
    if (isMonitoring) {
      const elapStr = `⏱ ${em}:${es}`;
      ctx.font = `11px ${FONT_MONO}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.TEXT_INFO;
      ctx.fillText(elapStr, 160, header.y + 22);
    }

    // Finger detect indicator
    ctx.font = `10px ${FONT_MONO}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = detected ? COLORS.TEXT_PRIMARY : COLORS.TEXT_DIM;
    ctx.fillText(detected ? '● DEDO OK' : '○ SIN DEDO', header.w - 110, header.y + 22);

    // TECHNICAL OVERLAY — no parpadear LOW si la señal sigue siendo pulsátil
    const diag = propsRef.current.diagnostics;
    const hideLowFlicker =
      diag?.status === 'LOW_SIGNAL_QUALITY' &&
      diag.hasPulsatility === true;
    const placementHint =
      typeof diag?.placementHint === 'string' ? diag.placementHint : '';
    if (placementHint && detected) {
      ctx.fillStyle = COLORS.TEXT_INFO;
      ctx.font = `9px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(placementHint, header.w / 2, header.y + 12);
    } else if (
      diag?.status &&
      diag.status !== 'VALID' &&
      diag.status !== 'WARMUP' &&
      !hideLowFlicker
    ) {
      ctx.fillStyle = COLORS.TEXT_DANGER;
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(`⚠ ${diag.status}`, header.w / 2, header.y + 12);
    }
  }, [isMonitoring, preserveResults]);

  const drawMetricsBar = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const { metrics } = layoutRef.current;
    const { pressure, perfusionIndex: pi, arrhythmiaStatus: arr, arrhythmiaCount: arrCnt } = propsRef.current;

    // Background row
    ctx.fillStyle = 'rgba(6, 12, 22, 0.85)';
    ctx.fillRect(metrics.x, metrics.y, metrics.w, metrics.h);
    ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
    ctx.beginPath();
    ctx.moveTo(0, metrics.y + metrics.h);
    ctx.lineTo(metrics.w, metrics.y + metrics.h);
    ctx.stroke();

    // 3 columnas: HR | SpO2 | BP
    const colW = metrics.w / 3;

    // Divisores verticales
    ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(colW, metrics.y + 8); ctx.lineTo(colW, metrics.y + metrics.h - 8);
    ctx.moveTo(colW * 2, metrics.y + 8); ctx.lineTo(colW * 2, metrics.y + metrics.h - 8);
    ctx.stroke();

    // === HR ===
    const { isFingerDetected: fingerOn, preserveResults: preserve } = propsRef.current;
    const dispBpm = Math.round(
      (!fingerOn && !preserve ? 0 : displayBpmRef.current) || 0,
    );
    const dispSpo2 = Math.round(displaySpo2Ref.current);
    const dispSys = Math.round(displaySysRef.current);
    const dispDia = Math.round(displayDiaRef.current);
    const hrColor = dispBpm <= 0 ? COLORS.TEXT_DIM
      : dispBpm < 50 ? COLORS.TEXT_DANGER
      : dispBpm < 60 ? COLORS.TEXT_WARN
      : dispBpm <= 100 ? COLORS.TEXT_PRIMARY
      : dispBpm <= 120 ? COLORS.TEXT_WARN
      : COLORS.TEXT_DANGER;

    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'left';
    ctx.fillText('FRECUENCIA CARDÍACA', 16, metrics.y + 26); // Shifted down

    ctx.font = `bold 56px ${FONT_MONO}`;
    ctx.fillStyle = hrColor;
    const heartPulse = isMonitoring && dispBpm > 30 ? (Math.sin(now / (60000 / Math.max(60, dispBpm)) * 2 * Math.PI) + 1) / 2 : 0;
    ctx.save();
    if (heartPulse > 0) {
      ctx.shadowColor = hrColor;
      ctx.shadowBlur = 6 + heartPulse * 6;
    }
    ctx.fillText(dispBpm > 0 ? dispBpm.toString() : '--', 16, metrics.y + 72);
    ctx.restore();

    ctx.font = `12px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('BPM', 16, metrics.y + 90);

    // Classification
    let hrLabel = '';
    if (dispBpm > 0) {
      if (dispBpm < 50) hrLabel = 'BRADICARDIA SEVERA';
      else if (dispBpm < 60) hrLabel = 'BRADICARDIA';
      else if (dispBpm <= 100) hrLabel = 'NORMAL (SINUSAL)';
      else if (dispBpm <= 120) hrLabel = 'TAQUICARDIA LEVE';
      else if (dispBpm <= 150) hrLabel = 'TAQUICARDIA';
      else hrLabel = 'TAQUICARDIA SEVERA';
    }
    if (hrLabel) {
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.fillStyle = hrColor;
      ctx.textAlign = 'right';
      ctx.fillText(hrLabel, colW - 12, metrics.y + 90);
    }

    // BPM min/max mini-bar at top right of col
    const s = bpmStatsRef.current;
    if (s.n > 0) {
      ctx.font = `9px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_DIM;
      ctx.textAlign = 'right';
      ctx.fillText(`min:${s.min} max:${s.max}`, colW - 12, metrics.y + 26);
    }

    // === SpO2 ===
    const spo2Color = dispSpo2 <= 0 ? COLORS.TEXT_DIM
      : dispSpo2 >= 95 ? COLORS.SPO2
      : dispSpo2 >= 90 ? COLORS.TEXT_WARN
      : COLORS.TEXT_DANGER;

    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'left';
    ctx.fillText('SATURACIÓN O₂', colW + 16, metrics.y + 26);

    ctx.font = `bold 56px ${FONT_MONO}`;
    ctx.fillStyle = spo2Color;
    ctx.fillText(dispSpo2 > 0 ? dispSpo2.toString() : '--', colW + 16, metrics.y + 72);

    ctx.font = `12px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('%', colW + 16 + (dispSpo2 > 0 ? 64 : 32), metrics.y + 72);

    let spLabel = '';
    if (dispSpo2 > 0) {
      if (dispSpo2 >= 95) spLabel = 'NORMOXIA';
      else if (dispSpo2 >= 90) spLabel = 'HIPOXEMIA LEVE';
      else if (dispSpo2 >= 85) spLabel = 'HIPOXEMIA MODERADA';
      else spLabel = 'HIPOXEMIA SEVERA';
    }
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = spo2Color;
    ctx.textAlign = 'right';
    if (spLabel) ctx.fillText(spLabel, colW * 2 - 12, metrics.y + 90);

    // Perfusion Index — sub-line on SpO2 column
    if (pi > 0) {
      ctx.font = `9px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_DIM;
      ctx.textAlign = 'left';
      ctx.fillText(`PI ${(pi * 100).toFixed(2)}%`, colW + 16, metrics.y + 90);
    }

    // === BP ===
    const sys = dispSys > 0 ? dispSys : pressure?.systolic || 0;
    const dia = dispDia > 0 ? dispDia : pressure?.diastolic || 0;
    const map = sys > 0 && dia > 0 ? Math.round(dia + (sys - dia) / 3) : 0;
    const pp = sys > 0 && dia > 0 ? sys - dia : 0;
    const _bpConf = pressure?.confidence;

    const bpColor = sys <= 0 ? COLORS.TEXT_DIM
      : sys >= 140 || dia >= 90 ? COLORS.TEXT_DANGER
      : sys >= 130 || dia >= 80 ? COLORS.TEXT_WARN
      : sys < 90 || dia < 60 ? COLORS.TEXT_WARN
      : COLORS.BP;

    // Shift left slightly (+4 instead of +16) to avoid clipping on narrow screens
    const bpX = colW * 2 + 4; 

    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.textAlign = 'left';
    ctx.fillText('PRESIÓN ART.', bpX, metrics.y + 26);

    ctx.font = `bold 28px ${FONT_MONO}`; // Reduced to fit safely
    ctx.fillStyle = bpColor;
    const bpPending =
      propsRef.current.isMonitoring &&
      sys <= 0 &&
      (propsRef.current.bpStatus === 'INSUFFICIENT_WINDOW' ||
        propsRef.current.bpStatus === 'NO_VALID_SIGNAL' ||
        propsRef.current.bpStatus === 'WARMUP');
    ctx.fillText(
      sys > 0 ? `${sys}/${dia}` : bpPending ? '···' : '--/--',
      bpX,
      metrics.y + 68,
    );

    ctx.font = `12px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText('mmHg', bpX, metrics.y + 90);

    if (sys > 0) {
      ctx.font = `9px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_SECONDARY;
      ctx.textAlign = 'right';
      ctx.fillText(`MAP ${map} · PP ${pp}`, metrics.w - 12, metrics.y + 68);

      let bpLabel = '';
      if (sys >= 140 || dia >= 90) bpLabel = 'HIPERTENSIÓN';
      else if (sys >= 130 || dia >= 80) bpLabel = 'ELEVADA';
      else if (sys < 90 || dia < 60) bpLabel = 'HIPOTENSIÓN';
      else bpLabel = 'NORMAL';
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.fillStyle = bpColor;
      ctx.fillText(bpLabel, metrics.w - 12, metrics.y + 102);
    }

    const rhythmBanner = buildRhythmPanel(
      arr,
      arrCnt ?? 0,
      propsRef.current.rrIntervals ?? [],
      hrvDisplayRef.current,
    );
    if (rhythmBanner.level === 'danger' || rhythmBanner.level === 'warn') {
      ctx.fillStyle =
        rhythmBanner.level === 'danger' ? 'rgba(127, 29, 29, 0.75)' : 'rgba(120, 53, 15, 0.65)';
      ctx.fillRect(metrics.x + 12, metrics.y + 2, metrics.w - 24, 18);
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.fillStyle = rhythmBanner.level === 'danger' ? '#fecaca' : '#fde68a';
      ctx.textAlign = 'center';
      ctx.fillText(rhythmBanner.title, metrics.w / 2, metrics.y + 14);
    }

    // TELEMETRY (Phase 11) + ensemble de picos
    const fps = propsRef.current.diagnostics?.sqm?.fpsEffective || 0;
    const jitter = propsRef.current.diagnostics?.sqm?.timestampJitterMs || 0;
    const pd = propsRef.current.diagnostics?.peakDetection as
      | { confidence?: number; agreement?: { elgendi?: number; panTompkins?: number } }
      | undefined;
    if (fps > 0) {
      ctx.font = `8px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_DIM;
      ctx.textAlign = 'right';
      ctx.fillText(`${fps.toFixed(1)} FPS · Δ${jitter.toFixed(1)}ms`, metrics.w - 12, metrics.y + 12);
    }
    if (pd && typeof pd.confidence === 'number' && pd.confidence > 0) {
      const ae = pd.agreement?.elgendi ?? 0;
      const ap = pd.agreement?.panTompkins ?? 0;
      ctx.font = `8px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_INFO;
      ctx.textAlign = 'right';
      ctx.fillText(
        `Picos ensemble ${(pd.confidence * 100).toFixed(0)}% · E${(ae * 100).toFixed(0)}/PT${(ap * 100).toFixed(0)}`,
        metrics.w - 12,
        metrics.y + (fps > 0 ? 24 : 12)
      );
    }
  }, [isMonitoring]);

  const drawECGGrid = useCallback((ctx: CanvasRenderingContext2D) => {
    const { plot } = layoutRef.current;

    // Plot background (subtle clinical vignette)
    const grad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
    grad.addColorStop(0, 'rgba(6, 12, 22, 0.70)');
    grad.addColorStop(0.5, 'rgba(10, 18, 30, 0.60)');
    grad.addColorStop(1, 'rgba(6, 12, 22, 0.70)');
    ctx.fillStyle = grad;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    // ECG paper grid: 1mm minor (~5px), 5mm major (~25px), 25mm/s
    // Use a scale that fits the plot height/width.
    const pxPerMm = Math.max(4, Math.min(8, plot.h / 30));
    const minor = pxPerMm;
    const major = pxPerMm * 5;

    // Minor (1mm)
    ctx.strokeStyle = COLORS.GRID_MINOR;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = plot.x; x <= plot.x + plot.w; x += minor) {
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
    }
    for (let y = plot.y; y <= plot.y + plot.h; y += minor) {
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
    }
    ctx.stroke();

    // Major (5mm)
    ctx.strokeStyle = COLORS.GRID_MAJOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = plot.x; x <= plot.x + plot.w; x += major) {
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
    }
    for (let y = plot.y; y <= plot.y + plot.h; y += major) {
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
    }
    ctx.stroke();

    // Second markers (1s = 25 mm at 25 mm/s sweep)
    const oneSec = 25 * pxPerMm;
    ctx.strokeStyle = COLORS.GRID_SEC;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = plot.x + plot.w; x >= plot.x; x -= oneSec) {
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
    }
    ctx.stroke();

    // Baseline
    ctx.strokeStyle = COLORS.BASELINE;
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.centerY);
    ctx.lineTo(plot.x + plot.w, plot.centerY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Plot border w/ corner ticks
    ctx.strokeStyle = COLORS.PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

    // Seconds labels along bottom (White)
    const seconds = Math.floor(WINDOW_MS / 1000);
    ctx.font = `bold 9px ${FONT_MONO}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    for (let s = 0; s <= seconds; s++) {
      const x = plot.x + plot.w - (s / seconds) * plot.w;
      ctx.fillText(`-${s}s`, x, plot.y + plot.h + 12);
    }

    // Y axis labels (amplitude) - White
    const stats = amplitudeStatsRef.current;
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 9px ${FONT_MONO}`;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = plot.y + (i / 4) * plot.h;
      const val = stats.max - (i / 4) * stats.range;
      ctx.fillText(val.toFixed(0), plot.x - 4, y + 3);
    }

    // Sweep label
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillText('25 mm/s · 0.3–5 Hz · PPG-RG', plot.x + 4, plot.y - 4);
  }, []);

  const drawSignal = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const buffer = dataBufferRef.current;
    if (!buffer) return;
    const { plot } = layoutRef.current;
    const { value: signalValue, isFingerDetected: detected, arrhythmiaStatus: _arrStatus, preserveResults: preserve, isPeak: peak } = propsRef.current;

    if (preserve && !detected) return;

    const scaledValue = signalValue * waveGainRef.current;
    if (peak) sweepPulseRef.current = 1;

    if (peak) {
      const currentCount = propsRef.current.arrhythmiaCount || 0;
      // Calcular RR real UNA sola vez: 0 si todavía no hay intervalos válidos.
      const rrArr = propsRef.current.rrIntervals;
      const lastRR = rrArr && rrArr.length > 0 ? rrArr[rrArr.length - 1] : 0;

      if (currentCount > lastArrhythmiaCountRef.current) {
        beatArrhythmiaRef.current = true;
        lastArrhythmiaCountRef.current = currentCount;
        pendingTrendArrRef.current = true; // Capturar para el gráfico de tendencia histórico
        const retroRR = lastRR > 0 ? lastRR : 800;
        const retroDuration = Math.min(Math.max(retroRR, 400), 1500);
        buffer.markArrhythmiaBack(retroDuration);
      } else {
        beatArrhythmiaRef.current = false;
      }
      const storedRR = isPhysiologicalRR(lastRR) ? Math.round(lastRR) : 0;
      beatHistoryRef.current.push({
        isArrhythmia: beatArrhythmiaRef.current,
        time: now - VISUAL_DELAY_MS, // Sincronizar el latido con el pico real
        rr: storedRR,
      });
      if (beatHistoryRef.current.length > BEAT_HISTORY_MAX) {
        beatHistoryRef.current = beatHistoryRef.current.slice(-BEAT_HISTORY_MAX);
      }
    }
    const currentIsArrhythmia = beatArrhythmiaRef.current;

    buffer.push({ time: now, value: scaledValue, isArrhythmia: currentIsArrhythmia });

    const points = buffer.getPoints();
    if (points.length > 30) {
      const recentStart = Math.max(0, points.length - 150);
      let mn = Infinity, mx = -Infinity;
      for (let i = recentStart; i < points.length; i++) {
        const v = points[i].value;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const range = Math.max(24, mx - mn);
      const stats = amplitudeStatsRef.current;
      const targetMin = mn - range * 0.1;
      const targetMax = mx + range * 0.1;
      const expanding = targetMax - targetMin > stats.range;
      const blend = expanding ? AMP_ATTACK : AMP_RELEASE;
      stats.min = stats.min * (1 - blend) + targetMin * blend;
      stats.max = stats.max * (1 - blend) + targetMax * blend;
      stats.range = stats.max - stats.min;
    }

    const stats = amplitudeStatsRef.current;
    if (points.length < 2) return;

    // Guard: si la señal es plana (range≈0 por EMA con DC constante),
    // forzamos un mínimo para evitar división por cero → NaN/Infinity en Y.
    const safeRange = stats.range > 1 ? stats.range : 1;

    const wavePadTop = 12;
    const wavePadBot = RR_TACHO_H + 12;
    const waveH = Math.max(40, plot.h - wavePadTop - wavePadBot);
    const waveBaseY = plot.y + wavePadTop + waveH;

    const coords: { x: number; y: number; isArr: boolean }[] = [];
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const age = now - pt.time - VISUAL_DELAY_MS;
      if (age > WINDOW_MS) continue;
      const x = plot.x + plot.w - (age * plot.w / WINDOW_MS);
      if (x < plot.x || x > plot.x + plot.w) continue;
      const y = plot.y + wavePadTop + ((stats.max - pt.value) / safeRange) * waveH;
      coords.push({ x, y, isArr: pt.isArrhythmia });
    }

    if (coords.length < 2) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();

    let seg = 0;
    while (seg < coords.length) {
      if (!coords[seg].isArr) {
        seg++;
        continue;
      }
      let end = seg;
      while (end < coords.length && coords[end].isArr) end++;
      const x0 = coords[seg].x;
      const x1 = coords[end - 1].x;
      ctx.fillStyle = 'rgba(127, 29, 29, 0.26)';
      ctx.fillRect(x0, plot.y + wavePadTop, Math.max(3, x1 - x0 + 1), waveH);
      seg = end;
    }

    const fillSegment = (startIdx: number, endIdx: number, arrhythmia: boolean) => {
      if (endIdx <= startIdx) return;
      ctx.beginPath();
      ctx.moveTo(coords[startIdx].x, waveBaseY);
      for (let k = startIdx; k < endIdx; k++) ctx.lineTo(coords[k].x, coords[k].y);
      ctx.lineTo(coords[endIdx - 1].x, waveBaseY);
      ctx.closePath();
      const fillGrad = ctx.createLinearGradient(0, plot.y + wavePadTop, 0, waveBaseY);
      if (arrhythmia) {
        fillGrad.addColorStop(0, 'rgba(248, 113, 113, 0.22)');
        fillGrad.addColorStop(1, 'rgba(127, 29, 29, 0.04)');
      } else {
        fillGrad.addColorStop(0, 'rgba(34, 197, 94, 0.16)');
        fillGrad.addColorStop(1, 'rgba(34, 197, 94, 0.02)');
      }
      ctx.fillStyle = fillGrad;
      ctx.fill();
    };

    let fi = 0;
    while (fi < coords.length - 1) {
      const arrSeg = coords[fi].isArr;
      let fj = fi;
      while (fj < coords.length - 1 && coords[fj].isArr === arrSeg) fj++;
      fillSegment(fi, fj + 1, arrSeg);
      fi = fj;
    }

    // Stroke segments — Smooth electric curve
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Función auxiliar para dibujar un segmento suave
    const drawSmoothSegment = (startIdx: number, endIdx: number) => {
      ctx.beginPath();
      ctx.moveTo(coords[startIdx].x, coords[startIdx].y);
      for (let k = startIdx; k < endIdx - 1; k++) {
        const xc = (coords[k].x + coords[k + 1].x) / 2;
        const yc = (coords[k].y + coords[k + 1].y) / 2;
        ctx.quadraticCurveTo(coords[k].x, coords[k].y, xc, yc);
      }
      ctx.lineTo(coords[endIdx - 1].x, coords[endIdx - 1].y);
    };

    let i = 0;
    while (i < coords.length - 1) {
      const isArr = coords[i].isArr;
      let j = i;
      while (j < coords.length - 1 && coords[j].isArr === isArr) {
        j++;
      }
      
      // 1. Primary Neon Glow (Outer)
      drawSmoothSegment(i, j + 1 > coords.length ? j : j + 1);
      ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.35)' : 'rgba(34, 197, 94, 0.35)';
      ctx.lineWidth = 6;
      ctx.shadowColor = isArr ? COLORS.SIGNAL_ARR_GLOW : COLORS.SIGNAL_GLOW;
      ctx.shadowBlur = 15;
      ctx.stroke();

      // 2. High-Intensity Core (Inner)
      ctx.strokeStyle = isArr ? '#fecaca' : '#bbf7d0'; 
      ctx.lineWidth = 2.2;
      ctx.shadowBlur = 3;
      ctx.stroke();
      
      i = j;
    }

    sweepPulseRef.current *= 0.9;
    const head = coords[coords.length - 1];
    if (head) {
      const pulse = Math.max(sweepPulseRef.current, 0.08);
      ctx.strokeStyle = head.isArr ? 'rgba(248, 113, 113, 0.55)' : 'rgba(34, 197, 94, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(head.x, plot.y + wavePadTop);
      ctx.lineTo(head.x, plot.y + plot.h - wavePadBot + 8);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(head.x, head.y, 4 + pulse * 6, 0, Math.PI * 2);
      ctx.fillStyle = head.isArr ? 'rgba(248, 113, 113, 0.2)' : 'rgba(34, 197, 94, 0.2)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(head.x, head.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = head.isArr ? COLORS.SIGNAL_ARR_GLOW : COLORS.SIGNAL_GLOW;
      ctx.shadowBlur = 8 + pulse * 10;
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // Peaks markers
    const visiblePeaks: { x: number; y: number; isArr: boolean; time: number }[] = [];
    for (const beat of beatHistoryRef.current) {
      const age = now - beat.time - VISUAL_DELAY_MS;
      if (age > WINDOW_MS || age < 0) continue;
      const x = plot.x + plot.w - (age * plot.w / WINDOW_MS);
      if (x < plot.x || x > plot.x + plot.w) continue;
      // Find nearest point
      let nearestPt: PPGDataPoint | null = null;
      let minDist = Infinity;
      for (const pt of points) {
        const d = Math.abs(pt.time - beat.time);
        if (d < minDist) { minDist = d; nearestPt = pt; }
      }
      if (nearestPt && minDist < 200) {
        const y = plot.y + wavePadTop + ((stats.max - nearestPt.value) / safeRange) * waveH;
        visiblePeaks.push({ x, y, isArr: beat.isArrhythmia, time: beat.time });
      }
    }

    // Marcadores de detectores (Elgendi / Pan–Tompkins / fusión ensemble)
    const pdOverlay = propsRef.current.diagnostics?.peakDetection;
    const detectorPeaks: { x: number; y: number; kind: 'elgendi' | 'pan' | 'fused' }[] = [];
    const mapPeakTime = (peakTime: number, kind: 'elgendi' | 'pan' | 'fused') => {
      const age = now - peakTime - VISUAL_DELAY_MS;
      if (age > WINDOW_MS || age < 0) return;
      const x = plot.x + plot.w - (age * plot.w / WINDOW_MS);
      if (x < plot.x || x > plot.x + plot.w) return;
      let nearestPt: PPGDataPoint | null = null;
      let minDist = Infinity;
      for (const pt of points) {
        const d = Math.abs(pt.time - peakTime);
        if (d < minDist) {
          minDist = d;
          nearestPt = pt;
        }
      }
      if (nearestPt && minDist < 280) {
        const y = plot.y + wavePadTop + ((stats.max - nearestPt.value) / safeRange) * waveH;
        detectorPeaks.push({ x, y, kind });
      }
    };
    if (pdOverlay?.elgendiPeakTimes) {
      for (const t of pdOverlay.elgendiPeakTimes) mapPeakTime(t, 'elgendi');
    }
    if (pdOverlay?.panTompkinsPeakTimes) {
      for (const t of pdOverlay.panTompkinsPeakTimes) mapPeakTime(t, 'pan');
    }
    if (pdOverlay?.fusedPeakTimes) {
      for (const t of pdOverlay.fusedPeakTimes) mapPeakTime(t, 'fused');
    }

    for (const dp of detectorPeaks) {
      ctx.save();
      if (dp.kind === 'elgendi') {
        ctx.fillStyle = '#22d3ee';
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.55)';
        ctx.beginPath();
        ctx.moveTo(dp.x, dp.y - 5);
        ctx.lineTo(dp.x - 4, dp.y + 3);
        ctx.lineTo(dp.x + 4, dp.y + 3);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (dp.kind === 'pan') {
        ctx.fillStyle = '#a78bfa';
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.55)';
        ctx.fillRect(dp.x - 3.5, dp.y - 3.5, 7, 7);
        ctx.strokeRect(dp.x - 3.5, dp.y - 3.5, 7, 7);
      } else {
        ctx.beginPath();
        ctx.arc(dp.x, dp.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.PEAK_NORMAL;
        ctx.fill();
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.7)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Leyenda compacta (solo si hay marcadores de detectores)
    if (detectorPeaks.length > 0 && propsRef.current.isMonitoring) {
      const lx = plot.x + 6;
      const ly = plot.y + plot.h - 38;
      ctx.font = `8px ${FONT_MONO}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#22d3ee';
      ctx.fillText('▲ Elgendi', lx, ly);
      ctx.fillStyle = '#a78bfa';
      ctx.fillText('■ Pan–Tompkins', lx + 58, ly);
      ctx.fillStyle = COLORS.PEAK_NORMAL;
      ctx.fillText('● Fusión', lx + 138, ly);
    }

    for (const p of visiblePeaks) {
      // Vertical ref line
      ctx.save();
      ctx.strokeStyle = p.isArr ? 'rgba(239,68,68,0.30)' : 'rgba(34,197,94,0.22)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(p.x, plot.y);
      ctx.lineTo(p.x, plot.y + plot.h);
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.isArr ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = p.isArr ? COLORS.PEAK_ARR : COLORS.PEAK_NORMAL;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();

      if (p.isArr) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.font = `bold 8px ${FONT_MONO}`;
        ctx.fillStyle = '#fecaca';
        ctx.textAlign = 'center';
        ctx.fillText('ARR', p.x, p.y - 12);
      }
    }

    const rrForLabels = propsRef.current.rrIntervals ?? [];
    const validRr = rrForLabels.filter((r) => isPhysiologicalRR(r));
    const meanIbi =
      validRr.length > 0 ? validRr.reduce((a, v) => a + v, 0) / validRr.length : ibiDisplayRef.current;

    ctx.font = `bold 9px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    for (let i = 0; i < visiblePeaks.length - 1; i++) {
      const p1 = visiblePeaks[i];
      const p2 = visiblePeaks[i + 1];
      const ibiMs = Math.abs(p2.time - p1.time);
      if (!isPhysiologicalRR(ibiMs)) continue;
      const label = ibiSegmentLabel(ibiMs, meanIbi);
      const midX = (p1.x + p2.x) / 2;
      const topY = Math.min(p1.y, p2.y) - 20;
      ctx.strokeStyle =
        label.level === 'danger'
          ? 'rgba(248, 113, 113, 0.7)'
          : label.level === 'warn'
            ? 'rgba(245, 158, 11, 0.65)'
            : 'rgba(103, 232, 249, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p1.x, topY + 6);
      ctx.lineTo(p1.x, topY);
      ctx.lineTo(p2.x, topY);
      ctx.lineTo(p2.x, topY + 6);
      ctx.stroke();
      ctx.fillStyle = levelColor(label.level);
      ctx.fillText(label.text, midX, topY - 3);
    }

    const tachoY = plot.y + plot.h - RR_TACHO_H + 4;
    ctx.fillStyle = 'rgba(8, 14, 26, 0.85)';
    ctx.fillRect(plot.x + 2, tachoY - 4, plot.w - 4, RR_TACHO_H);
    ctx.font = `bold 8px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.fillText('TACHOGRAMA RR (IBI)', plot.x + 8, tachoY + 8);
    if (visiblePeaks.length >= 2) {
      const ibis: number[] = [];
      for (let i = 0; i < visiblePeaks.length - 1; i++) {
        const d = Math.abs(visiblePeaks[i + 1].time - visiblePeaks[i].time);
        if (isPhysiologicalRR(d)) ibis.push(d);
      }
      const maxIbi = Math.max(...ibis, 900);
      const minIbi = Math.min(...ibis, 400);
      const spanIbi = Math.max(120, maxIbi - minIbi);
      for (let i = 0; i < visiblePeaks.length - 1; i++) {
        const ibiMs = Math.abs(visiblePeaks[i + 1].time - visiblePeaks[i].time);
        if (!isPhysiologicalRR(ibiMs)) continue;
        const midX = (visiblePeaks[i].x + visiblePeaks[i + 1].x) / 2;
        const h = ((ibiMs - minIbi) / spanIbi) * (RR_TACHO_H - 16);
        const irregular = ibiSegmentLabel(ibiMs, meanIbi).level !== 'normal';
        ctx.fillStyle = irregular ? 'rgba(239, 68, 68, 0.85)' : 'rgba(34, 197, 94, 0.75)';
        ctx.fillRect(midX - 3, tachoY + RR_TACHO_H - 10 - h, 6, h);
      }
    }

    const p = propsRef.current;
    const rhythm = buildRhythmPanel(
      p.arrhythmiaStatus,
      p.arrhythmiaCount ?? 0,
      p.rrIntervals ?? [],
      hrvDisplayRef.current,
    );
    const panelH = 56;
    const panelY = plot.y + 8;
    ctx.fillStyle = 'rgba(8, 14, 26, 0.88)';
    ctx.strokeStyle =
      rhythm.level === 'danger'
        ? 'rgba(239, 68, 68, 0.55)'
        : rhythm.level === 'warn'
          ? 'rgba(245, 158, 11, 0.45)'
          : 'rgba(34, 197, 94, 0.35)';
    ctx.lineWidth = 1;
    ctx.fillRect(plot.x + 8, panelY, Math.min(plot.w - 16, 340), panelH);
    ctx.strokeRect(plot.x + 8, panelY, Math.min(plot.w - 16, 340), panelH);
    ctx.textAlign = 'left';
    ctx.font = `bold 11px ${FONT_MONO}`;
    ctx.fillStyle = levelColor(rhythm.level);
    ctx.fillText(rhythm.title, plot.x + 16, panelY + 16);
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(rhythm.detail, plot.x + 16, panelY + 30);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(rhythm.guidance, plot.x + 16, panelY + 44);

    if (p.isMonitoring) {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.85)';
      ctx.beginPath();
      ctx.arc(plot.x + plot.w - 42, plot.y + 18, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.fillStyle = '#fca5a5';
      ctx.textAlign = 'right';
      ctx.fillText('REC', plot.x + plot.w - 12, plot.y + 22);
    }
    ctx.font = `bold 9px ${FONT_MONO}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(34, 197, 94, 0.9)';
    ctx.fillText(`SQI ${Math.round(p.quality)}%`, plot.x + plot.w - 12, plot.y + 38);
    ctx.fillStyle = 'rgba(103, 232, 249, 0.9)';
    ctx.fillText(`PI ${(p.perfusionIndex ?? 0).toFixed(3)}`, plot.x + plot.w - 12, plot.y + 52);
    const contact = formatContactState(p.contactState);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(contact, plot.x + plot.w - 12, plot.y + 66);

    ctx.restore();
  }, []);

  const drawTrendStrip = useCallback((ctx: CanvasRenderingContext2D) => {
    const { trend } = layoutRef.current;
    if (trend.w < 80 || trend.h < 36) return;

    const compact = trend.h < 92;

    ctx.fillStyle = COLORS.PANEL_BG;
    ctx.fillRect(trend.x, trend.y, trend.w, trend.h);
    ctx.strokeStyle = COLORS.PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(trend.x + 0.5, trend.y + 0.5, trend.w - 1, trend.h - 1);

    const data = bpmTrendRef.current;
    const hrv = hrvDisplayRef.current;
    const arrCnt = propsRef.current.arrhythmiaCount ?? 0;

    ctx.font = `bold ${compact ? 9 : 10}px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.textAlign = 'left';
    ctx.fillText(
      compact ? 'TENDENCIA BPM · 60s' : 'TENDENCIA FRECUENCIA CARDÍACA · 60 s',
      trend.x + 8,
      trend.y + (compact ? 12 : 14),
    );

    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    const hrvBits: string[] = [];
    if (hrv.sdnn > 0) hrvBits.push(`SDNN ${hrv.sdnn}`);
    if (hrv.rmssd > 0) hrvBits.push(`RMSSD ${hrv.rmssd}`);
    if (arrCnt > 0) hrvBits.push(`${arrCnt} arr`);
    if (hrvBits.length > 0 && !compact) {
      ctx.fillText(hrvBits.join(' · '), trend.x + 8, trend.y + 26);
    } else if (hrvBits.length > 0) {
      ctx.textAlign = 'right';
      ctx.fillText(hrvBits.join(' · '), trend.x + trend.w - 8, trend.y + 12);
      ctx.textAlign = 'left';
    }

    if (data.length < 2) {
      ctx.font = `9px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_DIM;
      ctx.textAlign = 'center';
      ctx.fillText('Acumulando…', trend.x + trend.w / 2, trend.y + trend.h / 2 + 4);
      return;
    }

    const padTop = compact ? 24 : 32;
    const padBot = compact ? 10 : 16;
    const padL = compact ? 32 : 36;
    const padR = 8;
    const innerX = trend.x + padL;
    const innerY = trend.y + padTop;
    const innerW = trend.w - padL - padR;
    const innerH = trend.h - padTop - padBot;

    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    for (const p of data) {
      if (p.bpm < mn) mn = p.bpm;
      if (p.bpm > mx) mx = p.bpm;
      sum += p.bpm;
    }
    const avg = sum / data.length;
    const span = Math.max(24, mx - mn + 12);
    const yMin = Math.max(30, Math.floor((mn - 8) / 5) * 5);
    const yMax = yMin + span;

    const yToPx = (v: number) => innerY + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
    const drawBand = (lo: number, hi: number, color: string) => {
      const y1 = Math.max(innerY, yToPx(hi));
      const y2 = Math.min(innerY + innerH, yToPx(lo));
      if (y2 > y1) {
        ctx.fillStyle = color;
        ctx.fillRect(innerX, y1, innerW, y2 - y1);
      }
    };
    drawBand(60, 100, 'rgba(34, 197, 94, 0.09)');
    drawBand(yMin, 60, 'rgba(245, 158, 11, 0.06)');
    drawBand(100, yMax, 'rgba(239, 68, 68, 0.06)');

    const refLines = [
      { v: 60, label: '60', color: 'rgba(245, 158, 11, 0.55)' },
      { v: 100, label: '100', color: 'rgba(239, 68, 68, 0.45)' },
    ];
    for (const ref of refLines) {
      if (ref.v < yMin || ref.v > yMax) continue;
      const y = yToPx(ref.v);
      ctx.strokeStyle = ref.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(innerX, y);
      ctx.lineTo(innerX + innerW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `8px ${FONT_MONO}`;
      ctx.fillStyle = ref.color;
      ctx.textAlign = 'left';
      ctx.fillText(ref.label, innerX + 4, y - 3);
    }

    const tickStep = span > 50 ? 10 : 5;
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'right';
    for (let v = yMin; v <= yMax; v += tickStep) {
      const y = yToPx(v);
      ctx.fillText(`${v}`, innerX - 5, y + 3);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(innerX, y);
      ctx.lineTo(innerX + innerW, y);
      ctx.stroke();
    }

    const now = Date.now();
    const tStart = now - TREND_WINDOW_MS;
    const xToPx = (t: number) => innerX + ((t - tStart) / TREND_WINDOW_MS) * innerW;

    for (let s = 0; s <= 60; s += 15) {
      const t = now - s * 1000;
      const x = xToPx(t);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
      ctx.beginPath();
      ctx.moveTo(x, innerY);
      ctx.lineTo(x, innerY + innerH);
      ctx.stroke();
      ctx.font = `8px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_DIM;
      ctx.textAlign = 'center';
      ctx.fillText(s === 0 ? 'ahora' : `−${s}s`, x, innerY + innerH + (compact ? 9 : 12));
    }

    const coords: { x: number; y: number; isArr: boolean }[] = data.map((p) => ({
      x: xToPx(p.t),
      y: yToPx(p.bpm),
      isArr: p.isArr,
    }));

    ctx.beginPath();
    ctx.moveTo(coords[0].x, innerY + innerH);
    for (const c of coords) ctx.lineTo(c.x, c.y);
    ctx.lineTo(coords[coords.length - 1].x, innerY + innerH);
    ctx.closePath();
    const areaGrad = ctx.createLinearGradient(0, innerY, 0, innerY + innerH);
    areaGrad.addColorStop(0, 'rgba(34, 197, 94, 0.22)');
    areaGrad.addColorStop(1, 'rgba(34, 197, 94, 0.02)');
    ctx.fillStyle = areaGrad;
    ctx.fill();

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    let seg = 0;
    while (seg < coords.length - 1) {
      const isArr = coords[seg].isArr;
      let end = seg;
      while (end < coords.length - 1 && coords[end + 1].isArr === isArr) end++;
      ctx.beginPath();
      ctx.moveTo(coords[seg].x, coords[seg].y);
      for (let k = seg; k < end; k++) {
        const xc = (coords[k].x + coords[k + 1].x) / 2;
        const yc = (coords[k].y + coords[k + 1].y) / 2;
        ctx.quadraticCurveTo(coords[k].x, coords[k].y, xc, yc);
      }
      ctx.lineTo(coords[end].x, coords[end].y);
      ctx.strokeStyle = isArr ? COLORS.SIGNAL_ARR : COLORS.SIGNAL;
      ctx.lineWidth = isArr ? 2.4 : 2;
      ctx.shadowColor = isArr ? COLORS.SIGNAL_ARR_GLOW : COLORS.SIGNAL_GLOW;
      ctx.shadowBlur = isArr ? 8 : 5;
      ctx.stroke();
      seg = end + 1;
    }
    ctx.shadowBlur = 0;

    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      if (!data[i].isArr && i !== coords.length - 1) continue;
      ctx.beginPath();
      ctx.arc(c.x, c.y, data[i].isArr ? 3.5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = data[i].isArr ? COLORS.SIGNAL_ARR : COLORS.SIGNAL;
      ctx.fill();
      if (data[i].isArr) {
        ctx.font = `bold 7px ${FONT_MONO}`;
        ctx.fillStyle = '#fecaca';
        ctx.textAlign = 'center';
        ctx.fillText('!', c.x, c.y - 8);
      }
    }

    const avgY = yToPx(avg);
    ctx.strokeStyle = 'rgba(103, 232, 249, 0.5)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(innerX, avgY);
    ctx.lineTo(innerX + innerW, avgY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.textAlign = 'right';
    ctx.fillText(`media ${Math.round(avg)}`, innerX + innerW - 4, avgY - 4);

    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.fillText(
      `min ${Math.round(mn)} · max ${Math.round(mx)}`,
      innerX,
      trend.y + trend.h - 4,
    );
    if (!compact) {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(251, 113, 133, 0.85)';
      ctx.fillText('● arrítmico', innerX + innerW, trend.y + trend.h - 4);
    }
  }, []);

  const drawFooter = useCallback((ctx: CanvasRenderingContext2D) => {
    const { footer } = layoutRef.current;
    const { bpm, spo2, pressure, perfusionIndex: pi } = propsRef.current;

    ctx.fillStyle = 'rgba(6, 12, 22, 0.95)';
    ctx.fillRect(footer.x, footer.y, footer.w, footer.h);
    ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
    ctx.beginPath();
    ctx.moveTo(0, footer.y);
    ctx.lineTo(footer.w, footer.y);
    ctx.stroke();

    // HRV metrics row
    const hrv = hrvDisplayRef.current;
    ctx.font = `10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.fillText('HRV', footer.x + 12, footer.y + 12);

    const cells = [
      { label: 'IBI', value: ibiDisplayRef.current > 0 ? `${ibiDisplayRef.current}ms` : '--', color: COLORS.TEXT_INFO },
      { label: 'SDNN', value: hrv.sdnn > 0 ? `${hrv.sdnn}ms` : '--', color: COLORS.TEXT_SECONDARY },
      { label: 'RMSSD', value: hrv.rmssd > 0 ? `${hrv.rmssd}ms` : '--', color: COLORS.TEXT_SECONDARY },
      { label: 'pNN50', value: hrv.pnn50 > 0 ? `${hrv.pnn50}%` : '--', color: COLORS.TEXT_SECONDARY },
      { label: 'CV', value: hrv.cv > 0 ? hrv.cv.toFixed(2) : '--', color: COLORS.TEXT_SECONDARY },
    ];

    const hrvSectionWidth = footer.w * 0.55; // Constrain HRV to left half
    const cellW = hrvSectionWidth / cells.length;
    cells.forEach((c, i) => {
      const cx = footer.x + 12 + i * cellW;
      ctx.font = `8px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_DIM;
      ctx.textAlign = 'left';
      ctx.fillText(c.label, cx, footer.y + 24);
      ctx.font = `bold 11px ${FONT_MONO}`;
      ctx.fillStyle = c.color;
      ctx.fillText(c.value, cx, footer.y + 38);
    });

    // Alarms (right side)
    const map = pressure?.systolic && pressure?.diastolic
      ? Math.round(pressure.diastolic + (pressure.systolic - pressure.diastolic) / 3)
      : 0;
    const alarms: string[] = [];
    if (bpm > 0 && (bpm < 50 || bpm > 120)) alarms.push('HR');
    if (spo2 > 0 && spo2 < 92) alarms.push('SpO₂');
    if (map > 0 && (map < 65 || map > 110)) alarms.push('MAP');
    if (pi > 0 && pi < 0.005) alarms.push('PI');

    ctx.textAlign = 'right';
    if (alarms.length > 0) {
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_DANGER;
      ctx.fillText(`⚠ ALARMA: ${alarms.join(' · ')}`, footer.x + footer.w - 12, footer.y + 16);
    } else if (bpm > 0) {
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_PRIMARY;
      ctx.fillText('● SIN ALARMAS', footer.x + footer.w - 12, footer.y + 16);
    }

    // Beat history dots — right side, below alarms
    const beats = beatHistoryRef.current;
    if (beats.length > 0) {
      const showN = Math.min(beats.length, 18); // Limitar a 18 para no pisar las métricas HRV
      const dotSize = 3; // Puntos más pequeños
      const gap = 3;
      const totalW = showN * (dotSize * 2 + gap) - gap;
      const startX = footer.x + footer.w - 12 - totalW;
      const dy = footer.y + 36; // Alinear verticalmente en la mitad derecha
      for (let i = 0; i < showN; i++) {
        const beat = beats[beats.length - showN + i];
        const cx = startX + i * (dotSize * 2 + gap) + dotSize;
        ctx.beginPath();
        ctx.arc(cx, dy, dotSize, 0, Math.PI * 2);
        ctx.fillStyle = beat.isArrhythmia ? COLORS.SIGNAL_ARR : COLORS.SIGNAL;
        ctx.fill();
      }
      ctx.font = `8px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_DIM;
      ctx.textAlign = 'right';
      const arrCount = beats.filter(b => b.isArrhythmia).length;
      ctx.fillText(`Últimos ${showN} · N:${beats.length - arrCount} A:${arrCount}`, footer.x + footer.w - 12, dy + 14);
    }
  }, []);

  // ============= MAIN RENDER LOOP =============
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

      drawBackground(ctx);
      drawHeader(ctx, now);
      drawMetricsBar(ctx, now);
      drawECGGrid(ctx);
      drawSignal(ctx, now);
      drawTrendStrip(ctx);
      drawFooter(ctx);

      animationRef.current = requestAnimationFrame(render);
    };

    animationRef.current = requestAnimationFrame(render);

    return () => {
      isRunningRef.current = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [drawBackground, drawHeader, drawMetricsBar, drawECGGrid, drawSignal, drawTrendStrip, drawFooter]);

  const handleReset = useCallback(() => {
    dataBufferRef.current?.clear();
    amplitudeStatsRef.current = { min: -50, max: 50, range: 100 };
    beatHistoryRef.current = [];
    lastArrhythmiaCountRef.current = 0;
    ibiDisplayRef.current = 0;
    hrvDisplayRef.current = { sdnn: 0, rmssd: 0, pnn50: 0, cv: 0 };
    bpmStatsRef.current = { min: 0, max: 0, sum: 0, n: 0 };
    bpmTrendRef.current = [];
    onReset();
  }, [onReset]);

  return (
    <div ref={containerRef} className="fixed inset-0 bg-slate-950 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
      />

      {/* Pulse indicator overlay (top-left near header status) */}
      <div className="absolute z-10 flex items-center gap-2 pointer-events-none" style={{ top: '8px', left: '120px' }}>
        <div
          className={`p-1 rounded-full transition-all duration-100 ${
            showPulse ? 'bg-red-500/40 scale-125' : 'bg-emerald-500/0'
          }`}
        >
          <Heart
            className={`w-3.5 h-3.5 transition-all duration-100 ${
              showPulse ? 'text-red-300' : 'text-emerald-400/0'
            }`}
            fill={showPulse ? 'currentColor' : 'none'}
          />
        </div>
        <Activity className="w-3 h-3 text-emerald-400/0" />
      </div>

      {/* Action buttons */}
      <div className="fixed bottom-0 left-0 right-0 h-12 grid grid-cols-2 z-10">
        <button
          onClick={onStartMeasurement}
          className={`font-semibold text-sm transition-colors border-t border-slate-700/60 ${
            isMonitoring
              ? 'bg-red-500/20 hover:bg-red-500/30 active:bg-red-500/40 text-red-300 border-r'
              : 'bg-emerald-600/20 hover:bg-emerald-600/30 active:bg-emerald-600/40 text-emerald-300 border-r'
          }`}
        >
          {isMonitoring ? 'DETENER' : 'INICIAR'}
        </button>
        <button
          onClick={handleReset}
          className="bg-slate-700/20 hover:bg-slate-700/30 active:bg-slate-700/40 text-slate-300 font-semibold text-sm transition-colors border-t border-slate-700/60"
        >
          RESET
        </button>
      </div>
    </div>
  );
};

export default PPGSignalMeter;
