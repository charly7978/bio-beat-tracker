import { CircularBuffer, PPGDataPoint } from '../../utils/CircularBuffer';
import { isPhysiologicalRR } from '../../utils/physio';
import {
  buildRhythmPanel,
  formatContactState,
  ibiSegmentLabel,
  levelColor,
} from './ppgMonitorClinical';

export const FONT_MONO = '"SF Mono", Consolas, "Roboto Mono", monospace';

export const COLORS = {
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

export const TARGET_FPS = 60;
export const WINDOW_MS = 2000;
export const BUFFER_SIZE = 2500;
export const TREND_WINDOW_MS = 60_000;
export const TREND_MAX_POINTS = 240;
export const BEAT_HISTORY_MAX = 30;
export const VISUAL_DELAY_MS = 0;
export const AMP_ATTACK = 0.03;
export const AMP_RELEASE = 0.04;
export const RR_TACHO_H = 34;

export interface PpgLayout {
  width: number;
  height: number;
  header: { x: number; y: number; w: number; h: number };
  metrics: { x: number; y: number; w: number; h: number };
  plot: { x: number; y: number; w: number; h: number; centerY: number };
  trend: { x: number; y: number; w: number; h: number };
  footer: { x: number; y: number; w: number; h: number };
}

export interface HrvDisplay {
  sdnn: number;
  rmssd: number;
  pnn50: number;
  cv: number;
}

export interface BpmStats {
  min: number;
  max: number;
  sum: number;
  n: number;
}

export interface TrendPoint {
  t: number;
  bpm: number;
  isArr: boolean;
}

export interface BeatEntry {
  isArrhythmia: boolean;
  time: number;
  rr: number;
}

export interface AmplitudeStats {
  min: number;
  max: number;
  range: number;
}

export interface PpgRenderProps {
  value: number;
  quality: number;
  isFingerDetected: boolean;
  isMonitoring: boolean;
  isPeak: boolean;
  preserveResults: boolean;
  bpm: number | null;
  spo2: number;
  rrIntervals: number[];
  elapsedTime: number;
  perfusionIndex: number;
  pressure?: { systolic: number; diastolic: number; confidence?: string; featureQuality?: number };
  bpStatus?: string;
  arrhythmiaStatus?: string;
  arrhythmiaCount: number;
  contactState?: string;
  acquisitionStatus?: string;
  diagnostics?: {
    status?: string;
    message?: string;
    placementHint?: string;
    hasPulsatility?: boolean;
    acquisitionStage?: 'SEARCHING' | 'STABILIZING' | 'READY';
    acquisitionProgress?: number;
    sqm?: { fpsEffective?: number; timestampJitterMs?: number; underexposureRatio?: number };
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

export interface PpgRenderState {
  layout: PpgLayout;
  props: PpgRenderProps;
  now: number;
  displayBpm: number;
  displaySpo2: number;
  displaySys: number;
  displayDia: number;
  hrv: HrvDisplay;
  bpmStats: BpmStats;
  bpmTrend: TrendPoint[];
  beatHistory: BeatEntry[];
  amplitudeStats: AmplitudeStats;
  waveGain: number;
  sweepPulse: number;
  ibiDisplay: number;
  buffer: CircularBuffer | null;
  lastArrhythmiaCount: number;
  pendingTrendArr: boolean;
  lastPeakProcessedTime: number;
  arrActiveUntil: number;
}

export function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = COLORS.SCANLINE;
  for (let y = 0; y < H; y += 3) {
    ctx.fillRect(0, y, W, 1);
  }
}

export function drawHeader(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { header } = state.layout;
  const { quality, isFingerDetected: detected, elapsedTime: elapsed, diagnostics } = state.props;

  ctx.fillStyle = 'rgba(8, 16, 28, 0.7)';
  ctx.fillRect(header.x, header.y, header.w, header.h);
  ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
  ctx.beginPath();
  ctx.moveTo(0, header.y + header.h);
  ctx.lineTo(header.w, header.y + header.h);
  ctx.stroke();

  const pulse = (Math.sin(state.now / 400) + 1) / 2;
  const statusColor = state.props.isMonitoring ? COLORS.SIGNAL : (state.props.preserveResults ? COLORS.TEXT_INFO : COLORS.TEXT_DIM);
  ctx.beginPath();
  ctx.arc(16, header.y + 18, 5, 0, Math.PI * 2);
  ctx.fillStyle = state.props.isMonitoring
    ? `rgba(34, 197, 94, ${0.55 + pulse * 0.45})`
    : statusColor;
  ctx.fill();

  ctx.font = `bold 11px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_PRIMARY;
  ctx.textAlign = 'left';
  ctx.fillText(state.props.isMonitoring ? 'MONITOREANDO' : (state.props.preserveResults ? 'RESULTADOS' : 'EN ESPERA'), 28, header.y + 22);

  const d = new Date(state.now);
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

  ctx.textAlign = 'right';
  const qColor = quality > 60 ? COLORS.TEXT_PRIMARY : quality > 30 ? COLORS.TEXT_WARN : (quality > 0 ? COLORS.TEXT_DANGER : COLORS.TEXT_DIM);
  ctx.fillStyle = qColor;
  ctx.fillText(`SQI ${Math.round(quality)}%`, header.w - 16, header.y + 22);

  if (state.props.isMonitoring) {
    const elapStr = `⏱ ${em}:${es}`;
    ctx.font = `11px ${FONT_MONO}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.fillText(elapStr, 160, header.y + 22);
  }

  ctx.font = `10px ${FONT_MONO}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = detected ? COLORS.TEXT_PRIMARY : COLORS.TEXT_DIM;
  ctx.fillText(detected ? '● DEDO OK' : '○ SIN DEDO', header.w - 110, header.y + 22);

  const diag = diagnostics;
  const hideLowFlicker =
    diag?.status === 'LOW_SIGNAL_QUALITY' &&
    diag.hasPulsatility === true;
  const placementHint =
    typeof diag?.placementHint === 'string' ? diag.placementHint : '';
  const stage = diag?.acquisitionStage;
  // Blockers accionables (el usuario puede corregirlos) tienen prioridad sobre
  // el mensaje calmado de "estabilizando".
  const hardBlocker =
    diag?.status === 'MOTION_ARTIFACT' ||
    diag?.status === 'SATURATED' ||
    diag?.status === 'UNDEREXPOSED' ||
    diag?.status === 'LOW_FPS' ||
    diag?.status === 'TORCH_UNAVAILABLE';

  if (detected && stage === 'STABILIZING' && !hardBlocker) {
    const pct = Math.round((diag?.acquisitionProgress ?? 0) * 100);
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(`ESTABILIZANDO SEÑAL · ${pct}%`, header.w / 2, header.y + 12);
  } else if (placementHint && detected && stage === 'READY') {
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
}

export function drawMetricsBar(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { metrics } = state.layout;
  const { pressure, perfusionIndex: pi, arrhythmiaStatus: arr, arrhythmiaCount: arrCnt } = state.props;

  ctx.fillStyle = 'rgba(6, 12, 22, 0.85)';
  ctx.fillRect(metrics.x, metrics.y, metrics.w, metrics.h);
  ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
  ctx.beginPath();
  ctx.moveTo(0, metrics.y + metrics.h);
  ctx.lineTo(metrics.w, metrics.y + metrics.h);
  ctx.stroke();

  const colW = metrics.w / 3;

  ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(colW, metrics.y + 8); ctx.lineTo(colW, metrics.y + metrics.h - 8);
  ctx.moveTo(colW * 2, metrics.y + 8); ctx.lineTo(colW * 2, metrics.y + metrics.h - 8);
  ctx.stroke();

  const dispBpm = state.displayBpm;
  const dispSpo2 = state.displaySpo2;
  const dispSys = state.displaySys;
  const dispDia = state.displayDia;
  const hrColor = dispBpm <= 0 ? COLORS.TEXT_DIM
    : dispBpm < 50 ? COLORS.TEXT_DANGER
    : dispBpm < 60 ? COLORS.TEXT_WARN
    : dispBpm <= 100 ? COLORS.TEXT_PRIMARY
    : dispBpm <= 120 ? COLORS.TEXT_WARN
    : COLORS.TEXT_DANGER;

  ctx.font = `bold 10px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_SECONDARY;
  ctx.textAlign = 'left';
  ctx.fillText('FRECUENCIA CARDÍACA', 16, metrics.y + 26);

  ctx.font = `bold 56px ${FONT_MONO}`;
  ctx.fillStyle = hrColor;
  const heartPulse = state.props.isMonitoring && dispBpm > 30 ? (Math.sin(state.now / (60000 / Math.max(60, dispBpm)) * 2 * Math.PI) + 1) / 2 : 0;
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

  const s = state.bpmStats;
  if (s.n > 0) {
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'right';
    ctx.fillText(`min:${s.min} max:${s.max}`, colW - 12, metrics.y + 26);
  }

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

  if (pi > 0) {
    ctx.font = `9px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'left';
    ctx.fillText(`PI ${(pi * 100).toFixed(2)}%`, colW + 16, metrics.y + 90);
  }

  const sys = dispSys > 0 ? dispSys : pressure?.systolic || 0;
  const dia = dispDia > 0 ? dispDia : pressure?.diastolic || 0;
  const map = sys > 0 && dia > 0 ? Math.round(dia + (sys - dia) / 3) : 0;
  const pp = sys > 0 && dia > 0 ? sys - dia : 0;

  const bpColor = sys <= 0 ? COLORS.TEXT_DIM
    : sys >= 140 || dia >= 90 ? COLORS.TEXT_DANGER
    : sys >= 130 || dia >= 80 ? COLORS.TEXT_WARN
    : sys < 90 || dia < 60 ? COLORS.TEXT_WARN
    : COLORS.BP;

  const bpX = colW * 2 + 4;

  ctx.font = `bold 10px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_SECONDARY;
  ctx.textAlign = 'left';
  ctx.fillText('PRESIÓN ART.', bpX, metrics.y + 26);

  ctx.font = `bold 28px ${FONT_MONO}`;
  ctx.fillStyle = bpColor;
  const bpPending =
    state.props.isMonitoring &&
    sys <= 0 &&
    (state.props.bpStatus === 'INSUFFICIENT_WINDOW' ||
      state.props.bpStatus === 'NO_VALID_SIGNAL' ||
      state.props.bpStatus === 'WARMUP');
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

  const rhythm = buildRhythmPanel(
    arr,
    arrCnt ?? 0,
    state.props.rrIntervals ?? [],
    state.hrv,
  );
  if (rhythm.level === 'danger' || rhythm.level === 'warn') {
    ctx.fillStyle =
      rhythm.level === 'danger' ? 'rgba(127, 29, 29, 0.75)' : 'rgba(120, 53, 15, 0.65)';
    ctx.fillRect(metrics.x + 12, metrics.y + 2, metrics.w - 24, 18);
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = rhythm.level === 'danger' ? '#fecaca' : '#fde68a';
    ctx.textAlign = 'center';
    ctx.fillText(rhythm.title, metrics.w / 2, metrics.y + 14);
  }

  const fps = state.props.diagnostics?.sqm?.fpsEffective || 0;
  const jitter = state.props.diagnostics?.sqm?.timestampJitterMs || 0;
  const pd = state.props.diagnostics?.peakDetection as
    | { confidence?: number; agreement?: { elgendi?: number } }
    | undefined;
  if (fps > 0) {
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'right';
    ctx.fillText(`${fps.toFixed(1)} FPS · Δ${jitter.toFixed(1)}ms`, metrics.w - 12, metrics.y + 12);
  }
  if (pd && typeof pd.confidence === 'number' && pd.confidence > 0) {
    const ae = pd.agreement?.elgendi ?? 0;
    ctx.font = `8px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.textAlign = 'right';
    ctx.fillText(
      `Picos ensemble ${(pd.confidence * 100).toFixed(0)}% · E${(ae * 100).toFixed(0)}`,
      metrics.w - 12,
      metrics.y + (fps > 0 ? 24 : 12)
    );
  }
}

export function drawECGGrid(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { plot } = state.layout;

  const grad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
  grad.addColorStop(0, 'rgba(6, 12, 22, 0.25)');
  grad.addColorStop(0.5, 'rgba(10, 18, 30, 0.18)');
  grad.addColorStop(1, 'rgba(6, 12, 22, 0.25)');
  ctx.fillStyle = grad;
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  const pxPerMm = Math.max(4, Math.min(8, plot.h / 30));
  const minor = pxPerMm;
  const major = pxPerMm * 5;

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

  const oneSec = 25 * pxPerMm;
  ctx.strokeStyle = COLORS.GRID_SEC;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let x = plot.x + plot.w; x >= plot.x; x -= oneSec) {
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
  }
  ctx.stroke();

  ctx.strokeStyle = COLORS.BASELINE;
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.centerY);
  ctx.lineTo(plot.x + plot.w, plot.centerY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = COLORS.PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

  const seconds = Math.floor(WINDOW_MS / 1000);
  ctx.font = `bold 9px ${FONT_MONO}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  for (let s = 0; s <= seconds; s++) {
    const x = plot.x + plot.w - (s / seconds) * plot.w;
    ctx.fillText(`-${s}s`, x, plot.y + plot.h + 12);
  }

  const stats = state.amplitudeStats;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 9px ${FONT_MONO}`;
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = plot.y + (i / 4) * plot.h;
    const val = stats.max - (i / 4) * stats.range;
    ctx.fillText(val.toFixed(0), plot.x - 4, y + 3);
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.TEXT_DIM;
  ctx.font = `9px ${FONT_MONO}`;
  ctx.fillText('25 mm/s · 0.3–5 Hz · PPG-RG', plot.x + 4, plot.y - 4);
}

export function drawSignal(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const buffer = state.buffer;
  if (!buffer) return;
  const { plot } = state.layout;
  const p = state.props;

  if (p.preserveResults && !p.isFingerDetected) return;

  const scaledValue = p.value * state.waveGain;
  if (p.isPeak) state.sweepPulse = 1;

  if (p.isPeak) {
    const peakAge = state.now - state.lastPeakProcessedTime;
    if (peakAge > 200) {
      state.lastPeakProcessedTime = state.now;

      const currentCount = p.arrhythmiaCount || 0;
      const rrArr = p.rrIntervals;
      const lastRR = rrArr && rrArr.length > 0 ? rrArr[rrArr.length - 1] : 0;

      const isNewArr = currentCount > state.lastArrhythmiaCount;

      if (isNewArr) {
        state.lastArrhythmiaCount = currentCount;
        state.pendingTrendArr = true;
        const retroRR = lastRR > 0 ? lastRR : 800;
        const retroDuration = Math.min(Math.max(retroRR, 400), 1500);
        buffer.markArrhythmiaBack(retroDuration * 0.35);
        state.arrActiveUntil = state.now + retroDuration * 0.65;
      }
      const storedRR = isPhysiologicalRR(lastRR) ? Math.round(lastRR) : 0;
      state.beatHistory.push({
        isArrhythmia: isNewArr,
        time: state.now - VISUAL_DELAY_MS,
        rr: storedRR,
      });
      if (state.beatHistory.length > BEAT_HISTORY_MAX) {
        state.beatHistory = state.beatHistory.slice(-BEAT_HISTORY_MAX);
      }
    }
  }

  buffer.push({ time: state.now, value: scaledValue, isArrhythmia: state.now < state.arrActiveUntil });

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
    const stats = state.amplitudeStats;
    const targetMin = mn - range * 0.1;
    const targetMax = mx + range * 0.1;
    const expanding = targetMax - targetMin > stats.range;
    const blend = expanding ? AMP_ATTACK : AMP_RELEASE;
    stats.min = stats.min * (1 - blend) + targetMin * blend;
    stats.max = stats.max * (1 - blend) + targetMax * blend;
    stats.range = stats.max - stats.min;
  }

  const stats = state.amplitudeStats;
  if (points.length < 2) return;

  const safeRange = stats.range > 1 ? stats.range : 1;

  const wavePadTop = 12;
  const wavePadBot = RR_TACHO_H + 12;
  const waveH = Math.max(40, plot.h - wavePadTop - wavePadBot);
  const waveBaseY = plot.y + wavePadTop + waveH;

  const coords: { x: number; y: number; isArr: boolean }[] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const age = state.now - pt.time - VISUAL_DELAY_MS;
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
      fillGrad.addColorStop(0, 'rgba(248, 113, 113, 0.08)');
      fillGrad.addColorStop(1, 'rgba(127, 29, 29, 0.01)');
    } else {
      fillGrad.addColorStop(0, 'rgba(34, 197, 94, 0.05)');
      fillGrad.addColorStop(1, 'rgba(34, 197, 94, 0.005)');
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

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const drawDirectSegment = (startIdx: number, endIdx: number) => {
    ctx.beginPath();
    ctx.moveTo(coords[startIdx].x, coords[startIdx].y);
    for (let k = startIdx + 1; k < endIdx; k++) {
      ctx.lineTo(coords[k].x, coords[k].y);
    }
  };

  const totalLen = coords.length;
  const recentCut = Math.max(0, totalLen - Math.floor(totalLen * 0.35));
  const leadingCut = Math.max(0, totalLen - Math.floor(totalLen * 0.10));

  ctx.shadowBlur = 0;
  seg = 0;
  while (seg < totalLen - 1) {
    const isArr = coords[seg].isArr;
    let segEnd = seg;
    while (segEnd < totalLen - 1 && coords[segEnd].isArr === isArr) segEnd++;
    const segEndClamped = segEnd + 1 > totalLen ? segEnd : segEnd + 1;
    drawDirectSegment(seg, segEndClamped);
    ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.35)' : 'rgba(34, 197, 94, 0.38)';
    ctx.lineWidth = 3.5;
    ctx.shadowBlur = 0;
    ctx.stroke();
    seg = segEnd;
  }

  ctx.shadowColor = COLORS.SIGNAL_GLOW;
  ctx.shadowBlur = 6;
  seg = Math.max(recentCut, 0);
  while (seg < totalLen - 1) {
    const isArr = coords[seg].isArr;
    let segEnd = seg;
    while (segEnd < totalLen - 1 && coords[segEnd].isArr === isArr) segEnd++;
    const segEndClamped = segEnd + 1 > totalLen ? segEnd : segEnd + 1;
    drawDirectSegment(seg, segEndClamped);
    ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.55)' : 'rgba(34, 197, 94, 0.58)';
    ctx.lineWidth = 3;
    ctx.stroke();
    seg = segEnd;
  }

  ctx.shadowBlur = 12;
  seg = Math.max(leadingCut, 0);
  while (seg < totalLen - 1) {
    const isArr = coords[seg].isArr;
    let segEnd = seg;
    while (segEnd < totalLen - 1 && coords[segEnd].isArr === isArr) segEnd++;
    const segEndClamped = segEnd + 1 > totalLen ? segEnd : segEnd + 1;
    drawDirectSegment(seg, segEndClamped);
    ctx.strokeStyle = isArr ? 'rgba(239, 68, 68, 0.75)' : '#4ade80';
    ctx.lineWidth = 2.8;
    ctx.shadowColor = isArr ? COLORS.SIGNAL_ARR_GLOW : COLORS.SIGNAL_GLOW;
    ctx.stroke();
    seg = segEnd;
  }

  state.sweepPulse *= 0.75;
  const head = coords[coords.length - 1];
  if (head) {
    const pulse = Math.max(state.sweepPulse, 0.04);
    ctx.shadowBlur = 6;

    ctx.strokeStyle = head.isArr ? 'rgba(248, 113, 113, 0.50)' : 'rgba(34, 197, 94, 0.5)';
    ctx.lineWidth = 1.2;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(head.x, plot.y + wavePadTop);
    ctx.lineTo(head.x, plot.y + plot.h - wavePadBot + 8);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(head.x, head.y, 5 + pulse * 8, 0, Math.PI * 2);
    ctx.fillStyle = head.isArr ? 'rgba(248, 113, 113, 0.25)' : 'rgba(34, 197, 94, 0.25)';
    ctx.shadowBlur = 20 + pulse * 15;
    ctx.shadowColor = head.isArr ? COLORS.SIGNAL_ARR_GLOW : COLORS.SIGNAL_GLOW;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(head.x, head.y, 2.8, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 10 + pulse * 12;
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  const visiblePeaks: { x: number; y: number; isArr: boolean; time: number }[] = [];
  for (const beat of state.beatHistory) {
    const age = state.now - beat.time - VISUAL_DELAY_MS;
    if (age > WINDOW_MS || age < 0) continue;
    const x = plot.x + plot.w - (age * plot.w / WINDOW_MS);
    if (x < plot.x || x > plot.x + plot.w) continue;
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

  const pdOverlay = state.props.diagnostics?.peakDetection;
  const detectorPeaks: { x: number; y: number }[] = [];
  if (pdOverlay?.elgendiPeakTimes) {
    for (const peakTime of pdOverlay.elgendiPeakTimes) {
      const age = state.now - peakTime - VISUAL_DELAY_MS;
      if (age > WINDOW_MS || age < 0) continue;
      const x = plot.x + plot.w - (age * plot.w / WINDOW_MS);
      if (x < plot.x || x > plot.x + plot.w) continue;
      let nearestPt: PPGDataPoint | null = null;
      let minDist = Infinity;
      for (const pt of points) {
        const d = Math.abs(pt.time - peakTime);
        if (d < minDist) { minDist = d; nearestPt = pt; }
      }
      if (nearestPt && minDist < 280) {
        const y = plot.y + wavePadTop + ((stats.max - nearestPt.value) / safeRange) * waveH;
        detectorPeaks.push({ x, y });
      }
    }
  }

  for (const dp of detectorPeaks) {
    ctx.beginPath();
    ctx.arc(dp.x, dp.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#22d3ee';
    ctx.fill();
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (const peak of visiblePeaks) {
    ctx.save();
    ctx.strokeStyle = peak.isArr ? 'rgba(239,68,68,0.30)' : 'rgba(34,197,94,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(peak.x, plot.y);
    ctx.lineTo(peak.x, plot.y + plot.h);
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(peak.x, peak.y, peak.isArr ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = peak.isArr ? COLORS.PEAK_ARR : COLORS.PEAK_NORMAL;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(peak.x, peak.y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    if (peak.isArr) {
      ctx.beginPath();
      ctx.arc(peak.x, peak.y, 10, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = `bold 8px ${FONT_MONO}`;
      ctx.fillStyle = '#fecaca';
      ctx.textAlign = 'center';
      ctx.fillText('ARR', peak.x, peak.y - 12);
    }
  }

  const rrForLabels = state.props.rrIntervals ?? [];
  const validRr = rrForLabels.filter((r) => isPhysiologicalRR(r));
  const meanIbi =
    validRr.length > 0 ? validRr.reduce((a, v) => a + v, 0) / validRr.length : state.ibiDisplay;

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

  const rhythm = buildRhythmPanel(
    p.arrhythmiaStatus,
    p.arrhythmiaCount ?? 0,
    p.rrIntervals ?? [],
    state.hrv,
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
}

/**
 * Overlay calmado durante la fase de estabilización inicial. Atenúa el trazo
 * ruidoso del warm-up y muestra un progreso firme, dando una experiencia de
 * colocación de dedo cómoda y sin parpadeo. No se dibuja en READY (trazo limpio).
 */
export function drawAcquisitionOverlay(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const p = state.props;
  const diag = p.diagnostics;
  if (!diag || diag.acquisitionStage !== 'STABILIZING') return;
  if (!p.isFingerDetected || p.preserveResults) return;

  const { plot } = state.layout;
  const progress = Math.max(0, Math.min(1, diag.acquisitionProgress ?? 0));
  const cx = plot.x + plot.w / 2;
  const cy = plot.centerY;
  const pulse = (Math.sin(state.now / 520) + 1) / 2;

  ctx.save();

  // Panel translúcido sobre el área de señal para calmar el trazo inicial.
  ctx.fillStyle = 'rgba(2, 6, 12, 0.72)';
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.TEXT_INFO;
  ctx.font = `bold 15px ${FONT_MONO}`;
  ctx.fillText('ESTABILIZANDO SEÑAL', cx, cy - 34);

  // Barra de progreso firme (monótona, sin saltos).
  const barW = Math.min(280, plot.w - 64);
  const barH = 8;
  const barX = cx - barW / 2;
  const barY = cy - 8;

  ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.fillRect(barX, barY, barW, barH);

  const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  grad.addColorStop(0, 'rgba(34, 197, 94, 0.85)');
  grad.addColorStop(1, 'rgba(103, 232, 249, 0.95)');
  ctx.fillStyle = grad;
  ctx.fillRect(barX, barY, Math.max(barH, barW * progress), barH);

  ctx.fillStyle = COLORS.TEXT_PRIMARY;
  ctx.font = `bold 22px ${FONT_MONO}`;
  ctx.fillText(`${Math.round(progress * 100)}%`, cx, barY + 40);

  ctx.fillStyle = `rgba(148, 163, 184, ${(0.55 + pulse * 0.35).toFixed(2)})`;
  ctx.font = `11px ${FONT_MONO}`;
  ctx.fillText('Mantenga el dedo firme y quieto', cx, barY + 62);

  ctx.restore();
}

export function drawTrendStrip(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { trend } = state.layout;
  if (trend.w < 80 || trend.h < 36) return;

  const compact = trend.h < 92;

  ctx.fillStyle = COLORS.PANEL_BG;
  ctx.fillRect(trend.x, trend.y, trend.w, trend.h);
  ctx.strokeStyle = COLORS.PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(trend.x + 0.5, trend.y + 0.5, trend.w - 1, trend.h - 1);

  const data = state.bpmTrend;
  const hrv = state.hrv;
  const arrCnt = state.props.arrhythmiaCount ?? 0;

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
  for (const point of data) {
    if (point.bpm < mn) mn = point.bpm;
    if (point.bpm > mx) mx = point.bpm;
    sum += point.bpm;
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

  const coords: { x: number; y: number; isArr: boolean }[] = data.map((point) => ({
    x: xToPx(point.t),
    y: yToPx(point.bpm),
    isArr: point.isArr,
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
}

export function drawFooter(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const { footer } = state.layout;
  const { bpm, spo2, pressure, perfusionIndex: pi } = state.props;

  ctx.fillStyle = 'rgba(6, 12, 22, 0.95)';
  ctx.fillRect(footer.x, footer.y, footer.w, footer.h);
  ctx.strokeStyle = COLORS.PANEL_BORDER_DIM;
  ctx.beginPath();
  ctx.moveTo(0, footer.y);
  ctx.lineTo(footer.w, footer.y);
  ctx.stroke();

  const hrv = state.hrv;
  ctx.font = `10px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_DIM;
  ctx.textAlign = 'left';
  ctx.fillText('HRV', footer.x + 12, footer.y + 12);

  const cells = [
    { label: 'IBI', value: state.ibiDisplay > 0 ? `${state.ibiDisplay}ms` : '--', color: COLORS.TEXT_INFO },
    { label: 'SDNN', value: hrv.sdnn > 0 ? `${hrv.sdnn}ms` : '--', color: COLORS.TEXT_SECONDARY },
    { label: 'RMSSD', value: hrv.rmssd > 0 ? `${hrv.rmssd}ms` : '--', color: COLORS.TEXT_SECONDARY },
    { label: 'pNN50', value: hrv.pnn50 > 0 ? `${hrv.pnn50}%` : '--', color: COLORS.TEXT_SECONDARY },
    { label: 'CV', value: hrv.cv > 0 ? hrv.cv.toFixed(2) : '--', color: COLORS.TEXT_SECONDARY },
  ];

  const hrvSectionWidth = footer.w * 0.55;
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

  const map = pressure?.systolic && pressure?.diastolic
    ? Math.round(pressure.diastolic + (pressure.systolic - pressure.diastolic) / 3)
    : 0;
  const alarms: string[] = [];
  if (bpm != null && bpm > 0 && (bpm < 50 || bpm > 120)) alarms.push('HR');
  if (spo2 > 0 && spo2 < 92) alarms.push('SpO₂');
  if (map > 0 && (map < 65 || map > 110)) alarms.push('MAP');
  if (pi > 0 && pi < 0.005) alarms.push('PI');

  ctx.textAlign = 'right';
  if (alarms.length > 0) {
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DANGER;
    ctx.fillText(`⚠ ALARMA: ${alarms.join(' · ')}`, footer.x + footer.w - 12, footer.y + 16);
  } else if (bpm != null && bpm > 0) {
    ctx.font = `bold 10px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.fillText('● SIN ALARMAS', footer.x + footer.w - 12, footer.y + 16);
  }

  const beats = state.beatHistory;
  if (beats.length > 0) {
    const showN = Math.min(beats.length, 18);
    const dotSize = 3;
    const gap = 3;
    const totalW = showN * (dotSize * 2 + gap) - gap;
    const startX = footer.x + footer.w - 12 - totalW;
    const dy = footer.y + 36;
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
}
