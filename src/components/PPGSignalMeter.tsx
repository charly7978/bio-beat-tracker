import React, { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react';
import { Heart, Activity } from 'lucide-react';
import { CircularBuffer, PPGDataPoint } from '../utils/CircularBuffer';
import { calculateHRV, isPhysiologicalRR } from '../utils/physio';
import {
  DISPLAY_SMOOTH_ALPHAS,
  lerpDisplayValue,
} from '@/lib/measurement/displaySmoothing';
import {
  bpZoneLabel,
  formatAcquisitionStatus,
  formatArrhythmiaStatus,
  formatContactState,
  hrZoneLabel,
  levelColor,
  spo2ZoneLabel,
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
  heartRateStatus?: string;
  spo2Status?: string;
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

const TARGET_FPS = 60;
const WINDOW_MS = 2800;
const BUFFER_SIZE = 4000;
const TREND_WINDOW_MS = 60_000;
const TREND_MAX_POINTS = 240;
const BEAT_HISTORY_MAX = 30;
const VISUAL_DELAY_MS = 166;
const WAVE_RANGE_ATTACK = 0.72;
const WAVE_RANGE_RELEASE = 0.28;
const WAVE_VERTICAL_PAD_RATIO = 0.01;

const COLORS = {
  BG_TOP: '#0c1424',
  BG_BOTTOM: '#070d16',
  PANEL_BG: 'rgba(12, 20, 34, 0.96)',
  PLOT_BG: '#0b1322',
  PANEL_BORDER: 'rgba(100, 116, 139, 0.35)',
  PANEL_BORDER_DIM: 'rgba(71, 85, 105, 0.28)',
  GRID_MINOR: 'rgba(148, 163, 184, 0.07)',
  GRID_MAJOR: 'rgba(148, 163, 184, 0.14)',
  GRID_SEC: 'rgba(148, 163, 184, 0.22)',
  BASELINE: 'rgba(148, 163, 184, 0.35)',
  SIGNAL: '#4ade80',
  SIGNAL_DIM: 'rgba(74, 222, 128, 0.38)',
  SIGNAL_ARR: '#fb7185',
  SIGNAL_ARR_DIM: 'rgba(251, 113, 133, 0.35)',
  PEAK_NORMAL: '#4ade80',
  PEAK_ARR: '#fb7185',
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
  POINCARE_NORMAL: 'rgba(34, 197, 94, 0.7)',
  POINCARE_ARR: 'rgba(239, 68, 68, 0.85)',
};

const FONT_MONO = '"SF Mono", Consolas, "Roboto Mono", monospace';
const FONT_UI = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const LAYOUT_PAD = 16;

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
  heartRateStatus,
  spo2Status,
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
      rawArrhythmiaData, elapsedTime, perfusionIndex, pressure, bpStatus,
      contactState, acquisitionStatus, heartRateStatus, spo2Status, diagnostics,
    });
  const lastPeakTimeRef = useRef(0);
  const [showPulse, setShowPulse] = useState(false);

  // Beat tracking
  const beatArrhythmiaRef = useRef(false);
  const lastArrhythmiaCountRef = useRef(0);
  const beatHistoryRef = useRef<{ isArrhythmia: boolean; time: number; rr: number }[]>([]);


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
  const displayRangeRef = useRef({ min: -1, max: 1 });
  const uiModeRef = useRef({ isMonitoring, preserveResults });

  // Layout — recomputed on resize, DPR-aware
  const layoutRef = useRef({
    dpr: 1,
    width: 0,
    height: 0,
    header: { x: 0, y: 0, w: 0, h: 0 },
    metrics: { x: 0, y: 0, w: 0, h: 0 },
    plot: { x: 0, y: 0, w: 0, h: 0, centerY: 0, traceY: 0, traceH: 0 },
    trend: { x: 0, y: 0, w: 0, h: 0 },
    poincare: { x: 0, y: 0, w: 0, h: 0 },
    footer: { x: 0, y: 0, w: 0, h: 0 },
    showAuxCharts: false,
  });

  // === Sync props into ref + compute HRV / trends ===
  useEffect(() => {
    propsRef.current = {
      value,
      quality,
      isFingerDetected,
      isMonitoring,
      arrhythmiaStatus,
      arrhythmiaCount,
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
      contactState,
      acquisitionStatus,
      heartRateStatus,
      spo2Status,
      diagnostics,
    };
    uiModeRef.current = { isMonitoring, preserveResults };

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
    heartRateStatus,
    spo2Status,
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
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssW = Math.max(320, Math.floor(rect.width));
    const cssH = Math.max(480, Math.floor(rect.height));
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }

    const { preserveResults: preserve, isMonitoring: monitoring } = uiModeRef.current;
    const showAuxCharts = preserve && !monitoring;

    const header = { x: 0, y: 0, w: cssW, h: 48 };
    const metricsH = 96;
    const metrics = { x: 0, y: header.h, w: cssW, h: metricsH };
    const footerH = 48;
    const buttonsH = 48;
    const auxH = showAuxCharts ? Math.min(88, Math.round(cssH * 0.11)) : 0;

    const plotY = header.h + metricsH;
    const plotH = cssH - plotY - auxH - footerH - buttonsH;
    const plotX = LAYOUT_PAD;
    const plotW = cssW - LAYOUT_PAD * 2;

    const plot = {
      x: plotX,
      y: plotY + 2,
      w: plotW,
      h: Math.max(200, plotH - 4),
      centerY: 0,
      traceY: 0,
      traceH: 0,
    };
    plot.traceY = plot.y;
    plot.traceH = plot.h;
    plot.centerY = plot.traceY + plot.traceH / 2;

    const lowerY = plot.y + plot.h + 4;
    const poincareW = showAuxCharts ? Math.min(auxH + 8, Math.round(cssW * 0.32)) : 0;
    const trend = {
      x: plotX,
      y: lowerY,
      w: showAuxCharts ? plotW - poincareW - 6 : 0,
      h: showAuxCharts ? auxH - 4 : 0,
    };
    const poincare = {
      x: plotX + trend.w + 6,
      y: lowerY,
      w: poincareW,
      h: showAuxCharts ? auxH - 4 : 0,
    };

    const footer = { x: 0, y: cssH - buttonsH - footerH, w: cssW, h: footerH };

    layoutRef.current = {
      dpr,
      width: cssW,
      height: cssH,
      header,
      metrics,
      plot,
      trend,
      poincare,
      footer,
      showAuxCharts,
    };
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
  }, [recomputeLayout, isMonitoring, preserveResults]);

  // ============= DRAWING HELPERS =============

  const drawBackground = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width: W, height: H } = layoutRef.current;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, COLORS.BG_TOP);
    grad.addColorStop(1, COLORS.BG_BOTTOM);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

  }, []);

  const drawHeader = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const { header } = layoutRef.current;
    const p = propsRef.current;
    const { quality, isFingerDetected: detected, elapsedTime: elapsed } = p;
    const pad = LAYOUT_PAD;

    ctx.fillStyle = COLORS.PANEL_BG;
    ctx.fillRect(header.x, header.y, header.w, header.h);
    ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
    ctx.beginPath();
    ctx.moveTo(0, header.y + header.h);
    ctx.lineTo(header.w, header.y + header.h);
    ctx.stroke();

    const row1Y = header.y + 22;
    const row2Y = header.y + 40;

    const pulse = (Math.sin(now / 500) + 1) / 2;
    ctx.beginPath();
    ctx.arc(pad + 6, row1Y - 5, 5, 0, Math.PI * 2);
    ctx.fillStyle = isMonitoring
      ? `rgba(94, 234, 212, ${0.45 + pulse * 0.4})`
      : preserveResults
        ? COLORS.TEXT_INFO
        : COLORS.TEXT_DIM;
    ctx.fill();

    ctx.font = `600 13px ${FONT_UI}`;
    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'left';
    ctx.fillText(
      isMonitoring ? 'Monitoreo activo' : preserveResults ? 'Resultados' : 'En espera',
      pad + 18,
      row1Y,
    );

    if (isMonitoring) {
      const t = Math.max(0, Math.floor(elapsed || 0));
      const em = String(Math.floor(t / 60)).padStart(2, '0');
      const es = String(t % 60).padStart(2, '0');
      ctx.font = `600 13px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_INFO;
      ctx.fillText(`${em}:${es}`, pad + 148, row1Y);
    }

    const d = new Date(now);
    ctx.font = `600 14px ${FONT_MONO}`;
    ctx.fillStyle = '#f1f5f9';
    ctx.textAlign = 'center';
    ctx.fillText(
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`,
      header.w / 2,
      row1Y,
    );

    const qColor =
      quality > 60 ? '#6ee7b7' : quality > 30 ? COLORS.TEXT_WARN : quality > 0 ? COLORS.TEXT_DANGER : COLORS.TEXT_DIM;
    const piPct = (p.perfusionIndex * 100).toFixed(1);
    ctx.textAlign = 'right';
    ctx.font = `600 13px ${FONT_MONO}`;
    ctx.fillStyle = qColor;
    ctx.fillText(`SQI ${Math.round(quality)}%`, header.w - pad, row1Y);
    ctx.font = `12px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    ctx.fillText(`PI ${piPct}%`, header.w - pad, row2Y);

    const contactShort = formatContactState(p.contactState);
    ctx.font = `12px ${FONT_UI}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = detected ? '#a7f3d0' : COLORS.TEXT_DIM;
    ctx.fillText(contactShort, pad + 18, row2Y);

    const diag = p.diagnostics;
    const hint =
      typeof diag?.placementHint === 'string' && detected
        ? diag.placementHint
        : diag?.status &&
            diag.status !== 'VALID' &&
            diag.status !== 'WARMUP' &&
            !(diag.status === 'LOW_SIGNAL_QUALITY' && diag.hasPulsatility)
          ? diag.status.replace(/_/g, ' ')
          : '';
    if (hint) {
      ctx.fillStyle = COLORS.TEXT_WARN;
      ctx.textAlign = 'center';
      ctx.font = `600 12px ${FONT_UI}`;
      ctx.fillText(hint, header.w / 2, row2Y);
    }
  }, [isMonitoring, preserveResults]);

  const drawMetricsBar = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const { metrics } = layoutRef.current;
    const p = propsRef.current;
    const { pressure, arrhythmiaStatus: arr, arrhythmiaCount: arrCnt } = p;
    const { isFingerDetected: fingerOn, preserveResults: preserve } = p;
    const pad = LAYOUT_PAD;

    ctx.fillStyle = COLORS.PANEL_BG;
    ctx.fillRect(metrics.x, metrics.y, metrics.w, metrics.h);
    ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
    ctx.beginPath();
    ctx.moveTo(0, metrics.y + metrics.h);
    ctx.lineTo(metrics.w, metrics.y + metrics.h);
    ctx.stroke();

    const innerW = metrics.w - pad * 2;
    const colW = innerW / 3;
    const divX1 = pad + colW;
    const divX2 = pad + colW * 2;

    ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
    ctx.beginPath();
    ctx.moveTo(divX1, metrics.y + 10);
    ctx.lineTo(divX1, metrics.y + metrics.h - 10);
    ctx.moveTo(divX2, metrics.y + 10);
    ctx.lineTo(divX2, metrics.y + metrics.h - 10);
    ctx.stroke();

    const dispBpm = Math.round((!fingerOn && !preserve ? 0 : displayBpmRef.current) || 0);
    const dispSpo2 = Math.round(displaySpo2Ref.current);
    const dispSys = Math.round(displaySysRef.current);
    const dispDia = Math.round(displayDiaRef.current);
    const sys = dispSys > 0 ? dispSys : pressure?.systolic || 0;
    const dia = dispDia > 0 ? dispDia : pressure?.diastolic || 0;
    const map = sys > 0 && dia > 0 ? Math.round(dia + (sys - dia) / 3) : 0;
    const pp = sys > 0 && dia > 0 ? sys - dia : 0;

    const drawVitalCol = (
      colIndex: number,
      label: string,
      primaryLine: string,
      subtitle: string,
      color: string,
      primaryPx: number,
    ) => {
      const x0 = pad + colW * colIndex;
      const cx = x0 + colW / 2;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 8, metrics.y + 4, colW - 16, metrics.h - 8);
      ctx.clip();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';

      ctx.font = `600 11px ${FONT_UI}`;
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(label, cx, metrics.y + 18);

      ctx.font = `700 ${primaryPx}px ${FONT_MONO}`;
      ctx.fillStyle = color;
      ctx.fillText(primaryLine, cx, metrics.y + 54);

      if (subtitle) {
        ctx.font = `600 10px ${FONT_UI}`;
        ctx.fillStyle = '#64748b';
        const maxW = colW - 20;
        if (ctx.measureText(subtitle).width <= maxW) {
          ctx.fillText(subtitle, cx, metrics.y + 72);
        } else {
          const cut = subtitle.lastIndexOf(' ', Math.floor(subtitle.length * 0.55));
          const l1 = cut > 0 ? subtitle.slice(0, cut) : subtitle;
          const l2 = cut > 0 ? subtitle.slice(cut + 1) : '';
          ctx.fillText(l1, cx, metrics.y + 70);
          if (l2) ctx.fillText(l2, cx, metrics.y + 82);
        }
      }

      ctx.restore();
    };

    const hrZone = hrZoneLabel(dispBpm);
    const hrColor = dispBpm > 0 ? levelColor(hrZone.level) : COLORS.TEXT_DIM;
    drawVitalCol(
      0,
      'Frecuencia cardíaca',
      dispBpm > 0 ? `${dispBpm} bpm` : '—',
      dispBpm > 0 ? hrZone.text : '',
      hrColor,
      42,
    );

    const spZone = spo2ZoneLabel(dispSpo2);
    const spColor = dispSpo2 > 0 ? levelColor(spZone.level) : COLORS.TEXT_DIM;
    drawVitalCol(
      1,
      'Saturación O₂',
      dispSpo2 > 0 ? `${dispSpo2} %` : '—',
      dispSpo2 > 0 ? spZone.text : '',
      spColor,
      42,
    );

    const bpZone = bpZoneLabel(sys, dia);
    const bpColor = sys > 0 ? levelColor(bpZone.level) : COLORS.TEXT_DIM;
    const bpPending =
      p.isMonitoring &&
      sys <= 0 &&
      (p.bpStatus === 'INSUFFICIENT_WINDOW' ||
        p.bpStatus === 'NO_VALID_SIGNAL' ||
        p.bpStatus === 'WARMUP');
    const bpLine = sys > 0 ? `${sys}/${dia}` : bpPending ? '···' : '—';
    const bpSub = sys > 0 ? bpZone.text : formatAcquisitionStatus(p.acquisitionStatus);
    drawVitalCol(
      2,
      'Presión arterial',
      bpLine,
      sys > 0 ? `MAP ${map} · PP ${pp} mmHg` : bpSub,
      bpColor,
      28,
    );
    if (sys > 0) {
      const x0 = pad + colW * 2;
      const cx = x0 + colW / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 8, metrics.y + 4, colW - 16, metrics.h - 8);
      ctx.clip();
      ctx.font = `600 10px ${FONT_UI}`;
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'center';
      ctx.fillText(bpSub, cx, metrics.y + 86);
      ctx.restore();
    }

    if (arr?.includes('ARRITMIA') && !arr?.includes('CALIBRANDO')) {
      const flash = (Math.sin(now / 200) + 1) / 2;
      ctx.fillStyle = `rgba(248, 113, 113, ${0.1 + flash * 0.12})`;
      ctx.fillRect(pad, metrics.y + 4, metrics.w - pad * 2, 16);
      ctx.font = `600 12px ${FONT_UI}`;
      ctx.fillStyle = COLORS.TEXT_DANGER;
      ctx.textAlign = 'center';
      ctx.fillText(`Arritmia detectada · ${arrCnt ?? 0} evento(s)`, metrics.w / 2, metrics.y + 16);
    }
  }, []);

  const drawECGGrid = useCallback((ctx: CanvasRenderingContext2D) => {
    const { plot } = layoutRef.current;
    const { traceY, traceH } = plot;

    ctx.fillStyle = COLORS.PLOT_BG;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    // ECG paper grid: 1mm minor (~5px), 5mm major (~25px), 25mm/s
    const pxPerMm = Math.max(4, Math.min(8, traceH / 30));
    const minor = pxPerMm;
    const major = pxPerMm * 5;

    // Minor (1mm)
    ctx.strokeStyle = COLORS.GRID_MINOR;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = plot.x; x <= plot.x + plot.w; x += minor) {
      ctx.moveTo(x, traceY);
      ctx.lineTo(x, traceY + traceH);
    }
    for (let y = traceY; y <= traceY + traceH; y += minor) {
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
    }
    ctx.stroke();

    // Major (5mm)
    ctx.strokeStyle = COLORS.GRID_MAJOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = plot.x; x <= plot.x + plot.w; x += major) {
      ctx.moveTo(x, traceY);
      ctx.lineTo(x, traceY + traceH);
    }
    for (let y = traceY; y <= traceY + traceH; y += major) {
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
      ctx.moveTo(x, traceY);
      ctx.lineTo(x, traceY + traceH);
    }
    ctx.stroke();

    const dr = displayRangeRef.current;
    const midV = (dr.min + dr.max) / 2;
    const midY = traceY + ((dr.max - midV) / Math.max(dr.max - dr.min, 1e-6)) * traceH;

    ctx.strokeStyle = COLORS.BASELINE;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(plot.x, midY);
    ctx.lineTo(plot.x + plot.w, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = COLORS.PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);

    const seconds = Math.floor(WINDOW_MS / 1000);
    ctx.font = `11px ${FONT_MONO}`;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
    ctx.textAlign = 'center';
    for (let s = 0; s <= seconds; s++) {
      const x = plot.x + plot.w - (s / seconds) * plot.w;
      ctx.fillText(`−${s}s`, x, plot.y + plot.h - 6);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
    ctx.font = `600 11px ${FONT_UI}`;
    ctx.fillText(`Canal PPG · ${(WINDOW_MS / 1000).toFixed(1)} s`, plot.x + 10, traceY + 14);
  }, []);

  const drawSignal = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const buffer = dataBufferRef.current;
    if (!buffer) return;
    const { plot, dpr } = layoutRef.current;
    const traceY = plot.traceY;
    const traceH = plot.traceH;
    const plotX = plot.x;
    const plotW = plot.w;
    const { value: signalValue, isFingerDetected: detected, preserveResults: preserve, isPeak: peak } =
      propsRef.current;

    if (preserve && !detected) return;

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

    buffer.push({ time: now, value: signalValue, isArrhythmia: currentIsArrhythmia });

    const points = buffer.getPoints();
    if (points.length < 2) return;

    const tCutoff = now - VISUAL_DELAY_MS - WINDOW_MS;
    const tEnd = now - VISUAL_DELAY_MS;

    type WinPt = { time: number; value: number; isArr: boolean };
    const windowPts: WinPt[] = [];
    let wMin = Infinity;
    let wMax = -Infinity;

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (pt.time < tCutoff || pt.time > tEnd) continue;
      windowPts.push({ time: pt.time, value: pt.value, isArr: pt.isArrhythmia });
      if (pt.value < wMin) wMin = pt.value;
      if (pt.value > wMax) wMax = pt.value;
    }

    if (windowPts.length < 2 || !Number.isFinite(wMin) || !Number.isFinite(wMax)) return;

    const rawRange = Math.max(wMax - wMin, 1e-6);
    const pad = Math.max(rawRange * WAVE_VERTICAL_PAD_RATIO, rawRange * 0.008 + 0.5);
    const targetMin = wMin - pad;
    const targetMax = wMax + pad;

    const dr = displayRangeRef.current;
    const expanding = targetMax - targetMin > dr.max - dr.min;
    const blend = expanding ? WAVE_RANGE_ATTACK : WAVE_RANGE_RELEASE;
    dr.min = dr.min * (1 - blend) + targetMin * blend;
    dr.max = dr.max * (1 - blend) + targetMax * blend;
    const dRange = Math.max(dr.max - dr.min, 1e-6);

    const ageToX = (t: number) => plotX + plotW - ((tEnd - t) / WINDOW_MS) * plotW;
    const valToY = (v: number) => traceY + ((dr.max - v) / dRange) * traceH;

    windowPts.sort((a, b) => a.time - b.time);

    const pxCols = Math.max(1, Math.floor(plotW));
    const msPerPx = WINDOW_MS / pxCols;
    const colMin = new Float64Array(pxCols);
    const colMax = new Float64Array(pxCols);
    const colArr = new Uint8Array(pxCols);
    colMin.fill(Number.POSITIVE_INFINITY);
    colMax.fill(Number.NEGATIVE_INFINITY);

    for (let i = 0; i < windowPts.length; i++) {
      const p = windowPts[i];
      const age = tEnd - p.time;
      let ci = pxCols - 1 - Math.floor((age / WINDOW_MS) * pxCols);
      if (ci < 0) ci = 0;
      if (ci >= pxCols) ci = pxCols - 1;
      if (p.value < colMin[ci]) colMin[ci] = p.value;
      if (p.value > colMax[ci]) colMax[ci] = p.value;
      if (p.isArr) colArr[ci] = 1;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotX, traceY, plotW, traceH);
    ctx.clip();

    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    for (let col = 0; col < pxCols; col++) {
      if (!Number.isFinite(colMin[col])) continue;
      const x = plotX + col + 0.5;
      const yTop = valToY(colMax[col]);
      const yBot = valToY(colMin[col]);
      ctx.strokeStyle = colArr[col] ? COLORS.SIGNAL_ARR_DIM : COLORS.SIGNAL_DIM;
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBot);
      ctx.stroke();
    }

    const strokeTrace = (arrhythmia: boolean) => {
      ctx.strokeStyle = arrhythmia ? COLORS.SIGNAL_ARR : COLORS.SIGNAL;
      ctx.lineWidth = Math.max(1.35, 1.65 * Math.min(dpr, 2.5) / 2);
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';
    };

    const drawSharpTrace = (arrhythmia: boolean) => {
      let drawing = false;
      for (let i = 0; i < windowPts.length; i++) {
        const p = windowPts[i];
        if (p.isArr !== arrhythmia) {
          if (drawing) {
            strokeTrace(arrhythmia);
            ctx.stroke();
            drawing = false;
          }
          continue;
        }
        const x = ageToX(p.time);
        const y = valToY(p.value);
        if (!drawing) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          drawing = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      if (drawing) {
        strokeTrace(arrhythmia);
        ctx.stroke();
      }
    };

    drawSharpTrace(false);
    drawSharpTrace(true);

    const visiblePeaks: { x: number; y: number; isArr: boolean; time: number }[] = [];
    for (const beat of beatHistoryRef.current) {
      if (beat.time < tCutoff || beat.time > tEnd) continue;
      const x = ageToX(beat.time);
      if (x < plotX || x > plotX + plotW) continue;
      let nearest: WinPt | null = null;
      let minDist = Infinity;
      for (const p of windowPts) {
        const d = Math.abs(p.time - beat.time);
        if (d < minDist) {
          minDist = d;
          nearest = p;
        }
      }
      if (nearest && minDist < msPerPx * 4) {
        visiblePeaks.push({
          x,
          y: valToY(nearest.value),
          isArr: beat.isArrhythmia,
          time: beat.time,
        });
      }
    }

    for (const p of visiblePeaks) {
      ctx.strokeStyle = p.isArr ? COLORS.PEAK_ARR : COLORS.PEAK_NORMAL;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 5);
      ctx.lineTo(p.x, p.y + 1);
      ctx.stroke();
    }

    ctx.font = `600 10px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
    for (let i = 0; i < visiblePeaks.length - 1; i++) {
      const p1 = visiblePeaks[i];
      const p2 = visiblePeaks[i + 1];
      const ibiMs = Math.abs(p2.time - p1.time);
      if (isPhysiologicalRR(ibiMs)) {
        ctx.fillText(`${Math.round(ibiMs)}`, (p1.x + p2.x) / 2, Math.min(p1.y, p2.y) - 8);
      }
    }

    ctx.restore();

    if (propsRef.current.isMonitoring) {
      const flash = Math.floor(now / 600) % 2 === 0;
      ctx.fillStyle = flash ? 'rgba(248, 113, 113, 0.85)' : 'rgba(248, 113, 113, 0.3)';
      ctx.beginPath();
      ctx.arc(plotX + 12, traceY + 12, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `600 10px ${FONT_UI}`;
      ctx.fillStyle = '#fca5a5';
      ctx.textAlign = 'left';
      ctx.fillText('GRAB', plotX + 20, traceY + 16);
    }
  }, []);

  const drawTrendStrip = useCallback((ctx: CanvasRenderingContext2D) => {
    const { trend } = layoutRef.current;
    if (trend.w < 80 || trend.h < 40) return;

    // Background
    ctx.fillStyle = COLORS.PANEL_BG;
    ctx.fillRect(trend.x, trend.y, trend.w, trend.h);
    ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
    ctx.strokeRect(trend.x, trend.y, trend.w, trend.h);

    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.textAlign = 'left';
    ctx.fillText('TENDENCIA FC · 60 s', trend.x + 8, trend.y + 14);

    const data = bpmTrendRef.current;
    if (data.length < 2) {
      ctx.font = `10px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_DIM;
      ctx.textAlign = 'center';
      ctx.fillText('— sin datos —', trend.x + trend.w / 2, trend.y + trend.h / 2);
      return;
    }

    const padTop = 24;
    const padBot = 14;
    const padL = 36;
    const padR = 8;
    const innerX = trend.x + padL;
    const innerY = trend.y + padTop;
    const innerW = trend.w - padL - padR;
    const innerH = trend.h - padTop - padBot;

    // Y range based on observed values + sane bands
    let mn = Infinity, mx = -Infinity;
    for (const p of data) { if (p.bpm < mn) mn = p.bpm; if (p.bpm > mx) mx = p.bpm; }
    const span = Math.max(20, mx - mn + 10);
    const yMin = Math.max(30, Math.floor((mn - 5) / 5) * 5);
    const yMax = yMin + span;

    // Reference bands: bradycardia (<60), normal 60-100, tachycardia (>100)
    const yToPx = (v: number) => innerY + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
    const drawBand = (lo: number, hi: number, color: string) => {
      const y1 = Math.max(innerY, yToPx(hi));
      const y2 = Math.min(innerY + innerH, yToPx(lo));
      if (y2 > y1) {
        ctx.fillStyle = color;
        ctx.fillRect(innerX, y1, innerW, y2 - y1);
      }
    };
    drawBand(60, 100, 'rgba(34, 197, 94, 0.06)');
    drawBand(yMin, 60, 'rgba(245, 158, 11, 0.05)');
    drawBand(100, yMax, 'rgba(239, 68, 68, 0.05)');

    // Y axis ticks
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'right';
    [yMin, Math.round((yMin + yMax) / 2), yMax].forEach((v) => {
      const y = yToPx(v);
      ctx.fillText(`${v}`, innerX - 4, y + 3);
      ctx.strokeStyle = 'rgba(148,163,184,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(innerX, y); ctx.lineTo(innerX + innerW, y);
      ctx.stroke();
    });

    // X axis (now on right, oldest on left)
    const now = Date.now();
    const tStart = now - TREND_WINDOW_MS;
    const xToPx = (t: number) => innerX + ((t - tStart) / TREND_WINDOW_MS) * innerW;

    // Line segments
    ctx.lineWidth = 1.8;
    for (let i = 1; i < data.length; i++) {
      const p1 = data[i - 1];
      const p2 = data[i];
      const x1 = xToPx(p1.t);
      const y1 = yToPx(p1.bpm);
      const x2 = xToPx(p2.t);
      const y2 = yToPx(p2.bpm);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      
      if (p2.isArr) {
        ctx.strokeStyle = COLORS.SIGNAL_ARR;
        ctx.shadowBlur = 0;
        ctx.stroke();

        // Marker dot for arrhythmia
        ctx.beginPath();
        ctx.arc(x2, y2, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.SIGNAL_ARR;
        ctx.fill();
      } else {
        ctx.strokeStyle = COLORS.SIGNAL;
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;

    // Last marker
    const last = data[data.length - 1];
    if (last) {
      const x = xToPx(last.t);
      const y = yToPx(last.bpm);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.SIGNAL;
      ctx.fill();
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_PRIMARY;
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(last.bpm)} bpm`, innerX + innerW - 4, innerY + 12);
    }

    // Min / max label
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.fillText(`min ${Math.round(mn)}  max ${Math.round(mx)}`, innerX, trend.y + trend.h - 4);
  }, []);

  const drawPoincare = useCallback((ctx: CanvasRenderingContext2D) => {
    const { poincare } = layoutRef.current;
    if (poincare.w < 80 || poincare.h < 80) return;

    ctx.fillStyle = COLORS.PANEL_BG;
    ctx.fillRect(poincare.x, poincare.y, poincare.w, poincare.h);
    ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
    ctx.strokeRect(poincare.x, poincare.y, poincare.w, poincare.h);

    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('DIAGRAMA DE POINCARÉ', poincare.x + 8, poincare.y + 18);

    // Subtitle: HRV summary (Línea 2)
    const hrv = hrvDisplayRef.current;
    ctx.font = `9px ${FONT_MONO}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.TEXT_INFO;
    if (hrv.sdnn > 0) {
      ctx.fillText(`SDNN ${hrv.sdnn}ms · RMSSD ${hrv.rmssd}ms`, poincare.x + 8, poincare.y + 34);
    }

    // Data
    const beats = beatHistoryRef.current.filter(b => isPhysiologicalRR(b.rr));
    if (beats.length < 4) {
      ctx.font = `10px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.TEXT_DIM;
      ctx.fillText('— acumulando RR —', poincare.x + poincare.w / 2, poincare.y + poincare.h / 2);
      return;
    }

    const padL = 34, padR = 12, padT = 54, padB = 28;
    const innerX = poincare.x + padL;
    const innerY = poincare.y + padT;
    const innerW = poincare.w - padL - padR;
    const innerH = poincare.h - padT - padB;

    const rrPairs: [number, number, boolean][] = [];
    for (let i = 1; i < beats.length; i++) {
      const a = beats[i - 1].rr;
      const b = beats[i].rr;
      if (isPhysiologicalRR(a) && isPhysiologicalRR(b)) {
        rrPairs.push([a, b, beats[i].isArrhythmia || beats[i - 1].isArrhythmia]);
      }
    }
    if (rrPairs.length === 0) return;

    let mn = Infinity, mx = -Infinity;
    for (const [a, b] of rrPairs) {
      if (a < mn) mn = a; if (a > mx) mx = a;
      if (b < mn) mn = b; if (b > mx) mx = b;
    }
    const pad = Math.max(60, (mx - mn) * 0.15);
    const lo = Math.max(300, mn - pad);
    const hi = Math.min(2000, mx + pad);
    const range = Math.max(50, hi - lo);

    const xToPx = (v: number) => innerX + ((v - lo) / range) * innerW;
    const yToPx = (v: number) => innerY + innerH - ((v - lo) / range) * innerH;

    // Axes
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(innerX, innerY); ctx.lineTo(innerX, innerY + innerH);
    ctx.moveTo(innerX, innerY + innerH); ctx.lineTo(innerX + innerW, innerY + innerH);
    ctx.stroke();

    // Identity line (RRn = RRn+1)
    ctx.strokeStyle = 'rgba(148,163,184,0.30)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xToPx(lo), yToPx(lo));
    ctx.lineTo(xToPx(hi), yToPx(hi));
    ctx.stroke();
    ctx.setLineDash([]);

    // Axis labels - Moved for clarity
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(hi)}`, innerX - 6, innerY + 4);
    ctx.fillText(`${Math.round(lo)}`, innerX - 6, innerY + innerH);
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(lo)}`, innerX, innerY + innerH + 12);
    ctx.fillText(`${Math.round(hi)} ms`, innerX + innerW, innerY + innerH + 12);

    // Points
    for (const [a, b, isArr] of rrPairs) {
      const x = xToPx(a);
      const y = yToPx(b);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isArr ? COLORS.POINCARE_ARR : COLORS.POINCARE_NORMAL;
      ctx.fill();
    }

    // Compute SD1/SD2 (Poincaré classic)
    const diffs = rrPairs.map(([a, b]) => (b - a));
    const sums = rrPairs.map(([a, b]) => (a + b));
    const meanDiff = diffs.reduce((s, v) => s + v, 0) / diffs.length;
    const meanSum = sums.reduce((s, v) => s + v, 0) / sums.length;
    const sd1 = Math.sqrt(diffs.reduce((s, v) => s + (v - meanDiff) ** 2, 0) / diffs.length) / Math.SQRT2;
    const sd2 = Math.sqrt(sums.reduce((s, v) => s + (v - meanSum) ** 2, 0) / sums.length) / Math.SQRT2;

    ctx.font = `bold 9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.textAlign = 'right';
    // SD1/SD2 movidos a la línea 2 para no pisar el título
    ctx.fillText(`SD1 ${sd1.toFixed(1)}ms`, poincare.x + poincare.w - 85, poincare.y + 34);
    ctx.fillStyle = COLORS.TEXT_VIOLET;
    ctx.fillText(`SD2 ${sd2.toFixed(1)}ms`, poincare.x + poincare.w - 8, poincare.y + 34);
  }, []);

  const drawFooter = useCallback((ctx: CanvasRenderingContext2D) => {
    const { footer } = layoutRef.current;
    const p = propsRef.current;
    const hrv = hrvDisplayRef.current;
    const ibi = ibiDisplayRef.current;

    ctx.fillStyle = 'rgba(6, 12, 22, 0.95)';
    ctx.fillRect(footer.x, footer.y, footer.w, footer.h);
    ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
    ctx.beginPath();
    ctx.moveTo(0, footer.y);
    ctx.lineTo(footer.w, footer.y);
    ctx.stroke();

    const rhythm = formatArrhythmiaStatus(p.arrhythmiaStatus, p.arrhythmiaCount ?? 0);
    const pad = LAYOUT_PAD;

    ctx.font = `600 12px ${FONT_UI}`;
    ctx.fillStyle = '#cbd5e1';
    ctx.textAlign = 'left';
    ctx.fillText(
      `${formatContactState(p.contactState)} · ${formatAcquisitionStatus(p.acquisitionStatus)} · ${rhythm}`,
      footer.x + pad,
      footer.y + 18,
    );

    const hrvLine = `IBI ${ibi > 0 ? `${ibi} ms` : '—'}   SDNN ${hrv.sdnn > 0 ? `${hrv.sdnn} ms` : '—'}   RMSSD ${hrv.rmssd > 0 ? `${hrv.rmssd} ms` : '—'}   pNN50 ${hrv.pnn50 > 0 ? `${hrv.pnn50}%` : '—'}`;
    ctx.font = `600 13px ${FONT_MONO}`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(hrvLine, footer.x + pad, footer.y + 38);

    const map =
      p.pressure?.systolic && p.pressure?.diastolic
        ? Math.round(p.pressure.diastolic + (p.pressure.systolic - p.pressure.diastolic) / 3)
        : 0;
    const alarms: string[] = [];
    if ((p.bpm ?? 0) > 0 && ((p.bpm ?? 0) < 50 || (p.bpm ?? 0) > 120)) alarms.push('FC');
    if ((p.spo2 ?? 0) > 0 && (p.spo2 ?? 0) < 92) alarms.push('SpO₂');
    if (map > 0 && (map < 65 || map > 110)) alarms.push('MAP');

    ctx.textAlign = 'right';
    ctx.font = `600 12px ${FONT_UI}`;
    if (alarms.length > 0) {
      ctx.fillStyle = COLORS.TEXT_DANGER;
      ctx.fillText(`Alarma: ${alarms.join(', ')}`, footer.x + footer.w - pad, footer.y + 28);
    } else if ((p.bpm ?? 0) > 0) {
      ctx.fillStyle = '#6ee7b7';
      ctx.fillText('Sin alarmas', footer.x + footer.w - pad, footer.y + 28);
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
      if (layoutRef.current.showAuxCharts) {
        drawTrendStrip(ctx);
        drawPoincare(ctx);
      }
      drawFooter(ctx);

      animationRef.current = requestAnimationFrame(render);
    };

    animationRef.current = requestAnimationFrame(render);

    return () => {
      isRunningRef.current = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [
    drawBackground,
    drawHeader,
    drawMetricsBar,
    drawECGGrid,
    drawSignal,
    drawTrendStrip,
    drawPoincare,
    drawFooter,
  ]);

  const handleReset = useCallback(() => {
    dataBufferRef.current?.clear();
    displayRangeRef.current = { min: -1, max: 1 };
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
