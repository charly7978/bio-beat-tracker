/**
 * STREAMING BEAT DETECTOR — Elgendi fiel (two moving averages) con EMISIÓN ÚNICA
 * POR CONFIRMACIÓN (settled-peak).
 *
 * Algoritmo de detección: Elgendi et al. 2013, PLoS ONE "Systolic Peak Detection
 * in Acceleration Photoplethysmograms..." — implementación fiel a NeuroKit2
 * (`_ppg_findpeaks_elgendi`): recorte de negativos + cuadrado, dos medias móviles
 * boxcar (MA_peak 111 ms, MA_beat 667 ms), umbral = MA_beat + β·media(señal²) con
 * β=0.02, bloques de interés donde MA_peak>umbral, descarte de bloques < peakwindow,
 * pico = máximo de mayor prominencia por bloque, mindelay 300 ms. Ese detector vive
 * en {@link ElgendiPeakDetector} (batch, validado y testeado).
 *
 * PROBLEMA que resuelve la CAPA de streaming: correr un detector batch en cada
 * frame y "elegir el pico más reciente del borde vivo" (arquitectura anterior)
 * emite picos AÚN NO ASENTADOS — la media móvil CENTRADA no tiene soporte futuro
 * cerca del borde, así que el pico salta/aparece/desaparece entre frames → latidos
 * dobles y silencios.
 *
 * SOLUCIÓN (settled-peak / confirmación): se corre Elgendi sobre la ventana y sólo
 * se EMITE un pico cuando ya está lo bastante ATRÁS del borde vivo como para que la
 * MA_beat centrada (±beatwindow/2) y la prominencia tengan soporte completo →
 * `latest − t ≥ confirmLagMs`. Cada pico se emite EXACTAMENTE UNA vez (dedup por
 * tiempo contra el último emitido) → imposible doble-contar o re-emitir. Elgendi
 * detecta de forma robusta → sin silencios. La latencia añadida es CONSTANTE
 * (~confirmLag) → se cancela en el RR (diferencia de tiempos).
 */
import { clamp } from '../../../utils/math';
import { VITAL_THRESHOLDS } from '../../../config/vitalThresholds';
import { PEAK_DETECTION_DEFAULTS, DSP_CONSTANTS } from '../../../config/signalProcessing';
import { PeakDetectionEnsemble } from './PeakDetectionEnsemble';

export interface StreamingBeatSampleResult {
  /** True SÓLO en el frame en que se confirma (emite) un latido genuino. */
  isPeak: boolean;
  /** Tiempo (ms, mismo reloj que los timestamps de entrada) del pico sistólico. */
  peakTimeMs: number;
  /** Amplitud (señal filtrada) del pico. 0 si no hubo emisión. */
  peakValue: number;
  /** Score de confianza del pico [0..1]. */
  score: number;
  /** Motivo auditable de la decisión de este frame. */
  reason: string;
  /** Umbral Elgendi instantáneo del último análisis (diagnóstico). */
  threshold: number;
  /** Confianza del detector Elgendi sobre la ventana (diagnóstico). */
  ampEnv: number;
  /** True si hay un bloque de interés abierto en el borde vivo (diagnóstico). */
  inBlock: boolean;
}

export interface StreamingBeatDetectorConfig {
  /** Muestras mínimas en la ventana para correr Elgendi. */
  minSamples: number;
  /** Máximo de la ventana de análisis (muestras). */
  maxWindow: number;
  /**
   * Retardo de confirmación (ms): un pico en t se emite cuando latest−t ≥ este
   * valor, garantizando soporte completo de la MA_beat CENTRADA (±333 ms) y de la
   * prominencia. Debe ser ≥ beatwindow/2. Añade latencia CONSTANTE (se cancela en RR).
   */
  confirmLagMs: number;
  /** mindelay Elgendi (ms) entre picos consecutivos (refractario canónico). */
  minDelayMs: number;
  /** Fracción de la mediana RR usada como refractario adaptativo (lado bajo). */
  refractoryRrFrac: number;
  /** Correr Elgendi cada N frames (throttle de CPU; la emisión sigue siendo puntual). */
  analyzeEveryNFrames: number;
}

export const STREAMING_BEAT_DEFAULTS: StreamingBeatDetectorConfig = {
  minSamples: PEAK_DETECTION_DEFAULTS.minSamplesEnsemble,
  maxWindow: DSP_CONSTANTS.BUFFER_SIZE,
  confirmLagMs: 380,
  minDelayMs: PEAK_DETECTION_DEFAULTS.peakEmitRefractoryMinMs,
  refractoryRrFrac: 0.5,
  analyzeEveryNFrames: 2,
};

export class StreamingBeatDetector {
  private cfg: StreamingBeatDetectorConfig;

  // Ring buffer de la señal filtrada en vivo.
  private sig: number[] = [];
  private ts: number[] = [];
  private frame = 0;

  private lastEmittedPeakTime = 0;
  private recentRr: number[] = [];
  private recentAmp: number[] = [];
  private readonly MAX_HISTORY = 12;

  private lastThreshold = 0;
  private lastElgendiConf = 0;
  private lastInBlock = false;

  // Contexto de calidad para calibrar el detector Elgendi.
  private sqi = 0;
  private perfusionIndex = 0;
  /** RR esperado (ms) del tracker de ritmo — ancla estable del refractario. */
  private expectedRrMs = 0;

  constructor(cfg: Partial<StreamingBeatDetectorConfig> = {}) {
    this.cfg = { ...STREAMING_BEAT_DEFAULTS, ...cfg };
  }

  /** Contexto de calidad del pipeline PPG para calibrar Elgendi (SQI/PI). */
  setQualityContext(sqi: number, perfusionIndex: number): void {
    if (Number.isFinite(sqi) && sqi >= 0) this.sqi = sqi;
    if (Number.isFinite(perfusionIndex) && perfusionIndex >= 0) this.perfusionIndex = perfusionIndex;
  }

  /** Compat: Elgendi usa beatwindow interno; el ritmo no ajusta ventanas fijas aquí. */
  setBeatWindowMs(_beatWindowMs: number): void {
    /* no-op: beatwindow canónico dentro de ElgendiPeakDetector */
  }

  /** Ancla el refractario a un RR de ritmo estable (tracker); 0 = mediana local. */
  setExpectedRrMs(rrMs: number): void {
    this.expectedRrMs =
      Number.isFinite(rrMs) && rrMs >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS ? rrMs : 0;
  }

  /** Valor de la señal en la muestra de timestamp más cercano a `t` (ventana ordenada). */
  private valueAtTime(t: number): number {
    let bestDt = Infinity;
    let bestVal = 0;
    for (let i = this.ts.length - 1; i >= 0; i--) {
      const dt = Math.abs(this.ts[i]! - t);
      if (dt < bestDt) {
        bestDt = dt;
        bestVal = this.sig[i]!;
      } else if (this.ts[i]! < t - bestDt) {
        break; // más atrás sólo aumenta la distancia (ts ascendente)
      }
    }
    return bestVal;
  }

  private median(arr: number[]): number {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }

  /** Refractario efectivo: canónico (mindelay) o anclado al ritmo estable (lado bajo). */
  private effectiveMinDelayMs(): number {
    const anchorRr = this.expectedRrMs > 0 ? this.expectedRrMs : this.median(this.recentRr);
    const adaptive = anchorRr > 0 ? anchorRr * this.cfg.refractoryRrFrac : 0;
    return Math.max(this.cfg.minDelayMs, adaptive);
  }

  /**
   * Procesa UNA muestra de la señal filtrada en vivo. Acumula en la ventana y
   * (throttled) corre Elgendi, emitiendo el pico confirmado más antiguo aún no emitido.
   */
  process(x: number, timeMs: number, fs: number): StreamingBeatSampleResult {
    // Acumula en la ventana (drop del más antiguo).
    this.sig.push(x);
    this.ts.push(timeMs);
    if (this.sig.length > this.cfg.maxWindow) {
      this.sig.shift();
      this.ts.shift();
    }
    this.frame++;

    const idle = (reason: string): StreamingBeatSampleResult => ({
      isPeak: false,
      peakTimeMs: 0,
      peakValue: 0,
      score: 0,
      reason,
      threshold: this.lastThreshold,
      ampEnv: this.lastElgendiConf,
      inBlock: this.lastInBlock,
    });

    if (this.sig.length < this.cfg.minSamples) return idle('WARMUP');
    // Throttle del análisis (CPU); en los frames intermedios no se emite.
    if (this.frame % this.cfg.analyzeEveryNFrames !== 0) return idle('THROTTLED');

    // Elgendi fiel + calibración por SQI/PI + scoring (wrapper validado).
    const ens = PeakDetectionEnsemble.analyze({
      signal: this.sig,
      timestampsMs: this.ts,
      samplingRateHz: fs,
      sqi: this.sqi,
      perfusionIndex: this.perfusionIndex,
    });

    const elgDiag = (ens.diagnostics as { elgendi?: { thrOffset?: number } }).elgendi;
    this.lastThreshold = elgDiag?.thrOffset ?? 0;
    this.lastElgendiConf = ens.confidence;

    const latest = this.ts[this.ts.length - 1]!;
    const minDelay = this.effectiveMinDelayMs();
    const confirmLag = this.cfg.confirmLagMs;

    const times = ens.peakTimes;
    const scores = ens.peakScores;

    // ¿Hay un bloque abierto (pico sin asentar) cerca del borde? (diagnóstico)
    this.lastInBlock =
      times.length > 0 && times[times.length - 1]! > latest - confirmLag;

    // Elige el pico CONFIRMADO más antiguo que aún no fue emitido (sin asumir orden).
    let emitT = 0;
    let emitScore = 0;
    for (let i = 0; i < times.length; i++) {
      const t = times[i]!;
      if (t <= 0) continue;
      // Dedup / refractario: sólo picos posteriores al último emitido + refractario.
      if (this.lastEmittedPeakTime > 0 && t < this.lastEmittedPeakTime + minDelay) continue;
      // Confirmación: el pico debe estar asentado (soporte completo de la MA centrada).
      if (t > latest - confirmLag) continue;
      if (emitT === 0 || t < emitT) {
        emitT = t;
        emitScore = scores?.[i] ?? ens.confidence;
      }
    }

    if (emitT > 0) {
      // Amplitud del pico por timestamp más cercano (robusto al resampling interno
      // de Elgendi: sus índices no mapean 1:1 a esta ventana).
      const emitVal = this.valueAtTime(emitT);
      const rrMs = this.lastEmittedPeakTime > 0 ? emitT - this.lastEmittedPeakTime : 0;
      const score = this.scorePeak(Math.max(ens.confidence, emitScore), emitVal, rrMs);
      this.commitEmission(emitT, emitVal, rrMs);
      return {
        isPeak: true,
        peakTimeMs: emitT,
        peakValue: emitVal,
        score,
        reason: 'PEAK_CONFIRMED',
        threshold: this.lastThreshold,
        ampEnv: ens.confidence,
        inBlock: this.lastInBlock,
      };
    }

    return idle('NO_NEW_CONFIRMED_PEAK');
  }

  private scorePeak(elConf: number, val: number, rrMs: number): number {
    const conf = clamp(elConf, 0, 1);
    const medAmp = this.median(this.recentAmp);
    let ampScore = 1;
    if (medAmp > 0 && val > 0) {
      const rel = Math.abs(val - medAmp) / medAmp;
      ampScore = clamp(1 - rel * 0.5, 0.3, 1);
    }
    // Consistencia RR con el ritmo (si hay historial): bonus si el RR es plausible.
    let rrScore = 0.6;
    const medRr = this.expectedRrMs > 0 ? this.expectedRrMs : this.median(this.recentRr);
    if (medRr > 0 && rrMs > 0) {
      const rel = Math.abs(rrMs - medRr) / medRr;
      rrScore = clamp(1 - rel, 0.2, 1);
    }
    return clamp(conf * 0.45 + ampScore * 0.25 + rrScore * 0.3, 0, 1);
  }

  private commitEmission(time: number, val: number, rrMs: number): void {
    if (
      rrMs >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS &&
      rrMs <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS
    ) {
      this.recentRr.push(rrMs);
      if (this.recentRr.length > this.MAX_HISTORY) this.recentRr.shift();
    }
    if (val > 0) {
      this.recentAmp.push(val);
      if (this.recentAmp.length > this.MAX_HISTORY) this.recentAmp.shift();
    }
    this.lastEmittedPeakTime = time;
  }

  /** Mediana RR (ms) del historial reciente, 0 si no hay. */
  getMedianRrMs(): number {
    return this.median(this.recentRr);
  }

  getLastEmitTime(): number {
    return this.lastEmittedPeakTime;
  }

  /** Reabre la detección sin vaciar la ventana de señal (dedo quieto). */
  softReset(): void {
    this.lastInBlock = false;
  }

  /** Reset total del estado (quitar dedo / recolocar). */
  reset(): void {
    this.sig = [];
    this.ts = [];
    this.frame = 0;
    this.lastEmittedPeakTime = 0;
    this.recentRr = [];
    this.recentAmp = [];
    this.lastThreshold = 0;
    this.lastElgendiConf = 0;
    this.lastInBlock = false;
    this.expectedRrMs = 0;
  }
}
