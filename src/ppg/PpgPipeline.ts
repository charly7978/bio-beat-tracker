import { designBandpass, filtfilt, type FilterSections } from './butterworth';
import { findPeaksElgendi, ELGENDI_DEFAULTS, type ElgendiParams } from './elgendi';
import { estimateHeartRate, type HeartRateEstimate } from './heartRate';
import { effectiveSampleRate, resampleUniform } from './resampler';
import type { RoiSample } from './roiSampler';

/**
 * PIPELINE PPG — cámara → señal → latidos. Único punto donde se conecta el flujo.
 *
 * Orden fijo, cada paso con una razón:
 *
 *   muestras del ROI (irregulares)
 *     → remuestreo a rejilla uniforme      (todo lo demás asume fs constante)
 *     → Butterworth 0,5–8 Hz fase cero     (lo que Elgendi exige recibir)
 *     → Elgendi: picos sistólicos          (detector validado, tolera arritmia)
 *     → RR → frecuencia por mediana        (robusto a latidos perdidos/espurios)
 *     → decisión de publicación            (consistencia del RR + perfusión)
 *
 * ANÁLISIS POR VENTANA, no muestra a muestra. Es consecuencia directa del
 * filtrado de fase cero: `filtfilt` necesita el bloque completo. La ventaja es
 * que elimina el *ringing* del filtrado causal, que producía oscilaciones
 * indistinguibles de latidos tras cada movimiento del dedo.
 *
 * QUÉ DECIDE QUE HAY MEDICIÓN. No el color del píxel: el índice de perfusión
 * (AC/DC, magnitud física con rango fisiológico conocido: 0,5–2 % en dedo sano)
 * junto con la consistencia de los intervalos RR. Un detector de picos encuentra
 * picos en ruido filtrado, pero el ruido no sostiene un RR estable.
 */

export interface PipelineConfig {
  /** Duración de la ventana de análisis (s). ~8 s ≈ 8–14 latidos. */
  windowSeconds: number;
  /** Cada cuántas muestras nuevas se reanaliza (coste vs. latencia). */
  analyzeEverySamples: number;
  /** Banda del acondicionamiento, la que exige Elgendi. */
  lowCutHz: number;
  highCutHz: number;
  /** Índice de perfusión mínimo (AC/DC). Dedo sano: 0,005–0,02 (0,5–2 %). */
  minPerfusionIndex: number;
  /** Coeficiente de variación del RR máximo admitido. */
  maxRrCv: number;
  /** Latidos mínimos para publicar. */
  minBeats: number;
  /** Margen de borde de ventana cuyos picos se descartan (s). */
  edgeMarginSeconds: number;
  /**
   * Frecuencia a la que se REMUESTREA para analizar, por encima de la de cámara.
   *
   * Elgendi se diseñó para señales de 125–1000 Hz. A los ~30 fps de una cámara,
   * su ventana de pico de 111 ms son 3 muestras: la media móvil casi no filtra y
   * el pico solo puede localizarse con precisión de un cuadro entero (±33 ms),
   * lo que introduce en el RR un jitter del orden del 4 % que basta para que un
   * ritmo perfectamente regular parezca inconsistente. Interpolando a 120 Hz esa
   * misma ventana pasa a 13 muestras y el pico se localiza con resolución
   * sub-cuadro. No inventa información: solo deja de destruir la que hay.
   */
  analysisFsHz: number;
  elgendi: ElgendiParams;
}

export const PIPELINE_DEFAULTS: PipelineConfig = {
  windowSeconds: 8,
  analyzeEverySamples: 5,
  lowCutHz: 0.5,
  highCutHz: 8,
  // Por debajo del rango clínico (la cámara atenúa frente a un oxímetro
  // transmisivo) pero dos órdenes de magnitud por encima del ruido de sensor.
  minPerfusionIndex: 0.002,
  // Un ritmo cardíaco real, incluso con arritmia moderada, mantiene el RR
  // mucho más consistente que una serie de picos hallados sobre ruido.
  maxRrCv: 0.22,
  minBeats: 5,
  edgeMarginSeconds: 1.0,
  analysisFsHz: 120,
  elgendi: ELGENDI_DEFAULTS,
};

export interface PipelineResult {
  /** Hay medición sostenida por observación física. */
  measuring: boolean;
  /** 0 si no hay medición. Nunca se rellena con un valor previo. */
  bpm: number;
  /** Índice de perfusión observado (AC/DC). */
  perfusionIndex: number;
  /** Señal filtrada de la ventana (para dibujar la onda REAL). */
  waveform: number[];
  /** Índices de pico dentro de `waveform`. */
  peaks: number[];
  /** Intervalos RR (ms). */
  rrMs: number[];
  /** Frecuencia de muestreo efectiva usada. */
  fsHz: number;
  /** Motivo por el que no se publica, cuando `measuring` es falso. */
  reason: string;
  heartRate: HeartRateEstimate;
}

const EMPTY: PipelineResult = {
  measuring: false,
  bpm: 0,
  perfusionIndex: 0,
  waveform: [],
  peaks: [],
  rrMs: [],
  fsHz: 0,
  reason: 'WAITING_SAMPLES',
  heartRate: { bpm: 0, rrMs: [], rrCv: Infinity, beatCount: 0 },
};

export class PpgPipeline {
  private readonly config: PipelineConfig;
  private samples: RoiSample[] = [];
  private sinceAnalysis = 0;
  private lastResult: PipelineResult = EMPTY;
  private cachedFilter: { fsHz: number; filter: FilterSections } | null = null;

  constructor(config: Partial<PipelineConfig> = {}) {
    this.config = { ...PIPELINE_DEFAULTS, ...config };
  }

  reset(): void {
    this.samples = [];
    this.sinceAnalysis = 0;
    this.lastResult = EMPTY;
    this.cachedFilter = null;
  }

  /** Alimenta una muestra del ROI. Devuelve el resultado vigente. */
  push(sample: RoiSample): PipelineResult {
    this.samples.push(sample);

    // Recorte por TIEMPO, no por número de muestras: si la cámara pierde
    // cuadros, un recorte por conteo dejaría una ventana temporalmente más
    // larga de lo previsto y sesgaría las ventanas de Elgendi.
    const cutoff = sample.timestampMs - this.config.windowSeconds * 1000;
    while (this.samples.length > 0 && this.samples[0]!.timestampMs < cutoff) {
      this.samples.shift();
    }

    this.sinceAnalysis++;
    if (this.sinceAnalysis >= this.config.analyzeEverySamples) {
      this.sinceAnalysis = 0;
      this.lastResult = this.analyze();
    }
    return this.lastResult;
  }

  private analyze(): PipelineResult {
    const n = this.samples.length;
    if (n < 32) return { ...EMPTY, reason: 'WAITING_SAMPLES' };

    const timestamps = this.samples.map((s) => s.timestampMs);
    const fsHz = effectiveSampleRate(timestamps);
    if (fsHz < 10) return { ...EMPTY, reason: 'FRAME_RATE_TOO_LOW', fsHz };

    // ROJO como fuente: es el canal con señal utilizable en contacto con flash.
    const red = this.samples.map((s) => s.red);

    // PERFUSIÓN sobre la señal CRUDA (AC/DC): magnitud física real. Debe
    // calcularse antes del filtrado, porque el pasa-altos elimina justamente el
    // DC que forma el denominador.
    const perfusionIndex = computePerfusionIndex(red);

    // Se analiza a `analysisFsHz`, no a la tasa de la cámara (ver arriba).
    const analysisFs = Math.max(fsHz, this.config.analysisFsHz);
    const uniform = resampleUniform({ values: red, timestampsMs: timestamps }, analysisFs);
    if (!uniform) return { ...EMPTY, reason: 'RESAMPLE_FAILED', fsHz };

    const filter = this.filterFor(analysisFs);
    // Relleno = un periodo completo de la frecuencia de corte inferior: es el
    // tiempo que el pasa-altos necesita para asentarse.
    const padLen = Math.round(analysisFs / this.config.lowCutHz);
    const waveform = filtfilt(uniform.values, filter, padLen);
    const allPeaks = findPeaksElgendi(waveform, analysisFs, this.config.elgendi);

    // Se descartan los picos de los BORDES de la ventana. El filtrado de fase
    // cero deja un transitorio en los extremos —por breve que sea la extensión
    // por reflexión— y un flanco de transitorio es indistinguible de una subida
    // sistólica. Un pico espurio de borde parte un intervalo RR en dos (uno
    // larguísimo y uno cortísimo) y hace fallar la prueba de consistencia del
    // ritmo aunque el latido real sea perfecto. Se pierde a lo sumo un latido
    // por extremo, y la ventana está dimensionada con margen para eso.
    const margin = Math.round(this.config.edgeMarginSeconds * analysisFs);
    const peaks = allPeaks.filter((p) => p >= margin && p < waveform.length - margin);
    const heartRate = estimateHeartRate(peaks, analysisFs);

    let reason = 'MEASURING';
    let measuring = true;
    if (perfusionIndex < this.config.minPerfusionIndex) {
      measuring = false;
      reason = 'NO_PERFUSION';
    } else if (heartRate.beatCount < this.config.minBeats) {
      measuring = false;
      reason = 'WAITING_BEATS';
    } else if (heartRate.bpm <= 0) {
      measuring = false;
      reason = 'NO_RHYTHM';
    } else if (heartRate.rrCv > this.config.maxRrCv) {
      measuring = false;
      reason = 'RHYTHM_NOT_CONSISTENT';
    }

    return {
      measuring,
      bpm: measuring ? heartRate.bpm : 0,
      perfusionIndex,
      waveform,
      peaks,
      rrMs: heartRate.rrMs,
      fsHz,
      reason,
      heartRate,
    };
  }

  /** El diseño del filtro depende solo de fs: se recalcula al cambiar. */
  private filterFor(fsHz: number): FilterSections {
    if (this.cachedFilter && Math.abs(this.cachedFilter.fsHz - fsHz) < 0.5) {
      return this.cachedFilter.filter;
    }
    const filter = designBandpass(this.config.lowCutHz, this.config.highCutHz, fsHz);
    this.cachedFilter = { fsHz, filter };
    return filter;
  }
}

/**
 * Índice de perfusión = AC/DC sobre la señal cruda.
 *
 * AC por rango robusto (percentil 95 − percentil 5) en lugar de máximo−mínimo:
 * un único cuadro atípico —saturación momentánea, cuadro perdido— dispararía el
 * rango absoluto y fabricaría perfusión donde no la hay.
 */
export function computePerfusionIndex(raw: number[]): number {
  const n = raw.length;
  if (n < 8) return 0;
  let dc = 0;
  for (let i = 0; i < n; i++) dc += raw[i]!;
  dc /= n;
  if (dc <= 1) return 0;

  const sorted = [...raw].sort((a, b) => a - b);
  const p05 = sorted[Math.floor(n * 0.05)]!;
  const p95 = sorted[Math.floor(n * 0.95)]!;
  const ac = Math.max(0, p95 - p05);
  return ac / dc;
}
