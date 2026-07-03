/**
 * STREAMING BEAT DETECTOR — umbral adaptativo + máximo local + refractario.
 *
 * Reemplaza la arquitectura frágil de "re-detectar toda la ventana en cada frame
 * y elegir el pico más reciente" (batch-por-frame + cherry-pick), causa raíz de
 * latidos pegados, silencios y jitter de timing.
 *
 * MÉTODO (validado en detección PPG en tiempo real — HeartPy/van Gent 2019,
 * detectores de umbral adaptativo + refractario; robusto frente a ruido y a la
 * modulación de amplitud, a diferencia del bloque de dos medias móviles que con
 * MA causal se fragmenta y localiza el pico en la rama descendente):
 *
 *   1) Envolvente de amplitud `ampEnv` = peak-hold con decaimiento lento del
 *      excursión positiva (≈ amplitud sistólica reciente). ESCALA-INVARIANTE:
 *      el umbral es una FRACCIÓN de ampEnv, no un valor absoluto → no hay gate
 *      que "cierre" por colapso de amplitud, y se re-adquiere solo al decaer.
 *   2) Umbral T = thrFrac · ampEnv (sobre la línea base lenta). Un latido cruza T
 *      en su flanco de subida; la MUESCA DÍCROTA (menor) no lo cruza.
 *   3) Máquina de estados: mientras x > T se rastrea el MÁXIMO REAL (x, t). Al
 *      caer x por debajo de T se CONFIRMA el pico = ese máximo → localización
 *      exacta del pico sistólico (no de la rama descendente).
 *   4) EMISIÓN ÚNICA por excursión + refractario fisiológico adaptativo (lado
 *      bajo del RR → tolera arritmias). Imposible doble-contar ni re-emitir.
 *
 * Consume la señal YA filtrada en vivo (bandpass causal único aguas arriba) → sin
 * re-filtrado offline (sin doble filtrado). Latencia: el pico se confirma al caer
 * por debajo del umbral (~100–180 ms tras el pico), CONSTANTE → se cancela en el
 * RR (diferencia de tiempos).
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
  /** Envolvente de amplitud instantánea (diagnóstico). */
  ampEnv: number;
  /** True mientras la muestra está por encima del umbral (excursión en curso). */
  inBlock: boolean;
}

export interface StreamingBeatDetectorConfig {
  /** Fracción de la envolvente de amplitud usada como umbral de detección. */
  thrFrac: number;
  /** EMA (por muestra) de la línea base lenta (quita deriva residual). */
  baselineAlpha: number;
  /** Ataque de la envolvente (subida cuando la excursión supera la actual). */
  envAttack: number;
  /** Decaimiento por SEGUNDO de la envolvente (re-adquisición al debilitarse). */
  envDecayPerSec: number;
  /** Piso absoluto de la envolvente para no disparar con ruido ínfimo. */
  envFloor: number;
  /** Refractario mínimo absoluto (ms) — anti doble conteo / dícrota. */
  refractoryMinMs: number;
  /** Fracción de la mediana RR usada como refractario adaptativo. */
  refractoryRrFrac: number;
  /** Rechazo de dícrota/ruido: el pico debe superar esta fracción de ampEnv. */
  amplitudeRejectFrac: number;
}

export const STREAMING_BEAT_DEFAULTS: StreamingBeatDetectorConfig = {
  thrFrac: 0.35,
  baselineAlpha: 0.02,
  envAttack: 0.5,
  envDecayPerSec: 0.55,
  envFloor: 1e-4,
  refractoryMinMs: PEAK_DETECTION_DEFAULTS.peakEmitRefractoryMinMs,
  refractoryRrFrac: 0.5,
  amplitudeRejectFrac: 0.3,
};

export class StreamingBeatDetector {
  private cfg: StreamingBeatDetectorConfig;

  private baseline = 0;
  private ampEnv = 0;
  private initialized = false;
  private lastTimeMs = 0;

  // Estado de la excursión supra-umbral en curso.
  private aboveThr = false;
  private excMaxVal = -Infinity;
  private excMaxTime = 0;

  // Historial para refractario adaptativo y score.
  private lastEmitTime = 0;
  private recentRr: number[] = [];
  private recentAmp: number[] = [];
  private readonly MAX_HISTORY = 12;

  constructor(cfg: Partial<StreamingBeatDetectorConfig> = {}) {
    this.cfg = { ...STREAMING_BEAT_DEFAULTS, ...cfg };
  }

  /** Compat: el ritmo detectado aguas arriba ya no ajusta ventanas fijas aquí. */
  setBeatWindowMs(_beatWindowMs: number): void {
    /* umbral adaptativo: sin ventanas fijas que recalibrar */
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
   * @param x       muestra filtrada (bandpass causal, zero-centrada)
   * @param timeMs  timestamp de la muestra (mismo reloj en toda la sesión)
   * @param fs      frecuencia de muestreo estimada (Hz) — para el decaimiento temporal
   */
  process(x: number, timeMs: number, fs: number): StreamingBeatSampleResult {
    const cfg = this.cfg;

    if (!this.initialized) {
      this.baseline = x;
      this.ampEnv = cfg.envFloor;
      this.lastTimeMs = timeMs;
      this.initialized = true;
      return this.idleResult('WARMUP');
    }

    const dtMs = timeMs > this.lastTimeMs ? timeMs - this.lastTimeMs : 1000 / Math.max(1, fs);
    this.lastTimeMs = timeMs;

    // Línea base lenta (deriva residual). La señal ya viene bandpass → ~0.
    this.baseline += cfg.baselineAlpha * (x - this.baseline);
    const pos = x - this.baseline;

    // Envolvente de amplitud: peak-hold con ataque rápido y decaimiento temporal
    // (independiente de fps). Escala-invariante.
    const decay = Math.pow(cfg.envDecayPerSec, dtMs / 1000);
    this.ampEnv = Math.max(this.ampEnv * decay, cfg.envFloor);
    if (pos > this.ampEnv) {
      this.ampEnv += cfg.envAttack * (pos - this.ampEnv);
    }

    const threshold = cfg.thrFrac * this.ampEnv;

    let isPeak = false;
    let peakTimeMs = 0;
    let peakValue = 0;
    let score = 0;
    let reason = this.aboveThr ? 'IN_EXCURSION' : 'BELOW_THR';

    if (pos > threshold) {
      // Dentro de una excursión supra-umbral: rastrea el máximo real.
      if (!this.aboveThr) {
        this.aboveThr = true;
        this.excMaxVal = -Infinity;
      }
      if (pos > this.excMaxVal) {
        this.excMaxVal = pos;
        this.excMaxTime = timeMs;
      }
    } else if (this.aboveThr) {
      // Fin de la excursión → candidato = máximo rastreado (pico sistólico real).
      this.aboveThr = false;
      const decision = this.evaluateCandidate(this.excMaxTime, this.excMaxVal);
      reason = decision.reason;
      if (decision.emit) {
        isPeak = true;
        peakTimeMs = this.excMaxTime;
        peakValue = this.excMaxVal;
        score = decision.score;
        this.commitEmission(this.excMaxTime, this.excMaxVal);
      }
    }

    return {
      isPeak,
      peakTimeMs,
      peakValue,
      score,
      reason,
      threshold,
      ampEnv: this.ampEnv,
      inBlock: this.aboveThr,
    };
  }

  private evaluateCandidate(time: number, val: number): { emit: boolean; score: number; reason: string } {
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

    // Rechazo de dícrota/ruido: el pico debe superar una fracción de la envolvente.
    if (val < this.ampEnv * this.cfg.amplitudeRejectFrac) {
      return { emit: false, score: 0, reason: 'LOW_REL_AMPLITUDE' };
    }

    // Score: cercanía a la amplitud típica × madurez del historial RR.
    const medAmp = this.median(this.recentAmp);
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

  private idleResult(reason: string): StreamingBeatSampleResult {
    return {
      isPeak: false,
      peakTimeMs: 0,
      peakValue: 0,
      score: 0,
      reason,
      threshold: this.cfg.thrFrac * this.ampEnv,
      ampEnv: this.ampEnv,
      inBlock: this.aboveThr,
    };
  }

  /** Mediana RR (ms) del historial reciente, 0 si no hay. */
  getMedianRrMs(): number {
    return this.median(this.recentRr);
  }

  getLastEmitTime(): number {
    return this.lastEmitTime;
  }

  /** Reabre la detección sin vaciar la envolvente (dedo quieto). */
  softReset(): void {
    this.aboveThr = false;
    this.excMaxVal = -Infinity;
  }

  /** Reset total del estado (quitar dedo / recolocar). */
  reset(): void {
    this.baseline = 0;
    this.ampEnv = 0;
    this.initialized = false;
    this.lastTimeMs = 0;
    this.aboveThr = false;
    this.excMaxVal = -Infinity;
    this.excMaxTime = 0;
    this.lastEmitTime = 0;
    this.recentRr = [];
    this.recentAmp = [];
  }
}
