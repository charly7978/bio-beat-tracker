import { CircularBuffer } from '../../utils/CircularBuffer';
import { isPhysiologicalRR } from '../../utils/physio';
import {
  buildRhythmPanel,
  formatContactState,
} from './ppgMonitorClinical';
import { drawWaveRibbon3D } from './ppg3dProjection';

export const FONT_MONO = '"SF Mono", Consolas, "Roboto Mono", monospace';

export const COLORS = {
  BG_TOP: '#06090f',
  BG_BOTTOM: '#020409',
  PANEL_BG: 'rgba(10, 18, 30, 0.92)',
  PANEL_BORDER: 'rgba(34, 197, 94, 0.32)',
  PANEL_BORDER_DIM: 'rgba(148, 163, 184, 0.18)',
  GRID_MINOR: 'rgba(255, 255, 255, 0.22)',
  GRID_MAJOR: 'rgba(255, 255, 255, 0.40)',
  GRID_SEC: 'rgba(255, 255, 255, 0.55)',
  SCANLINE: 'rgba(255, 255, 255, 0.012)',
  BASELINE: 'rgba(255, 255, 255, 0.25)',
  SIGNAL: '#22c55e',
  SIGNAL_GLOW: 'rgba(34, 197, 94, 0.45)',
  SIGNAL_ARR: '#ef4444',
  SIGNAL_ARR_GLOW: 'rgba(239, 68, 68, 0.45)',
  PEAK_NORMAL: '#00f2ff',
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

/**
 * TABLA DE CONSTANTES CONFIGURABLES PARA LAS ONDAS CARDÍACAS (PPG MONITOR)
 * 
 * Modifica estos valores para calibrar detalladamente la visualización de la onda
 * y ajustar el comportamiento de los trazos, brillo, auto-escala y marcadores fiduciales.
 */
export const CARDIAC_WAVE_CONFIG = {
  // === Ventana de Tiempo e Historial ===
  /**
   * Ventana de tiempo visualizada en pantalla en milisegundos.
   * - ¿Qué significa?: El lapso de tiempo físico de señal representado de izquierda a derecha.
   * - Si se sube (ej. 2500 - 3500): La onda se comprime horizontalmente (se ven más ciclos en pantalla, dando un aspecto veloz o de "látigo").
   * - Si se baja (ej. 1500 - 2000): La onda se estira horizontalmente (se ven menos ciclos, dibujo lento y detallado).
   */
  WINDOW_MS: 2200,

  /**
   * Capacidad del buffer circular de almacenamiento de señal.
   * - ¿Qué significa?: Cantidad de muestras históricas máximas guardadas para dibujar en el Canvas.
   * - Si se sube: Retiene más muestras históricas de la señal (evita cortes visuales si la tasa de muestreo sube).
   * - Si se baja: Reduce el uso de memoria RAM, pero si se baja demasiado la onda podría truncarse.
   */
  BUFFER_SIZE: 2500,

  /**
   * Retraso visual de renderizado en milisegundos.
   * - ¿Qué significa?: Tiempo de espera artificial antes de graficar la señal entrante.
   * - Si se sube: La onda tarda más en aparecer en el gráfico, desfasándola hacia el pasado.
   * - Si se baja: La onda se dibuja de forma más instantánea y reactiva en tiempo real.
   */
  VISUAL_DELAY_MS: 0,

  // === Auto-escala de Amplitud (Ajuste dinámico Y) ===
  /**
   * Coeficiente de ataque (crecimiento) del escalado automático de amplitud.
   * - ¿Qué significa?: Qué tan rápido se expande la escala vertical cuando la señal de entrada aumenta de tamaño.
   * - Si se sube: La onda se adapta instantáneamente a picos de gran amplitud (evita que se corte por arriba/abajo).
   * - Si se baja: La onda cambia su tamaño vertical más despacio, suavizando transiciones bruscas.
   */
  AMP_ATTACK: 0.50,

  /**
   * Coeficiente de relajación (decrecimiento) del escalado automático de amplitud.
   * - ¿Qué significa?: Qué tan rápido se contrae la escala vertical cuando la amplitud de la señal decae.
   * - Si se sube: La onda recupera tamaño visual de forma veloz cuando la señal de entrada se debilita.
   * - Si se baja: Mantiene la escala amplia por más tiempo, evitando vibraciones molestas si la amplitud fluctúa.
   */
  AMP_RELEASE: 0.30,

  // === Estética y Grosor de Línea (Canvas Rendering) ===
  /**
   * Grosor de la línea principal de la onda.
   * - ¿Qué significa?: El ancho en píxeles del trazo base de la señal.
   * - Si se sube: Onda más gruesa, densa y visible en pantallas de alta densidad de píxeles.
   * - Si se baja: Onda más fina, nítida y con un look clínico o médico de alta precisión (efecto "eléctrico").
   */
  BASE_STROKE_WIDTH: 2.0,

  /**
   * Grosor de la línea de brillo secundaria.
   */
  GLOW_STROKE_WIDTH: 1.6,

  /**
   * Grosor de la punta o cabeza de la onda de barrido.
   */
  LEADING_STROKE_WIDTH: 1.5,

  /**
   * Desenfoque de sombra del cuerpo de la señal (Glow).
   */
  SHADOW_BLUR_BASE: 8,

  /**
   * Desenfoque de sombra de la punta o cabeza conductora de la señal.
   */
  SHADOW_BLUR_LEADING: 15,

  // === Marcadores Fisiológicos (Fiduciales) ===
  /**
   * Radio del punto indicador del Pico Sistólico (SYS).
   * - ¿Qué significa?: Tamaño del círculo cian en el punto máximo de cada latido.
   * - Si se sube: Círculos marcadores sistólicos más grandes y fáciles de identificar.
   * - Si se baja: Círculos más pequeños y discretos en los picos.
   */
  SYS_PEAK_RADIUS: 3.5,

  /**
   * Radio del indicador del Valle Diastólico (DIA).
   * - ¿Qué significa?: Diámetro del anillo gris de marcación en el punto mínimo del latido.
   * - Si se sube: Marcador diastólico más grande y visible.
   * - Si se baja: Marcador diastólico más diminuto.
   */
  DIA_VALLEY_RADIUS: 2.4,

  /**
   * Radio del indicador de la Muesca Dícrota (DIC).
   * - ¿Qué significa?: Tamaño del punto cian claro que resalta el rebote elástico aórtico.
   * - Si se sube: Marcador de muesca dícrota más grande y notorio.
   * - Si se baja: Marcador más imperceptible y minimalista.
   */
  DIC_NOTCH_RADIUS: 2.4,

  /**
   * Radio del anillo de alarma rojo para latidos con arritmia (ARR).
   * - ¿Qué significa?: El diámetro del círculo exterior rojo que envuelve los picos anómalos.
   * - Si se sube: El anillo se expande más lejos de la coordenada del pico.
   * - Si se baja: El anillo abraza estrechamente y de cerca el pico con arritmia.
   */
  ARR_WARNING_RADIUS: 10.0,

  /**
   * Grosor de la línea del anillo de advertencia de arritmia.
   * - ¿Qué significa?: Ancho del trazo circular de alerta roja.
   * - Si se sube: Anillo más grueso, visible y alarmante.
   * - Si se baja: Anillo rojo más fino y discreto.
   */
  ARR_WARNING_WIDTH: 1.5,

  // === Cursor Conductor (Punta de Barrido) ===
  /**
   * Radio base del halo pulsátil que sigue a la punta del barrido.
   * - ¿Qué significa?: El tamaño base del círculo que late al ritmo del pulso al frente del barrido.
   * - Si se sube: Aura de barrido de mayor tamaño y dinamismo.
   * - Si se baja: Aura pequeña y compacta en el extremo del trazado.
   */
  HEAD_PULSE_BASE_RADIUS: 6.0,

  /**
   * Radio del núcleo central blanco en la punta conductora del barrido.
   */
  HEAD_PULSE_INNER_RADIUS: 3.0,

  // === Márgenes y Límites de Dibujo ===
  /**
   * Margen superior de la onda en el gráfico.
   * - ¿Qué significa?: Espacio vacío superior en píxeles para que la onda no solape los textos superiores del monitor.
   * - Si se sube: Desplaza la onda hacia abajo, comprimiendo el área útil de dibujo.
   * - Si se baja: Permite que la onda se desplace más arriba en pantalla.
   */
  WAVE_PAD_TOP: 20,

  /**
   * Margen inferior de la onda en el gráfico.
   * - ¿Qué significa?: Espacio vacío inferior en píxeles antes del tacograma para evitar solapamientos.
   * - Si se sube: Comprime la onda hacia arriba, alejándola del tacograma.
   * - Si se baja: Permite que los valles de la onda bajen más cerca de la sección del tacograma.
   */
  WAVE_PAD_BOTTOM: 44,

  // === Tiempos de Reacción y Velocidades Dinámicas ===
  /**
   * Velocidad de amortiguación (desvanecimiento) de la punta conductora tras cada latido.
   * - ¿Qué significa?: Factor multiplicador por cuadro que reduce el tamaño del halo del cursor (sweepPulse).
   * - Si se sube: El halo brillante de la punta se apaga más lentamente, dejando un rastro luminoso más largo.
   * - Si se baja: El halo se apaga de forma abrupta y veloz.
   */
  SWEEP_PULSE_DECAY: 0.90,

  /**
   * Tiempo de rebote (debounce) mínimo entre picos registrados en milisegundos.
   * - ¿Qué significa?: El tiempo de espera mínimo necesario para procesar visualmente el siguiente latido y evitar falsas detecciones duplicadas.
   * - Si se sube: Evita falsos picos por ruido, pero puede ignorar latidos reales si la frecuencia cardíaca es extremadamente alta (taquicardia).
   * - Si se baja: Aumenta la sensibilidad ante frecuencias altas, pero puede duplicar marcas visuales en un solo latido.
   */
  PEAK_DEBOUNCE_MS: 250,

  /**
   * Intervalo RR (IBI) por defecto utilizado cuando no hay mediciones previas.
   * - ¿Qué significa?: El valor base de intervalo entre latidos en milisegundos para inicializar cálculos de ritmo.
   * - Si se sube: La duración de la ventana de análisis inicial es mayor.
   * - Si se baja: La duración de la ventana inicial es menor.
   */
  DEFAULT_RR_INTERVAL_MS: 800,

  /**
   * Límite de duración fisiológica mínimo para el cálculo de alineación de arritmias en milisegundos.
   * - ¿Qué significa?: El intervalo RR mínimo aceptado en el mapeo visual de la alerta.
   * - Si se sube: Agranda el intervalo mínimo a marcar.
   * - Si se baja: Permite marcar anomalías extremadamente rápidas.
   */
  MIN_ARR_DURATION_MS: 400,

  /**
   * Límite de duración fisiológica máximo para el cálculo de alineación de arritmias en milisegundos.
   * - ¿Qué significa?: El intervalo RR máximo aceptado en el mapeo visual de la alerta.
   * - Si se sube: Permite que las marcas de arritmia persistan en el tiempo de manera prolongada.
   * - Si se baja: Acorta el tiempo máximo en pantalla que dura el trazo rojo.
   */
  MAX_ARR_DURATION_MS: 1500,

  /**
   * Factor de alineación retrógrada para el marcado de arritmias.
   * - ¿Qué significa?: La proporción del intervalo RR que se pinta de rojo hacia atrás en el tiempo a partir del pico detectado.
   * - Si se sube: La alerta roja abarca una porción mayor del trazado de la onda antes del pico.
   * - Si se baja: La alerta se concentra solo sobre el pico o ligeramente después.
   */
  ARR_RETRO_ALIGN_FACTOR: 0.35,

  /**
   * Factor de alineación anterógrada para el marcado de arritmias.
   * - ¿Qué significa?: La proporción del intervalo RR que la alerta roja se mantiene activa hacia adelante en el tiempo a partir del pico.
   * - Si se sube: El color rojo de la alerta persiste durante más tiempo en el barrido que se desplaza.
   * - Si se baja: El color rojo desaparece rápidamente después de que pasa el pico.
   */
  ARR_ANTERO_ALIGN_FACTOR: 1.65,

  /**
   * Exponente de agudeza visual para controlar la velocidad de subida y bajada de la onda.
   * - ¿Qué significa?: Distorsión no-lineal matemática aplicada exclusivamente al trazado del Canvas.
   * - Si se sube (ej. 1.3 - 1.7): Hace que la subida al pico sistólico y la caída posterior sean visualmente mucho más rápidas y agudas (efecto "látigo" o "relámpago").
   * - Si se baja (ej. 1.0): La onda se grafica de forma 100% lineal y fiel a la fisiología pura sin distorsión.
   * - ¡ATENCIÓN!: Esta constante es 100% visual y estética. No afecta la lógica interna de captación de latidos ni las matemáticas médicas del procesador, por lo que es totalmente seguro calibrarla sin alterar la detección de pulso.
   */
  WAVE_SHARPNESS_EXPONENT: 1.75,
};

// Exportaciones individuales para mantener compatibilidad total con componentes importadores externos (como PPGSignalMeter.tsx)
export const TARGET_FPS = 60;
export const WINDOW_MS = CARDIAC_WAVE_CONFIG.WINDOW_MS;
export const BUFFER_SIZE = CARDIAC_WAVE_CONFIG.BUFFER_SIZE;
export const TREND_WINDOW_MS = 60_000;
export const TREND_MAX_POINTS = 240;
export const BEAT_HISTORY_MAX = 30;
export const VISUAL_DELAY_MS = CARDIAC_WAVE_CONFIG.VISUAL_DELAY_MS;
export const AMP_ATTACK = CARDIAC_WAVE_CONFIG.AMP_ATTACK;
export const AMP_RELEASE = CARDIAC_WAVE_CONFIG.AMP_RELEASE;
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
    fingerPressure?: 'LIGHT' | 'IDEAL' | 'HEAVY';
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
  /** Latch: la onda solo se revela cuando la señal se ESTABILIZÓ (adquisición READY). */
  traceRevealed: boolean;
  /** Fuerza pulsátil real [0..1]: comprime la altura de la onda (objeto inerte → plana). */
  signalStrength: number;
  /**
   * Capa de presentación 3D (perspectiva pura en canvas 2D). Si `enabled`, la grilla
   * se dibuja como piso en perspectiva y la onda como cinta extruida. La onda reusa
   * las MISMAS coords honestas → misma forma/amplitud/tiempo que el modo 2D.
   */
  threeD?: { enabled: boolean; intensity?: number };
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
  const hardBlocker =
    diag?.status === 'MOTION_ARTIFACT' ||
    diag?.status === 'SATURATED' ||
    diag?.status === 'UNDEREXPOSED' ||
    diag?.status === 'LOW_FPS' ||
    diag?.status === 'TORCH_UNAVAILABLE';

  if (detected && stage === 'STABILIZING' && !hardBlocker) {
    const pct = Math.round((diag?.acquisitionProgress ?? 0) * 100);
    ctx.fillStyle = COLORS.TEXT_INFO;
    ctx.textAlign = 'center';
    if (placementHint) {
      ctx.font = `bold 9px ${FONT_MONO}`;
      ctx.fillText(`ESTABILIZANDO SEÑAL · ${pct}%`, header.w / 2, header.y + 8);
      ctx.font = `9px ${FONT_MONO}`;
      ctx.fillText(placementHint, header.w / 2, header.y + 18);
    } else {
      ctx.font = `bold 10px ${FONT_MONO}`;
      ctx.fillText(`ESTABILIZANDO SEÑAL · ${pct}%`, header.w / 2, header.y + 12);
    }
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

  ctx.font = `bold 13px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_SECONDARY;
  ctx.textAlign = 'left';
  ctx.fillText('FRECUENCIA CARDÍACA', 16, metrics.y + 26);

  ctx.font = `bold 64px ${FONT_MONO}`;
  ctx.fillStyle = hrColor;
  const heartPulse = state.props.isMonitoring && dispBpm > 30 ? (Math.sin(state.now / (60000 / Math.max(60, dispBpm)) * 2 * Math.PI) + 1) / 2 : 0;
  ctx.save();
  if (heartPulse > 0) {
    ctx.shadowColor = hrColor;
    ctx.shadowBlur = 6 + heartPulse * 6;
  }
  ctx.fillText(dispBpm > 0 ? dispBpm.toString() : '--', 16, metrics.y + 72);
  ctx.restore();

  ctx.font = `15px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_SECONDARY;
  ctx.fillText('BPM', 16, metrics.y + 96);

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
    ctx.font = `bold 13px ${FONT_MONO}`;
    ctx.fillStyle = hrColor;
    ctx.textAlign = 'right';
    ctx.fillText(hrLabel, colW - 12, metrics.y + 96);
  }

  const s = state.bpmStats;
  if (s.n > 0) {
    ctx.font = `12px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DIM;
    ctx.textAlign = 'right';
    ctx.fillText(`min:${s.min} max:${s.max}`, colW - 12, metrics.y + 26);
  }

  const spo2Color = dispSpo2 <= 0 ? COLORS.TEXT_DIM
    : dispSpo2 >= 95 ? COLORS.SPO2
    : dispSpo2 >= 90 ? COLORS.TEXT_WARN
    : COLORS.TEXT_DANGER;

  ctx.font = `bold 13px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_SECONDARY;
  ctx.textAlign = 'left';
  ctx.fillText('SATURACIÓN O₂', colW + 16, metrics.y + 26);

  ctx.font = `bold 64px ${FONT_MONO}`;
  ctx.fillStyle = spo2Color;
  ctx.fillText(dispSpo2 > 0 ? dispSpo2.toString() : '--', colW + 16, metrics.y + 72);

  ctx.font = `15px ${FONT_MONO}`;
  ctx.fillStyle = COLORS.TEXT_SECONDARY;
  ctx.fillText('%', colW + 16 + (dispSpo2 > 0 ? 64 : 32), metrics.y + 72);

  let spLabel = '';
  if (dispSpo2 > 0) {
    if (dispSpo2 >= 95) spLabel = 'NORMOXIA';
    else if (dispSpo2 >= 90) spLabel = 'HIPOXEMIA LEVE';
    else if (dispSpo2 >= 85) spLabel = 'HIPOXEMIA MODERADA';
    else spLabel = 'HIPOXEMIA SEVERA';
  }
  ctx.font = `bold 13px ${FONT_MONO}`;
  ctx.fillStyle = spo2Color;
  ctx.textAlign = 'right';
  if (spLabel) ctx.fillText(spLabel, colW * 2 - 12, metrics.y + 96);

  if (pi > 0) {
    ctx.font = `12px ${FONT_MONO}`;
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

export function drawPressureGauge(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const p = state.props;
  if (!p.isFingerDetected) return;

  const { plot } = state.layout;
  const diag = p.diagnostics;
  const pressure = diag?.fingerPressure || 'LIGHT';

  const gaugeW = 120;
  const gaugeH = 8;
  const gaugeX = plot.x + plot.w - gaugeW - 16;
  const gaugeY = plot.y + 24;

  ctx.save();
  ctx.font = `bold 12px ${FONT_MONO}`;
  ctx.textAlign = 'left';
  
  let labelText = 'PRESIÓN: IDEAL';
  let labelColor = COLORS.SIGNAL;
  let targetPct = 0.5;

  if (pressure === 'LIGHT') {
    labelText = 'PRESIÓN: SUAVE';
    labelColor = COLORS.TEXT_WARN;
    targetPct = 0.2;
  } else if (pressure === 'HEAVY') {
    labelText = 'PRESIÓN: EXCESIVA';
    labelColor = COLORS.TEXT_DANGER;
    targetPct = 0.8;
  }

  ctx.fillStyle = labelColor;
  ctx.fillText(labelText, gaugeX, gaugeY - 8);

  const grad = ctx.createLinearGradient(gaugeX, 0, gaugeX + gaugeW, 0);
  grad.addColorStop(0, '#f59e0b');
  grad.addColorStop(0.35, '#f59e0b');
  grad.addColorStop(0.45, '#22c55e');
  grad.addColorStop(0.55, '#22c55e');
  grad.addColorStop(0.65, '#ef4444');
  grad.addColorStop(1, '#ef4444');

  ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
  ctx.fillRect(gaugeX - 4, gaugeY - 4, gaugeW + 8, gaugeH + 8);
  
  ctx.fillStyle = grad;
  ctx.fillRect(gaugeX, gaugeY, gaugeW, gaugeH);

  const cursorX = gaugeX + gaugeW * targetPct;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cursorX, gaugeY - 2);
  ctx.lineTo(cursorX - 5, gaugeY - 8);
  ctx.lineTo(cursorX + 5, gaugeY - 8);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

export function drawSignal(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const buffer = state.buffer;
  if (!buffer) return;
  const { plot } = state.layout;
  const p = state.props;

  if (p.preserveResults && !p.isFingerDetected) return;
  if (p.isPeak) state.sweepPulse = 1;

  if (p.isPeak) {
    const peakAge = state.now - state.lastPeakProcessedTime;
    if (peakAge > CARDIAC_WAVE_CONFIG.PEAK_DEBOUNCE_MS) {
      state.lastPeakProcessedTime = state.now;
      const currentCount = p.arrhythmiaCount || 0;
      const rrArr = p.rrIntervals;
      const lastRR = rrArr && rrArr.length > 0 ? rrArr[rrArr.length - 1] : 0;
      const isNewArr = currentCount > state.lastArrhythmiaCount;

      if (isNewArr) {
        state.lastArrhythmiaCount = currentCount;
        state.pendingTrendArr = true;
        const retroRR = lastRR > 0 ? lastRR : CARDIAC_WAVE_CONFIG.DEFAULT_RR_INTERVAL_MS;
        const retroDuration = Math.min(Math.max(retroRR, CARDIAC_WAVE_CONFIG.MIN_ARR_DURATION_MS), CARDIAC_WAVE_CONFIG.MAX_ARR_DURATION_MS);
        buffer.markArrhythmiaBack(retroDuration * CARDIAC_WAVE_CONFIG.ARR_RETRO_ALIGN_FACTOR);
        state.arrActiveUntil = state.now + retroDuration * CARDIAC_WAVE_CONFIG.ARR_ANTERO_ALIGN_FACTOR;
      }
      const storedRR = isPhysiologicalRR(lastRR) ? Math.round(lastRR) : 0;
      state.beatHistory.push({ isArrhythmia: isNewArr, time: state.now - VISUAL_DELAY_MS, rr: storedRR });
      if (state.beatHistory.length > BEAT_HISTORY_MAX) {
        state.beatHistory = state.beatHistory.slice(-BEAT_HISTORY_MAX);
      }
    }
  }

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
  const wavePadTop = CARDIAC_WAVE_CONFIG.WAVE_PAD_TOP;
  const wavePadBot = CARDIAC_WAVE_CONFIG.WAVE_PAD_BOTTOM;
  const waveH = Math.max(40, plot.h - wavePadTop - wavePadBot);
  const waveBaseY = plot.y + wavePadTop + waveH;

  const strength = state.traceRevealed
    ? (state.signalStrength < 0 ? 0 : state.signalStrength > 1 ? 1 : state.signalStrength)
    : 0.5; // Default amplitude during warmup so we can see finger contact immediately
  const midValue = (stats.max + stats.min) / 2;
  const coords: { x: number; y: number; isArr: boolean; val: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const age = state.now - pt.time - VISUAL_DELAY_MS;
    if (age > WINDOW_MS) continue;
    const x = plot.x + plot.w - (age * plot.w / WINDOW_MS);
    if (x < plot.x || x > plot.x + plot.w) continue;
    const honestValue = midValue + (pt.value - midValue) * strength;
    
    // Mapeo normalizado [0..1] para aplicar la transformación de subida/bajada no lineal
    const pct = Math.max(0, Math.min(1, (honestValue - stats.min) / safeRange));
    const transformedPct = Math.pow(pct, CARDIAC_WAVE_CONFIG.WAVE_SHARPNESS_EXPONENT);
    const y = plot.y + wavePadTop + (1 - transformedPct) * waveH;
    
    coords.push({ x, y, isArr: pt.isArrhythmia, val: pt.value });
  }

  if (coords.length < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // El halo de la punta se amortigua una vez por frame; ambos modos (2D/3D) lo leen.
  state.sweepPulse *= CARDIAC_WAVE_CONFIG.SWEEP_PULSE_DECAY;

    // ── MODO 3D: onda como cinta extruida sobre el piso en perspectiva. ──
  // Reusa las MISMAS coords honestas → forma, amplitud y tiempo idénticos al 2D.
  drawWaveRibbon3D(ctx, state, coords, { waveBaseY, waveH, midValue });

  // Contacto y estado mínimo (esquina inferior derecha)
  ctx.font = `bold 12px ${FONT_MONO}`;
  ctx.textAlign = 'right';
  const contactCol = p.contactState === 'STABLE_CONTACT' ? 'rgba(34, 197, 94, 0.9)' : p.contactState === 'NO_CONTACT' ? 'rgba(239, 68, 68, 0.6)' : 'rgba(245, 158, 11, 0.8)';
  ctx.fillStyle = contactCol;
  ctx.fillText(formatContactState(p.contactState), plot.x + plot.w - 12, plot.y + plot.h - 8);

  ctx.restore();
}

export function drawAcquisitionOverlay(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const p = state.props;
  const diag = p.diagnostics;
  if (!p.isFingerDetected || p.preserveResults) return;
  if (state.traceRevealed) return;

  const { plot } = state.layout;
  const progress = Math.max(0, Math.min(1, diag?.acquisitionProgress ?? 0));
  const barX = plot.x + 12;
  const barW = plot.w - 24;
  const barH = 4;
  const barY = plot.y + 4;

  ctx.save();
  ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
  ctx.fillRect(barX, barY, barW, barH);
  const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  grad.addColorStop(0, 'rgba(34, 197, 94, 0.9)');
  grad.addColorStop(1, 'rgba(103, 232, 249, 0.95)');
  ctx.fillStyle = grad;
  ctx.fillRect(barX, barY, Math.max(barH, barW * progress), barH);
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
    ctx.font = `bold 13px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_DANGER;
    ctx.fillText(`⚠ ${alarms.join(' · ')}`, footer.x + footer.w - 12, footer.y + 18);
  } else if (bpm != null && bpm > 0) {
    ctx.font = `13px ${FONT_MONO}`;
    ctx.fillStyle = COLORS.TEXT_PRIMARY;
    ctx.fillText('● SIN ALARMAS', footer.x + footer.w - 12, footer.y + 18);
  }
}
