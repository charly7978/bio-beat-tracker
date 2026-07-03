/**
 * STREAMING BEAT DETECTOR — Elgendi CAUSAL e INCREMENTAL, de una sola pasada.
 *
 * Algoritmo: Elgendi et al. 2013, PLoS ONE "Systolic Peak Detection in
 * Acceleration Photoplethysmograms..." (two moving averages), fiel a
 * NeuroKit2 `_ppg_findpeaks_elgendi`:
 *   1) Señal de energía = max(x,0)² (recorta negativos, eleva al cuadrado).
 *   2) Dos medias móviles CAUSALES (boxcar): MA_peak (111 ms) y MA_beat (667 ms).
 *   3) Umbral = MA_beat + β·mean(energía), β=0.02. NeuroKit usa la media GLOBAL
 *      de la grabación (batch); aquí se aproxima con una EMA lenta (~5 s) — el
 *      análogo causal correcto de "media de toda la señal analizada hasta ahora".
 *   4) Bloque de interés = tramo donde MA_peak > umbral. Se descarta si su ancho
 *      es menor que peakwindow (111 ms).
 *   5) Pico = máximo de la señal RAW dentro del bloque; mindelay 300 ms entre
 *      picos consecutivos.
 *
 * POR QUÉ ESTA VERSIÓN Y NO LA ANTERIOR (batch re-evaluado + "confirmación"):
 * recorrer un detector BATCH sobre una ventana deslizante en cada frame recalcula
 * `mean(energía)`/`MA_beat` con estadísticas GLOBALES que cambian de pasada en
 * pasada — un pico presente en una corrida puede DESAPARECER en la siguiente
 * (el umbral se movió) antes de llegar a "confirmarse", perdiéndose para
 * siempre. Es la causa real de los silencios intermitentes observados. La
 * version CAUSAL evita esto por construcción: cada muestra actualiza el estado
 * UNA vez, cada bloque se decide UNA vez al cerrarse, nunca se re-evalúa con
 * estadísticas que cambiaron retroactivamente. Sin ventana "batch", sin
 * recomputar el pasado: el resultado es determinista y estable.
 *
 * EMISIÓN: al cerrar un bloque (MA_peak cae bajo el umbral) se emite de
 * inmediato — no hace falta un retardo de "confirmación" porque MA_beat y
 * mean(energía) son CAUSALES (sólo miran atrás): el cierre del bloque ya es,
 * por construcción, una decisión completa y definitiva. Única fuente de
 * latencia: el propio ancho del bloque (~una fracción de latido).
 *
 * DOBLE GIBA: si dos latidos están tan pegados que el valle entre ellos no baja
 * del umbral (bloque único y ancho), se detecta el valle INTERNO (pendiente que
 * baja y vuelve a subir dentro del bloque) y se separan en dos candidatos — evita
 * perder el segundo latido en arritmias/taquicardia o señal débil.
 */
import { clamp } from '../../../utils/math';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';

export interface StreamingBeatSampleResult {
  /** True SÓLO en el frame en que se emite (cierra bloque) un latido genuino. */
  isPeak: boolean;
  /** Tiempo (ms, mismo reloj que los timestamps de entrada) del pico sistólico. */
  peakTimeMs: number;
  /** Amplitud (señal filtrada, raw) del pico. 0 si no hubo emisión. */
  peakValue: number;
  /** Score de confianza del pico [0..1]. */
  score: number;
  /** Motivo auditable de la decisión de este frame. */
  reason: string;
  /** Umbral Elgendi instantáneo (diagnóstico). */
  threshold: number;
  /** MA_peak instantánea (diagnóstico; sirve de proxy de "energía de pulso"). */
  ampEnv: number;
  /** True mientras hay un bloque de interés abierto (diagnóstico). */
  inBlock: boolean;
}

export interface StreamingBeatDetectorConfig {
  /** Ventana corta W1 (ms) — Elgendi peakwindow canónico. */
  peakWindowMs: number;
  /** Ventana larga W2 (ms) — Elgendi beatwindow canónico. */
  beatWindowMs: number;
  /** Offset β del umbral (Elgendi/NeuroKit2 = 0.02). */
  beatOffset: number;
  /** Constante de tiempo (ms) de la EMA que aproxima mean(energía) global. */
  energyMeanTauMs: number;
  /** mindelay Elgendi (ms) — refractario canónico entre picos. */
  minDelayMs: number;
  /** Fracción de la mediana RR usada como refractario adaptativo (lado bajo). */
  refractoryRrFrac: number;
  /**
   * Duración MÁXIMA de un bloque (ms) antes de forzar su cierre y reabrir uno
   * nuevo. Salvaguarda contra bloques que nunca cierran (deriva/baseline
   * atascada) y contra la fusión de dos latidos en un solo bloque.
   */
  maxBlockMs: number;
  /**
   * Hysteresis relativa (fracción del máximo del bloque) para detectar una
   * "doble giba": una caída y posterior subida dentro del MISMO bloque indica
   * dos picos sistólicos pegados (valle que no cruza el umbral).
   */
  humpHysteresisFrac: number;
}

export const STREAMING_BEAT_DEFAULTS: StreamingBeatDetectorConfig = {
  peakWindowMs: 80,   // Reduced from 111ms for better high-HR support
  beatWindowMs: 450,  // Reduced from 667ms (was > 1 RR at 150 BPM)
  beatOffset: 0.005,  // Much lower (threshold ≈ MA_beat, almost no mean offset)
  energyMeanTauMs: 5000,
  minDelayMs: PEAK_DETECTION_DEFAULTS.peakEmitRefractoryMinMs,
  refractoryRrFrac: 0.5,
  maxBlockMs: 550,    // ~1.4x of max expected RR (taquicardia ~400ms), force closure before beat merge
  humpHysteresisFrac: 0.25, // Slightly tighter to trigger double-gib more easily
};

interface RunningBoxcar {
  buf: Float64Array;
  head: number;
  count: number;
  sum: number;
  size: number;
}

function createBoxcar(size: number): RunningBoxcar {
  return { buf: new Float64Array(Math.max(1, size)), head: 0, count: 0, sum: 0, size: Math.max(1, size) };
}

function pushBoxcar(w: RunningBoxcar, v: number): number {
  if (w.count < w.size) {
    w.buf[w.head] = v;
    w.sum += v;
    w.count++;
  } else {
    w.sum += v - w.buf[w.head];
    w.buf[w.head] = v;
  }
  w.head = (w.head + 1) % w.size;
  return w.sum / w.count;
}

export class StreamingBeatDetector {
  private cfg: StreamingBeatDetectorConfig;

  private fs = 0;
  private maPeak!: RunningBoxcar;
  private maBeat!: RunningBoxcar;
  private energyMeanEma = 0;
  private energyMeanInit = false;
  private lastSampleTime = 0;

  // Estado del bloque de interés en curso.
  private inBlock = false;
  private blockStartTime = 0;
  private blockMaxVal = -Infinity;
  private blockMaxTime = 0;
  // Estado de "doble giba" (hysteresis dentro del bloque).
  private sinceMaxDroppedBelow = false;

  private lastEmittedPeakTime = 0;
  private recentRr: number[] = [];
  private recentAmp: number[] = [];
  private readonly MAX_HISTORY = 12;

  private lastThreshold = 0;
  private lastMaPeak = 0;

  /** RR esperado (ms) del tracker de ritmo — ancla estable del refractario. */
  private expectedRrMs = 0;

  constructor(cfg: Partial<StreamingBeatDetectorConfig> = {}) {
    this.cfg = { ...STREAMING_BEAT_DEFAULTS, ...cfg };
  }

  /** Compat: contexto de calidad (no se usa para calibrar el umbral causal; el
   * umbral Elgendi es escala-relativa por diseño — ver β·mean(energía)). */
  setQualityContext(_sqi: number, _perfusionIndex: number): void {
    /* no-op: el umbral causal ya es auto-calibrado por señal */
  }

  /** Ajusta la beatwindow (ms) en vivo; reconstruye MA_beat si cambia material. */
  setBeatWindowMs(beatWindowMs: number): void {
    if (!Number.isFinite(beatWindowMs) || beatWindowMs <= 0) return;
    if (Math.abs(beatWindowMs - this.cfg.beatWindowMs) < 30) return;
    this.cfg.beatWindowMs = beatWindowMs;
    if (this.fs > 0) {
      const w2 = Math.max(this.maPeak.size + 2, Math.round((beatWindowMs / 1000) * this.fs));
      this.maBeat = createBoxcar(w2);
    }
  }

  /** Ancla el refractario a un RR de ritmo estable (tracker); 0 = mediana local. */
  setExpectedRrMs(rrMs: number): void {
    this.expectedRrMs =
      Number.isFinite(rrMs) && rrMs >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS ? rrMs : 0;
  }

  private ensureWindows(fs: number): void {
    if (this.fs > 0 && Math.abs(fs - this.fs) / this.fs < 0.15) return;
    this.fs = fs;
    const w1 = Math.max(3, Math.round((this.cfg.peakWindowMs / 1000) * fs));
    const w2 = Math.max(w1 + 2, Math.round((this.cfg.beatWindowMs / 1000) * fs));
    this.maPeak = createBoxcar(w1);
    this.maBeat = createBoxcar(w2);
  }

  private median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }

  private effectiveMinDelayMs(): number {
    const anchorRr = this.expectedRrMs > 0 ? this.expectedRrMs : this.median(this.recentRr);
    // Adaptive refractary: 50% of RR, but not less than the absolute minimum
    // and not more than a reasonable maximum even if RR is erratic.
    const adaptive = anchorRr > 0 ? Math.max(100, anchorRr * this.cfg.refractoryRrFrac) : 0;
    return Math.max(this.cfg.minDelayMs, Math.min(adaptive, 400));
  }

  /**
   * Procesa UNA muestra de la señal filtrada en vivo (causal, O(1)).
   * @param x       muestra filtrada (bandpass causal, zero-centrada)
   * @param timeMs  timestamp de la muestra (mismo reloj en toda la sesión)
   * @param fs      frecuencia de muestreo estimada (Hz)
   */
  process(x: number, timeMs: number, fs: number): StreamingBeatSampleResult {
    this.ensureWindows(fs);

    const pos = x > 0 ? x : 0;
    const energy = pos * pos;
    const maPeak = pushBoxcar(this.maPeak, energy);
    const maBeat = pushBoxcar(this.maBeat, energy);

    // EMA causal que aproxima mean(energía) global (análogo streaming del batch
    // de NeuroKit). Decaimiento por tiempo real → independiente de fps/jitter.
    const dtMs = this.lastSampleTime > 0 && timeMs > this.lastSampleTime
      ? timeMs - this.lastSampleTime
      : 1000 / Math.max(1, fs);
    this.lastSampleTime = timeMs;
    if (!this.energyMeanInit) {
      this.energyMeanEma = energy;
      this.energyMeanInit = true;
    } else {
      const alpha = 1 - Math.exp(-dtMs / this.cfg.energyMeanTauMs);
      this.energyMeanEma += alpha * (energy - this.energyMeanEma);
    }

    const threshold = maBeat + this.cfg.beatOffset * this.energyMeanEma;
    this.lastThreshold = threshold;
    this.lastMaPeak = maPeak;

    let isPeak = false;
    let peakTimeMs = 0;
    let peakValue = 0;
    let score = 0;
    let reason = this.inBlock ? 'IN_BLOCK' : 'BELOW_THR';

    const above = maPeak > threshold;

    if (above) {
      if (!this.inBlock) {
        this.inBlock = true;
        this.blockStartTime = timeMs;
        this.blockMaxVal = -Infinity;
        this.blockMaxTime = 0;
        this.sinceMaxDroppedBelow = false;
      }

      // Rastrea el máximo REAL de la señal (no de la energía) → ubicación exacta
      // del pico sistólico.
      if (x > this.blockMaxVal) {
        this.blockMaxVal = x;
        this.blockMaxTime = timeMs;
        this.sinceMaxDroppedBelow = false;
      } else if (this.blockMaxVal > 0) {
        // ¿Cayó lo suficiente desde el máximo actual? → posible valle interno.
        const dropFrac = (this.blockMaxVal - x) / this.blockMaxVal;
        if (dropFrac >= this.cfg.humpHysteresisFrac) {
          this.sinceMaxDroppedBelow = true;
        }
        // ¿Volvió a subir tras haber caído? → DOBLE GIBA: cierra la primera
        // como candidato y reabre el rastreo de la segunda dentro del mismo bloque.
        if (this.sinceMaxDroppedBelow && x > this.blockMaxVal * (1 - this.cfg.humpHysteresisFrac * 0.5)) {
          const decision = this.evaluateCandidate(
            this.blockMaxTime,
            this.blockMaxVal,
            this.blockMaxTime - this.blockStartTime,
          );
          if (decision.emit) {
            this.commitEmission(this.blockMaxTime, this.blockMaxVal);
            isPeak = true;
            peakTimeMs = this.blockMaxTime;
            peakValue = this.blockMaxVal;
            score = decision.score;
            reason = 'PEAK_HUMP_SPLIT';
          }
          // Reabre el rastreo de la segunda giba desde este punto.
          this.blockStartTime = timeMs;
          this.blockMaxVal = x;
          this.blockMaxTime = timeMs;
          this.sinceMaxDroppedBelow = false;
          if (isPeak) {
            return {
              isPeak,
              peakTimeMs,
              peakValue,
              score,
              reason,
              threshold,
              ampEnv: maPeak,
              inBlock: this.inBlock,
            };
          }
        }
      }

      // Salvaguarda: bloque anómalamente largo (deriva atascada / dos latidos
      // fusionados sin hysteresis clara) → fuerza cierre y reapertura.
      if (timeMs - this.blockStartTime > this.cfg.maxBlockMs) {
        const decision = this.evaluateCandidate(
          this.blockMaxTime,
          this.blockMaxVal,
          this.blockMaxTime - this.blockStartTime,
        );
        if (decision.emit) {
          this.commitEmission(this.blockMaxTime, this.blockMaxVal);
          isPeak = true;
          peakTimeMs = this.blockMaxTime;
          peakValue = this.blockMaxVal;
          score = decision.score;
          reason = 'PEAK_MAXBLOCK_SPLIT';
        }
        this.blockStartTime = timeMs;
        this.blockMaxVal = x;
        this.blockMaxTime = timeMs;
        this.sinceMaxDroppedBelow = false;
      }
    } else if (this.inBlock) {
      // Cierre normal del bloque → candidato = máximo rastreado.
      this.inBlock = false;
      const decision = this.evaluateCandidate(
        this.blockMaxTime,
        this.blockMaxVal,
        this.blockMaxTime - this.blockStartTime,
      );
      reason = decision.reason;
      if (decision.emit) {
        isPeak = true;
        peakTimeMs = this.blockMaxTime;
        peakValue = this.blockMaxVal;
        score = decision.score;
        this.commitEmission(this.blockMaxTime, this.blockMaxVal);
      }
    }

    return {
      isPeak,
      peakTimeMs,
      peakValue,
      score,
      reason,
      threshold,
      ampEnv: maPeak,
      inBlock: this.inBlock,
    };
  }

  private evaluateCandidate(
    time: number,
    val: number,
    widthMs: number,
  ): { emit: boolean; score: number; reason: string } {
    if (val <= 0 || !Number.isFinite(val) || time <= 0) {
      return { emit: false, score: 0, reason: 'NON_POSITIVE_PEAK' };
    }
    // Ancho mínimo del bloque = fracción de peakwindow (rechaza flickers de ruido).
    // Más lenient en high-HR: permite bloques más estrechos.
    const minWidth = Math.max(30, this.cfg.peakWindowMs * 0.4);
    if (widthMs < minWidth) {
      return { emit: false, score: 0, reason: 'BLOCK_TOO_NARROW' };
    }

    if (this.lastEmittedPeakTime > 0) {
      const gap = time - this.lastEmittedPeakTime;
      if (gap < this.effectiveMinDelayMs()) {
        return { emit: false, score: 0, reason: 'REFRACTORY' };
      }
      if (gap < VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS) {
        return { emit: false, score: 0, reason: 'RR_TOO_SHORT' };
      }
    }

    // Rechazo de dícrota/ruido residual: amplitud mínima relativa a la mediana
    // reciente (estable, no una banda per-frame). Conservador: floor bajo para
    // no perder latidos débiles genuinos.
    const medAmp = this.median(this.recentAmp);
    if (medAmp > 0 && val < medAmp * 0.28) {
      return { emit: false, score: 0, reason: 'LOW_REL_AMPLITUDE' };
    }

    let ampScore = 1;
    if (medAmp > 0) {
      const rel = Math.abs(val - medAmp) / medAmp;
      ampScore = clamp(1 - rel * 0.5, 0.3, 1);
    }
    const historyScore = clamp(this.recentRr.length / 4, 0.25, 1);
    const score = clamp(ampScore * 0.55 + historyScore * 0.45, 0, 1);

    return { emit: true, score, reason: 'PEAK_DETECTED' };
  }

  private commitEmission(time: number, val: number): void {
    if (this.lastEmittedPeakTime > 0) {
      const rr = time - this.lastEmittedPeakTime;
      if (
        rr >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS &&
        rr <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS
      ) {
        this.recentRr.push(rr);
        if (this.recentRr.length > this.MAX_HISTORY) this.recentRr.shift();
      }
    }
    this.recentAmp.push(val);
    if (this.recentAmp.length > this.MAX_HISTORY) this.recentAmp.shift();
    this.lastEmittedPeakTime = time;
  }

  /** Mediana RR (ms) del historial reciente, 0 si no hay. */
  getMedianRrMs(): number {
    return this.median(this.recentRr);
  }

  getLastEmitTime(): number {
    return this.lastEmittedPeakTime;
  }

  /** Reabre la detección sin vaciar las medias móviles (dedo quieto). */
  softReset(): void {
    this.inBlock = false;
    this.blockMaxVal = -Infinity;
    this.sinceMaxDroppedBelow = false;
  }

  /** Reset total del estado (quitar dedo / recolocar). */
  reset(): void {
    this.fs = 0;
    this.energyMeanEma = 0;
    this.energyMeanInit = false;
    this.lastSampleTime = 0;
    this.inBlock = false;
    this.blockStartTime = 0;
    this.blockMaxVal = -Infinity;
    this.blockMaxTime = 0;
    this.sinceMaxDroppedBelow = false;
    this.lastEmittedPeakTime = 0;
    this.recentRr = [];
    this.recentAmp = [];
    this.lastThreshold = 0;
    this.lastMaPeak = 0;
    this.expectedRrMs = 0;
  }
}
