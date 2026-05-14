import React, { useEffect, useRef, useCallback, useState, useLayoutEffect } from 'react';
import { Heart, Activity } from 'lucide-react';
import { CircularBuffer, PPGDataPoint } from '../utils/CircularBuffer';
import { calculateHRV, isPhysiologicalRR } from '../utils/physio';

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
  diagnosticMessage?: string;
  isPeak?: boolean;
  bpm?: number;
  spo2?: number;
  rrIntervals?: number[];
  elapsedTime?: number;
  perfusionIndex?: number;
  pressure?: { systolic: number; diastolic: number; confidence?: string; featureQuality?: number };
  glucose?: { value: number; trend: string };
  arterialHealth?: { agingIndex: number; stiffness: number; vascularStatus: string };
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  onResize?: (width: number, height: number) => void;
}

const TARGET_FPS = 30;
const WINDOW_MS = 6000;          // 6 segundos de onda visible (sweep clínico)
const BUFFER_SIZE = 720;         // ~120 puntos/seg * 6s
const TREND_WINDOW_MS = 60_000;  // 60 s de tendencia BPM
const TREND_MAX_POINTS = 240;
const BEAT_HISTORY_MAX = 30;

const COLORS = {
  BG_TOP: '#06090f',
  BG_BOTTOM: '#020409',
  PANEL_BG: 'rgba(10, 18, 30, 0.92)',
  PANEL_BORDER: 'rgba(34, 197, 94, 0.32)',
  PANEL_BORDER_DIM: 'rgba(148, 163, 184, 0.18)',
  GRID_MINOR: 'rgba(220, 38, 38, 0.06)',
  GRID_MAJOR: 'rgba(220, 38, 38, 0.16)',
  GRID_SEC: 'rgba(34, 197, 94, 0.22)',
  BASELINE: 'rgba(34, 197, 94, 0.35)',
  SIGNAL: '#22c55e',
  SIGNAL_GLOW: 'rgba(34, 197, 94, 0.55)',
  SIGNAL_ARR: '#ef4444',
  SIGNAL_ARR_GLOW: 'rgba(239, 68, 68, 0.55)',
  PEAK_NORMAL: '#3b82f6',
  PEAK_ARR: '#ef4444',
  VALLEY: '#64748b',
  TEXT_PRIMARY: '#22c55e',
  TEXT_SECONDARY: '#94a3b8',
  TEXT_DIM: '#475569',
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
const FONT_SANS = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

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
  bpm = 0,
  spo2 = 0,
  rrIntervals = [],
  elapsedTime = 0,
  perfusionIndex = 0,
  pressure,
  glucose,
  arterialHealth,
  onCanvasReady,
  onResize
}: PPGSignalMeterProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null); // Nuevo canvas para el Worker
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const isRunningRef = useRef(false);
  const dataBufferRef = useRef<CircularBuffer | null>(null);

  // Latest props captured via ref so the RAF loop doesn't re-create per render
  const propsRef = useRef({ 
    value, quality, isFingerDetected, arrhythmiaStatus, preserveResults, 
    isPeak, bpm, spo2, rrIntervals, rawArrhythmiaData, elapsedTime, 
    perfusionIndex, pressure, glucose, arterialHealth 
  });
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
  const bpmTrendRef = useRef<{ t: number; bpm: number }[]>([]);
  const lastBpmSampleRef = useRef<number>(0);

  // Layout — recomputed on resize, DPR-aware
  const layoutRef = useRef({
    dpr: 1,
    width: 0,
    height: 0,
    header: { x: 0, y: 0, w: 0, h: 0 },
    metrics: { x: 0, y: 0, w: 0, h: 0 },
    plot: { x: 0, y: 0, w: 0, h: 0, centerY: 0 },
    trend: { x: 0, y: 0, w: 0, h: 0 },
    poincare: { x: 0, y: 0, w: 0, h: 0 },
    footer: { x: 0, y: 0, w: 0, h: 0 },
  });

  // === Sync props into ref + compute HRV / trends ===
  useEffect(() => {
    propsRef.current = { value, quality, isFingerDetected, arrhythmiaStatus, preserveResults, isPeak, bpm, spo2, rrIntervals, rawArrhythmiaData, elapsedTime, perfusionIndex, pressure, glucose, arterialHealth };

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
    if (bpm > 30 && bpm < 220 && nowMs - lastBpmSampleRef.current > 500) {
      lastBpmSampleRef.current = nowMs;
      const s = bpmStatsRef.current;
      if (s.n === 0) { s.min = bpm; s.max = bpm; }
      else {
        if (bpm < s.min) s.min = bpm;
        if (bpm > s.max) s.max = bpm;
      }
      s.sum += bpm; s.n += 1;
      bpmTrendRef.current.push({ t: nowMs, bpm });
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
    }
  }, [value, quality, isFingerDetected, arrhythmiaStatus, preserveResults, isPeak, bpm, spo2, rrIntervals, rawArrhythmiaData, elapsedTime, perfusionIndex, pressure, glucose, arterialHealth]);

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

    // Sincronizar Wave Canvas (Worker)
    const waveCanvas = waveCanvasRef.current;
    if (waveCanvas) {
      waveCanvas.width = canvas.width;
      waveCanvas.height = canvas.height;
      waveCanvas.style.width = canvas.style.width;
      waveCanvas.style.height = canvas.style.height;
    }

    // Compute zones in CSS pixels.
    // Heights are proportional, but with sensible minima.
    const header = { x: 0, y: 0, w: cssW, h: 28 }; // Más compacto
    const metricsH = Math.max(80, Math.min(100, Math.round(cssH * 0.11))); // Más compacto
    const metrics = { x: 0, y: header.h, w: cssW, h: metricsH };

    const lowerH = Math.max(120, Math.round(cssH * 0.18)); // Más compacto
    const footerH = 48;
    const buttonsH = 44;
    const plotY = header.h + metricsH;
    const plotH = cssH - plotY - lowerH - footerH - buttonsH;

    const plotX = 48; // Menos margen lateral
    const plotW = cssW - plotX - 12;
    const plot = { x: plotX, y: plotY + 12, w: plotW, h: Math.max(200, plotH - 12), centerY: 0 };
    plot.centerY = plot.y + plot.h / 2;

    const lowerY = plot.y + plot.h + 8;
    const poincareW = Math.min(lowerH + 32, Math.round(cssW * 0.4));
    const trend = { x: plotX, y: lowerY, w: plotW - poincareW - 8, h: lowerH - 12 };
    const poincare = { x: plotX + trend.w + 8, y: lowerY, w: poincareW, h: lowerH - 12 };

    const footer = { x: 0, y: cssH - buttonsH - footerH, w: cssW, h: footerH };

    layoutRef.current = { dpr, width: cssW, height: cssH, header, metrics, plot, trend, poincare, footer };

    // Notificar al worker del nuevo tamaño físico
    if (onResize) onResize(Math.floor(cssW * dpr), Math.floor(cssH * dpr));
  }, [onResize]);

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

  // Pass canvas to parent/worker
  useEffect(() => {
    if (waveCanvasRef.current && onCanvasReady) {
      onCanvasReady(waveCanvasRef.current);
    }
  }, [onCanvasReady]);

  // ============= DRAWING HELPERS =============

  const drawBackground = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width: W, height: H } = layoutRef.current;
    // Clearing the main canvas to show the worker's canvas underneath
    ctx.clearRect(0, 0, W, H);
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
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.textAlign = 'left';
    ctx.fillText(isMonitoring ? 'MONITOREANDO' : (preserveResults ? 'RESULTADOS' : 'LISTO'), 28, header.y + 17);

    // Time + elapsed
    const d = new Date(now);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    
    ctx.font = `10px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${hh}:${mm}:${ss}`, header.w / 2, header.y + 17);
    
    // SQI + Info (Right)
    ctx.textAlign = 'right';
    ctx.fillStyle = quality >= 8 ? COLORS.SIGNAL : quality >= 5 ? COLORS.TEXT_WARN : COLORS.TEXT_DANGER;
    ctx.fillText(`SQI: ${quality * 10}%`, header.w - 12, header.y + 17);

    // Elapsed badge (left side, secondary)
    if (isMonitoring) {
      const t = Math.max(0, Math.floor(elapsedTime || 0));
      const em = String(Math.floor(t / 60)).padStart(2, '0');
      const es = String(t % 60).padStart(2, '0');
      const elapStr = `⏱ ${em}:${es}`;
      ctx.font = `11px ${FONT_MONO}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.TEXT_INFO;
      ctx.fillText(elapStr, 160, header.y + 17);
    }

    // Finger detect indicator
    ctx.font = `10px ${FONT_MONO}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = detected ? COLORS.TEXT_PRIMARY : COLORS.TEXT_DIM;
    ctx.fillText(detected ? '● DEDO OK' : '○ SIN DEDO', header.w - 110, header.y + 22);
  }, [isMonitoring, preserveResults]);

  const drawMetricsBar = useCallback((ctx: CanvasRenderingContext2D, now: number) => {
    const { metrics } = layoutRef.current;
    const { bpm, spo2, pressure, perfusionIndex: pi, arrhythmiaStatus: arr, glucose, arterialHealth: ah } = propsRef.current;

    // Background row
    ctx.fillStyle = 'rgba(6, 12, 22, 0.85)';
    const colW = metrics.w / 3;

    // Background row con glassmorphism
    ctx.fillStyle = 'rgba(10, 18, 30, 0.9)';
    ctx.fillRect(metrics.x, metrics.y, metrics.w, metrics.h);
    
    ctx.strokeStyle = COLORS.PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(colW, metrics.y + 10);
    ctx.lineTo(colW, metrics.y + metrics.h - 10);
    ctx.moveTo(colW * 2, metrics.y + 10);
    ctx.lineTo(colW * 2, metrics.y + metrics.h - 10);
    ctx.stroke();

    // === HR ===
    const hrColor = bpm <= 0 ? COLORS.TEXT_DIM
      : bpm < 50 ? COLORS.TEXT_DANGER
      : bpm < 60 ? COLORS.TEXT_WARN
      : bpm <= 100 ? COLORS.TEXT_PRIMARY
      : COLORS.TEXT_WARN;

    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.font = `10px ${FONT_SANS}`;
    ctx.fillText('FRECUENCIA CARDÍACA', colW / 2, metrics.y + 16);
    
    ctx.font = `bold 44px ${FONT_SANS}`; // Aumentado
    ctx.fillStyle = bpm > 0 ? (bpm > 100 || bpm < 50 ? COLORS.TEXT_WARN : '#fff') : COLORS.TEXT_DIM;
    ctx.fillText(bpm > 0 ? Math.round(bpm).toString() : '--', colW / 2, metrics.y + 54);
    
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = bpm > 100 ? COLORS.TEXT_WARN : COLORS.TEXT_PRIMARY;
    ctx.fillText(bpm > 0 ? (bpm > 100 ? 'TAQUICARDIA' : (bpm < 50 ? 'BRADICARDIA' : 'NORMAL')) : '---', colW / 2, metrics.y + 70);

    // === SpO2 ===
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.font = `10px ${FONT_SANS}`;
    ctx.fillText('SATURACIÓN O₂', colW + colW / 2, metrics.y + 16);
    
    ctx.font = `bold 44px ${FONT_SANS}`; // Aumentado
    ctx.fillStyle = spo2 > 0 ? (spo2 < 94 ? COLORS.TEXT_WARN : '#fff') : COLORS.TEXT_DIM;
    ctx.fillText(spo2 > 0 ? `${Math.round(spo2)}` : '--', colW + colW / 2 - 8, metrics.y + 54);
    
    ctx.font = `bold 12px ${FONT_MONO}`;
    ctx.fillText('%', colW + colW / 2 + 22, metrics.y + 54);

    // === BP ===
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.font = `10px ${FONT_SANS}`;
    ctx.fillText('PRESIÓN ARTERIAL', colW * 2 + colW / 2, metrics.y + 16);
    
    const sys = Math.round(pressure?.systolic || 0);
    const dia = Math.round(pressure?.diastolic || 0);
    const hasBP = sys > 0 && dia > 0;
    
    ctx.font = `bold 34px ${FONT_SANS}`; // Aumentado
    ctx.fillStyle = hasBP ? (sys > 140 || dia > 90 ? COLORS.TEXT_PRIMARY : '#fff') : COLORS.TEXT_DIM;
    ctx.fillText(hasBP ? `${sys}/${dia}` : '--/--', colW * 2 + colW / 2, metrics.y + 54);
    
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillText('mmHg', colW * 2 + colW / 2, metrics.y + 70);

    // === Advanced Biomarkers (Glucose & Arterial) ===
    if (glucose && glucose.value > 0) {
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_INFO;
      ctx.textAlign = 'left';
      ctx.fillText(`GLUCOSA: ${glucose.value}`, metrics.x + 12, metrics.y + metrics.h - 10);
      ctx.font = `8px ${FONT_MONO}`;
      ctx.fillText(`mg/dL`, metrics.x + 12, metrics.y + metrics.h - 2);
    }
    
    if (ah && ah.agingIndex !== 0) {
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.fillStyle = ah.agingIndex < 0 ? COLORS.TEXT_PRIMARY : COLORS.TEXT_WARN;
      ctx.textAlign = 'right';
      ctx.fillText(`VAS: ${ah.vascularStatus}`, metrics.w - 12, metrics.y + metrics.h - 10);
      ctx.font = `8px ${FONT_MONO}`;
      ctx.fillText(`AGI: ${ah.agingIndex.toFixed(2)}`, metrics.w - 12, metrics.y + metrics.h - 2);
    }

    // Arrhythmia banner (overlay below metrics)
    if (arr?.includes('ARRITMIA')) {
      const bannerH = 18;
      const bannerY = metrics.y + metrics.h + 2;
      ctx.fillStyle = 'rgba(239, 68, 68, 0.85)';
      ctx.fillRect(0, bannerY, metrics.w, bannerH);
      ctx.font = `bold 10px ${FONT_SANS}`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(arr.replace('|', ' | '), metrics.w / 2, bannerY + 12);
    }
  }, [isMonitoring, pressure]);

  const drawECGGrid = useCallback((ctx: CanvasRenderingContext2D) => {
    const { plot } = layoutRef.current;

    // Plot background (subtle vignette)
    const grad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
    grad.addColorStop(0, 'rgba(0, 24, 12, 0.50)');
    grad.addColorStop(0.5, 'rgba(0, 16, 8, 0.42)');
    grad.addColorStop(1, 'rgba(0, 24, 12, 0.50)');
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

    // Seconds labels along bottom
    const seconds = Math.floor(WINDOW_MS / 1000);
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'center';
    for (let s = 0; s <= seconds; s++) {
      const x = plot.x + plot.w - (s / seconds) * plot.w;
      ctx.fillText(`-${s}s`, x, plot.y + plot.h + 12);
    }

    // Y axis labels (amplitude)
    const stats = amplitudeStatsRef.current;
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
    const { value: signalValue, isFingerDetected: detected, arrhythmiaStatus: arrStatus, preserveResults: preserve, isPeak: peak } = propsRef.current;

    if (preserve && !detected) return;

    const scaledValue = signalValue * 2;

    if (peak) {
      const currentCount = arrStatus ? parseInt(arrStatus.split('|')[1] || '0') : 0;
      // Calcular RR real UNA sola vez: 0 si todavía no hay intervalos válidos.
      const rrArr = propsRef.current.rrIntervals;
      const lastRR = rrArr && rrArr.length > 0 ? rrArr[rrArr.length - 1] : 0;

      if (currentCount > lastArrhythmiaCountRef.current) {
        beatArrhythmiaRef.current = true;
        lastArrhythmiaCountRef.current = currentCount;
        // Para retro-marking necesitamos una duración sensata: el RR real si existe,
        // 800 ms como fallback razonable para cubrir la fase de subida del latido.
        const retroRR = lastRR > 0 ? lastRR : 800;
        const retroDuration = Math.min(Math.max(retroRR, 400), 1500);
        buffer.markArrhythmiaBack(retroDuration);
      } else {
        beatArrhythmiaRef.current = false;
      }
      // rr=0 indica "RR aún no disponible" (típico del primer latido); el Poincaré plot
      // lo descarta vía isPhysiologicalRR, lo cual es correcto.
      const storedRR = Math.round(lastRR);
      beatHistoryRef.current.push({
        isArrhythmia: beatArrhythmiaRef.current,
        time: now,
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
      const range = Math.max(40, mx - mn);
      const stats = amplitudeStatsRef.current;
      stats.min = stats.min * 0.95 + (mn - range * 0.1) * 0.05;
      stats.max = stats.max * 0.95 + (mx + range * 0.1) * 0.05;
      stats.range = stats.max - stats.min;
    }

    const stats = amplitudeStatsRef.current;
    if (points.length < 2) return;

    // Guard: si la señal es plana (range≈0 por EMA con DC constante),
    // forzamos un mínimo para evitar división por cero → NaN/Infinity en Y.
    const safeRange = stats.range > 1 ? stats.range : 1;

    // Build coordinates
    const coords: { x: number; y: number; isArr: boolean }[] = [];
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const age = now - pt.time;
      if (age > WINDOW_MS) continue;
      const x = plot.x + plot.w - (age * plot.w / WINDOW_MS);
      if (x < plot.x || x > plot.x + plot.w) continue;
      const y = plot.y + ((stats.max - pt.value) / safeRange) * plot.h;
      coords.push({ x, y, isArr: pt.isArrhythmia });
    }

    if (coords.length < 2) return;

    // Fill under curve
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(coords[0].x, plot.centerY);
    for (const c of coords) ctx.lineTo(c.x, c.y);
    ctx.lineTo(coords[coords.length - 1].x, plot.centerY);
    ctx.closePath();
    const fillGrad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
    fillGrad.addColorStop(0, 'rgba(34, 197, 94, 0.10)');
    fillGrad.addColorStop(0.5, 'rgba(34, 197, 94, 0.03)');
    fillGrad.addColorStop(1, 'rgba(34, 197, 94, 0.0)');
    ctx.fillStyle = fillGrad;
    ctx.fill();
    ctx.restore();

    // Stroke segments — group by arrhythmia for fewer state changes
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    let i = 0;
    while (i < coords.length - 1) {
      const isArr = coords[i].isArr;
      ctx.beginPath();
      ctx.moveTo(coords[i].x, coords[i].y);
      
      // Dibujar hasta que cambie el estado o lleguemos al final
      // Incluimos el punto de transición para evitar huecos en la onda
      while (i < coords.length - 1 && coords[i].isArr === isArr) {
        i++;
        ctx.lineTo(coords[i].x, coords[i].y);
      }
      
      if (isArr) {
        ctx.strokeStyle = COLORS.SIGNAL_ARR;
        ctx.shadowColor = COLORS.SIGNAL_ARR_GLOW;
        ctx.shadowBlur = 14;
        ctx.lineWidth = 3;
      } else {
        ctx.strokeStyle = COLORS.SIGNAL;
        ctx.shadowColor = COLORS.SIGNAL_GLOW;
        ctx.shadowBlur = 10;
        ctx.lineWidth = 2;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      // No necesitamos incrementar i manualmente aquí, el bucle interno ya lo hizo
      // i ahora apunta al primer punto del siguiente segmento o al final de coords.
    }

    // Peaks markers
    const visiblePeaks: { x: number; y: number; isArr: boolean; time: number }[] = [];
    for (const beat of beatHistoryRef.current) {
      const age = now - beat.time;
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
        const y = plot.y + ((stats.max - nearestPt.value) / safeRange) * plot.h;
        visiblePeaks.push({ x, y, isArr: beat.isArrhythmia, time: beat.time });
      }
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
        const alpha = (Math.sin(now / 80) + 1) / 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(239,68,68,${0.3 + alpha * 0.5})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // IBI annotations between consecutive visible peaks
    ctx.font = `9px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.TEXT_INFO;
    for (let i = 0; i < visiblePeaks.length - 1; i++) {
      const p1 = visiblePeaks[i];
      const p2 = visiblePeaks[i + 1];
      const ibiMs = Math.abs(p2.time - p1.time);
      if (ibiMs > 270 && ibiMs < 2200) {
        const midX = (p1.x + p2.x) / 2;
        const topY = Math.min(p1.y, p2.y) - 18;
        ctx.strokeStyle = 'rgba(103,232,249,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p1.x, topY + 6);
        ctx.lineTo(p1.x, topY);
        ctx.lineTo(p2.x, topY);
        ctx.lineTo(p2.x, topY + 6);
        ctx.stroke();
        ctx.fillText(`${Math.round(ibiMs)} ms`, midX, topY - 2);
      }
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

    // Line + area
    ctx.beginPath();
    ctx.strokeStyle = COLORS.SIGNAL;
    ctx.lineWidth = 1.6;
    let first = true;
    for (const p of data) {
      const x = xToPx(p.t);
      const y = yToPx(p.bpm);
      if (first) { ctx.moveTo(x, y); first = false; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

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
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.textAlign = 'left';
    ctx.fillText('POINCARÉ · RRₙ vs RRₙ₊₁', poincare.x + 8, poincare.y + 14);

    // Subtitle: HRV summary
    const hrv = hrvDisplayRef.current;
    ctx.font = `9px ${FONT_MONO}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.TEXT_SECONDARY;
    if (hrv.sdnn > 0) {
      ctx.fillText(`SDNN ${hrv.sdnn}ms · RMSSD ${hrv.rmssd}ms`, poincare.x + poincare.w - 8, poincare.y + 14);
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

    const padL = 28, padR = 8, padT = 22, padB = 16;
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

    // Axis labels
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(hi)}`, innerX - 2, innerY + 8);
    ctx.fillText(`${Math.round(lo)}`, innerX - 2, innerY + innerH);
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(lo)}`, innerX, innerY + innerH + 10);
    ctx.fillText(`${Math.round(hi)} ms`, innerX + innerW, innerY + innerH + 10);

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

    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.textAlign = 'left';
    ctx.fillText(`SD1 ${sd1.toFixed(1)}ms`, innerX + 4, poincare.y + poincare.h - 4);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.TEXT_VIOLET;
    ctx.fillText(`SD2 ${sd2.toFixed(1)}ms`, innerX + innerW, poincare.y + poincare.h - 4);
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
    ctx.fillText('HRV', footer.x + 12, footer.y + 16);

    const cells = [
      { label: 'IBI', value: ibiDisplayRef.current > 0 ? `${ibiDisplayRef.current}ms` : '--', color: COLORS.TEXT_INFO },
      { label: 'SDNN', value: hrv.sdnn > 0 ? `${hrv.sdnn}ms` : '--', color: COLORS.TEXT_SECONDARY },
      { label: 'RMSSD', value: hrv.rmssd > 0 ? `${hrv.rmssd}ms` : '--', color: COLORS.TEXT_SECONDARY },
      { label: 'pNN50', value: hrv.pnn50 > 0 ? `${hrv.pnn50}%` : '--', color: COLORS.TEXT_SECONDARY },
      { label: 'CV', value: hrv.cv > 0 ? hrv.cv.toFixed(3) : '--', color: COLORS.TEXT_SECONDARY },
    ];

    const totalWidth = footer.w - 24;
    const cellW = totalWidth / cells.length;
    cells.forEach((c, i) => {
      const cx = footer.x + 12 + i * cellW;
      ctx.font = `8px ${FONT_MONO}`;
      ctx.fillStyle = COLORS.TEXT_DIM;
      ctx.textAlign = 'left';
      ctx.fillText(c.label, cx, footer.y + 32);
      ctx.font = `bold 13px ${FONT_MONO}`;
      ctx.fillStyle = c.color;
      ctx.fillText(c.value, cx, footer.y + 48);
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

    // Beat history dots — bottom row
    const beats = beatHistoryRef.current;
    if (beats.length > 0) {
      const showN = Math.min(beats.length, 30);
      const dotSize = 5;
      const gap = 4;
      const totalW = showN * (dotSize * 2 + gap) - gap;
      const startX = footer.x + footer.w - 12 - totalW;
      const dy = footer.y + 44;
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
      ctx.fillText(`Últimos ${showN} · N:${beats.length - arrCount} A:${arrCount}`, footer.x + footer.w - 12, dy - 8);
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

      drawBackground(ctx);
      drawHeader(ctx, now);
      drawMetricsBar(ctx, now);
      // ECG Grid y Signal ahora los dibuja el Worker para mayor fluidez
      drawTrendStrip(ctx);
      drawPoincare(ctx);
      drawFooter(ctx);

      animationRef.current = requestAnimationFrame(render);
    };

    animationRef.current = requestAnimationFrame(render);

    return () => {
      isRunningRef.current = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [drawBackground, drawHeader, drawMetricsBar, drawECGGrid, drawSignal, drawTrendStrip, drawPoincare, drawFooter]);

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
        ref={waveCanvasRef}
        className="absolute inset-0 w-full h-full"
      />
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
