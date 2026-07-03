/**
 * STREAMING BEAT DETECTOR — Elgendi "two moving averages" en TIEMPO REAL.
 *
 * Reemplaza la arquitectura frágil de "re-detectar toda la ventana en cada frame
 * y elegir el pico más reciente" (batch-por-frame + cherry-pick), causa raíz de:
 *   - latidos pegados (el mismo pico cruzaba el refractario dos veces),
 *   - silencios (un latido real nunca llegaba a ser "el más reciente dentro del
 *     borde vivo" y se perdía para siempre),
 *   - jitter de timing (el filtro offline re-aplicado cada frame corría el pico).
 *
 * Diseño (Elgendi et al. 2013, PLoS ONE "Systolic Peak Detection..."; validado):
 *   - Señal de energía = max(x,0)² sobre la señal YA filtrada en vivo (bandpass
 *     causal único aguas arriba — NO se re-filtra aquí → sin doble filtrado).
 *   - Dos medias móviles CORRIENTES: MA_peak (~111 ms) y MA_beat (~beat-window).
 *   - Umbral THR[n] = MA_beat[n] + β·media(energía). β y ventanas son escala-
 *     invariantes → robusto a la modulación de amplitud (no hay gate que "cierre"
 *     por colapso de rango; RC-4 eliminado en la detección).
 *   - "Bloque de interés" = tramo donde MA_peak > THR. Se rastrea el MÁXIMO de la
 *     señal filtrada dentro del bloque y se EMITE UNA sola vez al cerrarse el
 *     bloque, con refractario fisiológico adaptativo. Emisión monótona → imposible
 *     doble-contar o re-emitir (RC-1 eliminado).
 *   - Rechazo de dícrota por amplitud RELATIVA a la mediana de amplitudes recientes
 *     (no una banda per-frame inestable) + refractario. Tolerante a arritmias:
 *     el refractario sólo actúa por el lado bajo del RR (van Gent 2019, HeartPy).
 *
 * Latencia: el pico se confirma al cerrarse el bloque (~half W1 + descenso, ~120–
 * 200 ms). Es CONSTANTE → se cancela en el RR (diferencia de tiempos) y sólo añade
 * un retardo fijo pequeño al háptico/beep.
 */
import { clamp } from '../../../utils/math';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { PEAK_DETECTION_DEFAULTS } from '../../../config/signalProcessing';

export interface StreamingBeatSampleResult {
  /** True SÓLO en el frame en que se confirma un latido genuino. */
  isPeak: boolean;
  /** Tiempo (ms, mismo reloj que los timestamps de entrada) del pico sistólico. */
  peakTimeMs: number;
  /** Amplitud (señal filtrada) del pico. 0 si no hubo emisión. */
  peakValue: number;
  /** Score de confianza del pico [0..1] (amplitud relativa × consistencia). */
  score: number;
  /** Motivo auditable de la decisión de este frame. */
  reason: string;
  /** Umbral instantáneo (diagnóstico). */
  threshold: number;
  /** MA_peak instantáneo (diagnóstico). */
  maPeak: number;
  /** True mientras la muestra está dentro de un bloque de interés. */
  inBlock: boolean;
}

interface RunningWindow {
  buf: Float64Array;
  head: number;
  count: number;
  sum: number;
  size: number;
}

function createWindow(size: number): RunningWindow {
  return { buf: new Float64Array(size), head: 0, count: 0, sum: 0, size };
}

/** Empuja un valor y devuelve la media corriente de la ventana. */
function pushWindow(w: RunningWindow, v: number): number {
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

export interface StreamingBeatDetectorConfig {
  /** Ventana corta W1 tipo Elgendi (ms). */
  peakWindowMs: number;
  /** Ventana larga W2 (ms) — referencia del umbral. Adaptativa aguas arriba. */
  beatWindowMs: number;
  /** Offset β del umbral (Elgendi/NeuroKit2 ≈ 0.02). */
  beatOffset: number;
  /** Ventana (ms) para la media de energía usada en el offset. */
  energyMeanWindowMs: number;
  /** Refractario mínimo absoluto (ms) — anti doble conteo / dícrota. */
  refractoryMinMs: number;
  /** Fracción de la mediana RR usada como refractario adaptativo. */
  refractoryRrFrac: number;
  /** Ancho mínimo del bloque en múltiplos de W1 (canónico: 1×). */
  minBlockFracOfW1: number;
  /** Rechazo de dícrota: el pico debe superar esta fracción de la amplitud mediana. */
  amplitudeRejectFrac: number;
}

export const STREAMING_BEAT_DEFAULTS: StreamingBeatDetectorConfig = {
  peakWindowMs: PEAK_DETECTION_DEFAULTS.peakWindowMs,
  beatWindowMs: PEAK_DETECTION_DEFAULTS.beatWindowMs,
  beatOffset: PEAK_DETECTION_DEFAULTS.beatOffset,
  energyMeanWindowMs: 2000,
  refractoryMinMs: PEAK_DETECTION_DEFAULTS.peakEmitRefractoryMinMs,
  refractoryRrFrac: 0.5,
  minBlockFracOfW1: 1,
  amplitudeRejectFrac: PEAK_DETECTION_DEFAULTS.peakAmplitudeRejectFraction,
};

export class StreamingBeatDetector {
  private cfg: StreamingBeatDetectorConfig;
  private fs = 0;
  private maPeak!: RunningWindow;
  private maBeat!: RunningWindow;
  private energyMean!: RunningWindow;

  // Estado del bloque de interés en curso.
  private inBlock = false;
  private blockLen = 0;
  private blockMaxVal = -Infinity;
  private blockMaxTime = 0;

  // Historial para refractario adaptativo y rechazo de amplitud.
  private lastEmitTime = 0;
  private recentRr: number[] = [];
  private recentAmp: number[] = [];
  private readonly MAX_HISTORY = 12;

  constructor(cfg: Partial<StreamingBeatDetectorConfig> = {}) {
    this.cfg = { ...STREAMING_BEAT_DEFAULTS, ...cfg };
  }

  /** (Re)dimensiona las ventanas corrientes cuando fs cambia materialmente. */
  private ensureWindows(fs: number): void {
    if (this.fs > 0 && Math.abs(fs - this.fs) / this.fs < 0.15) return;
    this.fs = fs;
    const w1 = Math.max(3, Math.round((this.cfg.peakWindowMs / 1000) * fs));
    const w2 = Math.max(w1 + 2, Math.round((this.cfg.beatWindowMs / 1000) * fs));
    const wE = Math.max(w2, Math.round((this.cfg.energyMeanWindowMs / 1000) * fs));
    this.maPeak = createWindow(w1);
    this.maBeat = createWindow(w2);
    this.energyMean = createWindow(wE);
  }

  /** Ajusta la beat-window (ms) en vivo según el ritmo detectado aguas arriba. */
  setBeatWindowMs(beatWindowMs: number): void {
    if (!Number.isFinite(beatWindowMs) || beatWindowMs <= 0) return;
    if (Math.abs(beatWindowMs - this.cfg.beatWindowMs) < 30) return;
    this.cfg.beatWindowMs = beatWindowMs;
    if (this.fs > 0) {
      const w1 = this.maPeak.size;
      const w2 = Math.max(w1 + 2, Math.round((beatWindowMs / 1000) * this.fs));
      // Re-crear sólo MA_beat (preserva MA_peak/energyMean y su estado).
      this.maBeat = createWindow(w2);
    }
  }

  private median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }

  private adaptiveRefractoryMs(): number {
    const medRr = this.median(this.recentRr);
    const adaptive = medRr > 0 ? medRr * this.cfg.refractoryRrFrac : 0;
    return Math.max(this.cfg.refractoryMinMs, adaptive);
  }

  /**
   * Procesa UNA muestra de la señal filtrada en vivo.
   * @param x        muestra filtrada (bandpass causal, zero-centrada)
   * @param timeMs   timestamp de la muestra (mismo reloj en toda la sesión)
   * @param fs       frecuencia de muestreo estimada (Hz)
   */
  process(x: number, timeMs: number, fs: number): StreamingBeatSampleResult {
    this.ensureWindows(fs);

    const pos = x > 0 ? x : 0;
    const energy = pos * pos;
    const maPeak = pushWindow(this.maPeak, energy);
    const maBeat = pushWindow(this.maBeat, energy);
    const meanEnergy = pushWindow(this.energyMean, energy);

    // THR canónico Elgendi: MA_beat + β·media(energía).
    const threshold = maBeat + this.cfg.beatOffset * meanEnergy;

    let isPeak = false;
    let peakTimeMs = 0;
    let peakValue = 0;
    let score = 0;
    let reason = this.inBlock ? 'IN_BLOCK' : 'BELOW_THR';

    const above = maPeak > threshold;

    if (above) {
      if (!this.inBlock) {
        this.inBlock = true;
        this.blockLen = 0;
        this.blockMaxVal = -Infinity;
        this.blockMaxTime = 0;
      }
      this.blockLen++;
      // Rastrea el máximo de la señal filtrada (no de la energía) → ubicación
      // exacta del pico sistólico, no del centro del burst de energía.
      if (x > this.blockMaxVal) {
        this.blockMaxVal = x;
        this.blockMaxTime = timeMs;
      }
    } else if (this.inBlock) {
      // Cierre del bloque → candidato = máximo rastreado.
      this.inBlock = false;
      const minBlock = Math.max(2, Math.round(this.maPeak.size * this.cfg.minBlockFracOfW1));
      const candidateTime = this.blockMaxTime;
      const candidateVal = this.blockMaxVal;

      const decision = this.evaluateCandidate(candidateTime, candidateVal, this.blockLen, minBlock);
      reason = decision.reason;
      if (decision.emit) {
        isPeak = true;
        peakTimeMs = candidateTime;
        peakValue = candidateVal;
        score = decision.score;
        this.commitEmission(candidateTime, candidateVal);
      }
    }

    return {
      isPeak,
      peakTimeMs,
      peakValue,
      score,
      reason,
      threshold,
      maPeak,
      inBlock: this.inBlock,
    };
  }

  private evaluateCandidate(
    time: number,
    val: number,
    blockLen: number,
    minBlock: number,
  ): { emit: boolean; score: number; reason: string } {
    if (blockLen < minBlock) return { emit: false, score: 0, reason: 'BLOCK_TOO_SHORT' };
    if (val <= 0) return { emit: false, score: 0, reason: 'NON_POSITIVE_PEAK' };

    // Refractario adaptativo (lado bajo del RR → tolera arritmias/pausas).
    if (this.lastEmitTime > 0) {
      const gap = time - this.lastEmitTime;
      if (gap < this.adaptiveRefractoryMs()) {
        return { emit: false, score: 0, reason: 'REFRACTORY' };
      }
      if (gap < VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS) {
        return { emit: false, score: 0, reason: 'RR_TOO_SHORT' };
      }
    }

    // Rechazo de dícrota/ruido por amplitud RELATIVA a la mediana reciente (estable,
    // no una banda per-frame). Sólo activo con historial suficiente.
    const medAmp = this.median(this.recentAmp);
    if (medAmp > 0 && val < medAmp * this.cfg.amplitudeRejectFrac) {
      return { emit: false, score: 0, reason: 'LOW_REL_AMPLITUDE' };
    }

    // Score: consistencia de amplitud (cercanía a la mediana) ponderada por historial.
    let ampScore = 1;
    if (medAmp > 0) {
      const rel = Math.abs(val - medAmp) / medAmp;
      ampScore = clamp(1 - rel * 0.5, 0.3, 1);
    }
    const historyScore = clamp(this.recentRr.length / 4, 0.25, 1);
    const score = clamp(ampScore * 0.6 + historyScore * 0.4, 0, 1);

    return { emit: true, score, reason: 'PEAK_DETECTED' };
  }

  private commitEmission(time: number, val: number): void {
    if (this.lastEmitTime > 0) {
      const rr = time - this.lastEmitTime;
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
    this.lastEmitTime = time;
  }

  /** Mediana RR (ms) del historial reciente, 0 si no hay. */
  getMedianRrMs(): number {
    return this.median(this.recentRr);
  }

  getLastEmitTime(): number {
    return this.lastEmitTime;
  }

  /** Reabre la detección sin vaciar las ventanas de señal (dedo quieto). */
  softReset(): void {
    this.inBlock = false;
    this.blockLen = 0;
    this.blockMaxVal = -Infinity;
  }

  /** Reset total del estado (quitar dedo / recolocar). */
  reset(): void {
    this.fs = 0;
    this.inBlock = false;
    this.blockLen = 0;
    this.blockMaxVal = -Infinity;
    this.blockMaxTime = 0;
    this.lastEmitTime = 0;
    this.recentRr = [];
    this.recentAmp = [];
  }
}
