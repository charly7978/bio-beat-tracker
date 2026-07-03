/**
 * HEARTBEAT PROCESSOR — detección Elgendi optimizada.
 * BPM y hápticos solo desde picos emitidos.
 */
import { clamp } from '../utils/math';
import { triggerHeartbeatHaptic } from '../utils/haptics';
import { robustBounds } from '../utils/stats';
import { PEAK_DETECTION_DEFAULTS, DSP_CONSTANTS } from '../config/signalProcessing';
import { VITAL_THRESHOLDS, adaptiveMotionLimit } from '../config/vitalThresholds';
import { StreamingBeatDetector } from './signal-processing/detectors/StreamingBeatDetector';
import { autocorrDominantLag } from './signal-processing/shared/dsp';
import { computeRrHrv } from '../utils/physio';
import {
  inferCameraRuntimeHints,
  type CameraRuntimeHints,
} from '../lib/device/cameraDeviceProfile';
import { bpmFromEmittedRr } from '../lib/measurement/peakEmitPolicy';
import type { FingerPlacementMode } from '../types/signal';

export interface HeartBeatProcessDiagnostics {
  ensemble?: Record<string, unknown>;
  lastPeakTime?: number;
  consensusReason?: string;
}

export class HeartBeatProcessor {
  private readonly MIN_PEAK_INTERVAL_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS;
  private readonly MAX_PEAK_INTERVAL_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS;

  private signalBuffer: number[] = [];
  private timestampBuffer: number[] = [];

  private lastPeakTime = 0;
  private rrIntervals: number[] = [];
  private smoothBPM = 0;
  /** HR de ritmo ESTABLECIDO — fusión de autocorrelación (robusta) + RR. */
  private trackedBpm = 0;
  private trackedBpmConf = 0;
  private lastTrackUpdateMs = 0;

  private audioContext: AudioContext | null = null;
  private audioUnlocked = false;
  private lastBeepTime = 0;

  private consecutivePeaks = 0;
  /** Picos emitidos (independiente de si el BPM aceptó el outlier). */
  private emittedPeakCount = 0;
  private signalQualityIndex = 0;
  private gateRelaxUntilMs = 0;
  private reacquireModeUntilMs = 0;

  private frameTick = 0;
  private cachedGateRange = 0;
  private cachedSampleRate: number = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
  private cachedPeriodicity: { bpm: number; score: number } = { bpm: 0, score: 0 };

  private lastDiagnostics: HeartBeatProcessDiagnostics = {};
  private lastEmittedPeakTime = 0;
  /** Detector de latidos en streaming (emisión única, refractario adaptativo). */
  private readonly beatDetector = new StreamingBeatDetector();
  /** Mantener BPM publicado entre latidos (~3 s a 45 BPM). */
  private readonly BPM_PUBLISH_HOLD_MS = 4200;
  private readonly GATE_RANGE_MIN = 0.022;
  private cameraHints: CameraRuntimeHints = inferCameraRuntimeHints();
  private placementMode: FingerPlacementMode = 'hybrid';
  private fingerContactConfirmed = false;
  /** SQI del pipeline PPG (SignalQualityIndex canónico) — ruta externa */
  private ppgSqi = 0;
  private ppgPerfusionIndex = 0;
  /** Movimiento IMU (EMA) del pipeline — suprime emisión de latidos durante movimiento. */
  private ppgMotionScore = 0;
  /** SQI auto-calculado por {@link calculateSQI} (ruta interna) */
  private internalSqi = 0;

  private unlockHandler = async () => {
    if (this.audioUnlocked) return;
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioContextClass();
      await this.audioContext.resume();
      this.audioUnlocked = true;
      this.removeAudioUnlockListeners();
    } catch {
      /* AudioContext unlock may fail in non-interactive contexts */
    }
  };

  private removeAudioUnlockListeners() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('touchstart', this.unlockHandler);
      document.removeEventListener('click', this.unlockHandler);
    }
  }

  constructor() {
    this.setupAudio();
  }

  private setupAudio() {
    if (typeof document === 'undefined') return;
    document.addEventListener('touchstart', this.unlockHandler, { passive: true });
    document.addEventListener('click', this.unlockHandler, { passive: true });
  }

  getDiagnostics(): HeartBeatProcessDiagnostics & { internalSqi: number; externalSqi: number } {
    return { ...this.lastDiagnostics, internalSqi: this.internalSqi, externalSqi: this.ppgSqi };
  }

  setRuntimeHints(hints: CameraRuntimeHints): void {
    this.cameraHints = hints;
  }

  setFingerPlacementMode(mode: FingerPlacementMode): void {
    this.placementMode = mode;
  }

  setFingerContactConfirmed(confirmed: boolean): void {
    this.fingerContactConfirmed = confirmed;
  }

  /** Alinea ensemble/detectores con el SQI central del PPG (evita doble escala). */
  setPpgQualityMetrics(sqi: number, perfusionIndex?: number, motionScore?: number): void {
    if (Number.isFinite(sqi) && sqi >= 0) this.ppgSqi = sqi;
    if (
      typeof perfusionIndex === 'number' &&
      Number.isFinite(perfusionIndex) &&
      perfusionIndex >= 0
    ) {
      this.ppgPerfusionIndex = perfusionIndex;
    }
    if (typeof motionScore === 'number' && Number.isFinite(motionScore) && motionScore >= 0) {
      this.ppgMotionScore = motionScore;
    }
  }

  /** Fusiona SQI interno (auto-calculado) con SQI externo (canónico del pipeline PPG).
   *  {@link internalSqi} refleja la consistencia local del pico.
   *  {@link ppgSqi} refleja la calidad global del PPG (PI, SNR, periodicidad).
   *  La fusión da mayor peso al canónico cuando es fiable, pero no anula al interno. */
  private ensembleInputSqi(localSqi: number): number {
    this.internalSqi = localSqi;
    if (this.ppgSqi < 3) return localSqi;
    const blended = this.ppgSqi * 0.65 + localSqi * 0.35;
    return clamp(Math.max(localSqi, blended), 0, 100);
  }

  private gateRangeMin(): number {
    const base = this.GATE_RANGE_MIN * this.cameraHints.gateRangeScale;
    if (this.placementMode === 'pad') return base * 0.9;
    return base;
  }

  private minNormalizeRange(): number {
    const base = PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_MIN_RANGE;
    return this.cameraHints.constrained ? base * 2.2 : base;
  }

  processSignal(filteredValue: number, timestamp?: number): {
    bpm: number;
    confidence: number;
    isPeak: boolean;
    filteredValue: number;
    sqi: number;
    internalSqi: number;
    externalSqi: number;
    consensusReason?: string;
    rrData?: {
      intervals: number[];
      lastPeakTime: number;
    };
    ensembleDiagnostics?: Record<string, unknown>;
  } {
    const now = timestamp ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());

    if (Math.abs(filteredValue) > 1e-6) {
      this.signalBuffer.push(filteredValue);
      this.timestampBuffer.push(now);
      if (this.signalBuffer.length > DSP_CONSTANTS.BUFFER_SIZE) {
        this.signalBuffer.shift();
        this.timestampBuffer.shift();
      }
    } else if (
      this.fingerContactConfirmed &&
      this.signalBuffer.length > 0 &&
      this.signalBuffer.length < DSP_CONSTANTS.BUFFER_SIZE
    ) {
      const hold = this.signalBuffer[this.signalBuffer.length - 1]! * 0.999;
      this.signalBuffer.push(hold);
      this.timestampBuffer.push(now);
    }

    if (this.signalBuffer.length < 20) {
      return { bpm: 0, confidence: 0, isPeak: false, filteredValue: 0, sqi: 0, internalSqi: 0, externalSqi: 0, ensembleDiagnostics: {} };
    }

    this.frameTick++;

    if (this.frameTick % 4 === 0 || this.cachedGateRange === 0) {
      const recentForGate = this.signalBuffer.slice(-60);
      const gSorted = [...recentForGate].sort((a, b) => a - b);
      this.cachedGateRange =
        (gSorted[Math.floor(gSorted.length * 0.9)] ?? 0) -
        (gSorted[Math.floor(gSorted.length * 0.1)] ?? 0);
    }

    const windowLen = this.consecutivePeaks < 3 ? 90 : 150;
    const { normalizedValue, range } = this.normalizeSignal(filteredValue, windowLen);

    if (this.frameTick % 6 === 0) {
      this.cachedPeriodicity = this.estimatePeriodicity();
    }
    this.internalSqi = this.calculateSQI(range, this.cachedPeriodicity.score);
    this.signalQualityIndex = this.internalSqi;

    let isPeak = false;
    let emitReason = 'WAITING';
    const sampleRate = this.estimateSampleRate();
    let ensembleConf = 0;

    // El SQI interno alimenta el score/confianza (no gatea la detección: el
    // detector streaming es escala-invariante y no depende de un gate de rango).
    this.ensembleInputSqi(this.signalQualityIndex);

    const gateOk = this.cachedGateRange >= this.gateRangeMin();
    const runDetect =
      this.signalBuffer.length >= 20 && (gateOk || this.fingerContactConfirmed);

    if (runDetect) {
      // Muestra actual = último valor bufferizado (incluye el "hold" de contacto).
      const sample = this.signalBuffer[this.signalBuffer.length - 1]!;
      const sampleTs = this.timestampBuffer[this.timestampBuffer.length - 1]!;
      const det = this.beatDetector.process(sample, sampleTs, sampleRate);
      ensembleConf = clamp(det.score, 0, 1);

      // Gate de movimiento (legítimo): durante movimiento IMU claro la señal se
      // corrompe. Si el SQI óptico es bueno se tolera más aceleración física
      // (acoplamiento dedo-lente estable pese a temblores).
      const effectiveSqi = Math.max(this.signalQualityIndex, this.ppgSqi);
      const motionLimit = adaptiveMotionLimit(
        effectiveSqi, PEAK_DETECTION_DEFAULTS.peakEmitMotionSuppress,
      );
      const motionSuppressed = this.ppgMotionScore > motionLimit;

      if (det.isPeak && motionSuppressed) {
        emitReason = 'MOTION_SUPPRESSED';
      } else if (det.isPeak) {
        isPeak = true;
        emitReason = det.reason;
        const wScore = det.score;
        const prevEmitted = this.lastEmittedPeakTime;
        this.lastEmittedPeakTime = det.peakTimeMs;
        this.lastPeakTime = det.peakTimeMs;
        this.emittedPeakCount += 1;
        this.reacquireModeUntilMs = 0;
        this.gateRelaxUntilMs = 0;

        if (prevEmitted > 0) {
          const rrMs = det.peakTimeMs - prevEmitted;
          if (rrMs >= this.MIN_PEAK_INTERVAL_MS && rrMs <= this.MAX_PEAK_INTERVAL_MS) {
            this.rrIntervals.push(rrMs);
            if (this.rrIntervals.length > DSP_CONSTANTS.MAX_RR_INTERVALS) {
              this.rrIntervals = this.rrIntervals.slice(-DSP_CONSTANTS.MAX_RR_INTERVALS);
            }
          }
        }

        const instantBpm = bpmFromEmittedRr(this.rrIntervals);
        this.consecutivePeaks += 1;

        if (instantBpm > 0) {
          const acceptOutlier =
            this.smoothBPM <= 0 ||
            Math.abs(instantBpm - this.smoothBPM) / Math.max(1, this.smoothBPM) <= 0.4;
          if (acceptOutlier) {
            if (this.smoothBPM === 0) {
              this.smoothBPM = instantBpm;
            } else {
              const rel = Math.abs(instantBpm - this.smoothBPM) / Math.max(1, this.smoothBPM);
              const trust = clamp(0.18 + wScore * 0.32, 0.18, 0.50);
              const alpha = rel > 0.22 ? trust : rel > 0.12 ? trust * 0.75 : trust * 0.45;
              this.smoothBPM = this.smoothBPM * (1 - alpha) + instantBpm * alpha;
            }
          }
        }

        if (wScore >= 0.4 && this.rrIntervals.length >= 1) {
          this.vibrate();
          this.playBeep();
        }
      }

      this.lastDiagnostics = {
        ensemble: {
          detectorScore: det.score,
          threshold: det.threshold,
          ampEnv: det.ampEnv,
          inBlock: det.inBlock,
          medianRrMs: this.beatDetector.getMedianRrMs(),
          emitReason,
          weightedScore: det.score,
          gateRange: this.cachedGateRange,
        },
        lastPeakTime: this.lastPeakTime,
        consensusReason: emitReason,
      };
    } else {
      this.lastDiagnostics = {
        ensemble: { gateRange: this.cachedGateRange, gateOk },
        consensusReason: gateOk ? 'BUFFERING' : 'LOW_AMPLITUDE',
      };
    }

    const peakAgeMs = this.lastPeakTime > 0 ? now - this.lastPeakTime : Number.POSITIVE_INFINITY;
    if (!isPeak && peakAgeMs > this.BPM_PUBLISH_HOLD_MS) {
      this.consecutivePeaks = 0;
      if (peakAgeMs > this.BPM_PUBLISH_HOLD_MS * 2) {
        this.smoothBPM = 0;
      }
    }

    const rrBpm = bpmFromEmittedRr(this.rrIntervals);

    // Tracker de ritmo: fusiona autocorrelación + RR → HR estable ESTABLECIDO.
    this.updateTrackedBpm(now, rrBpm);
    // Ancla el refractario del detector al ritmo estable (más robusto que la
    // mediana RR local, que el ruido corrompe).
    this.beatDetector.setExpectedRrMs(this.trackedBpm > 0 ? 60000 / this.trackedBpm : 0);
    // Si el ritmo se pierde de forma sostenida, olvidar el track.
    if (peakAgeMs > this.BPM_PUBLISH_HOLD_MS * 2) {
      this.trackedBpm = 0;
      this.trackedBpmConf = 0;
    }

    let publishBpm = 0;
    if (this.fingerContactConfirmed && peakAgeMs < this.BPM_PUBLISH_HOLD_MS) {
      // El HR publicado sale del tracker (estable). Sólo si aún no hay track se
      // recurre al RR/smoothBPM crudo como arranque.
      if (this.trackedBpm > 0) {
        publishBpm = Math.round(this.trackedBpm);
      } else if (this.smoothBPM > 0 && rrBpm > 0) {
        const agree = Math.abs(this.smoothBPM - rrBpm) / Math.max(1, rrBpm) < 0.08;
        publishBpm = Math.round(agree ? this.smoothBPM : rrBpm);
      } else if (this.smoothBPM > 0) {
        publishBpm = Math.round(this.smoothBPM);
      } else if (rrBpm > 0) {
        publishBpm = Math.round(rrBpm);
      }
    }

    const confidence = this.calculateConfidence(ensembleConf, isPeak);

    return {
      bpm: publishBpm,
      confidence,
      isPeak,
      filteredValue: normalizedValue,
      sqi: this.signalQualityIndex,
      internalSqi: this.internalSqi,
      externalSqi: this.ppgSqi,
      consensusReason: emitReason,
      rrData: {
        intervals: [...this.rrIntervals],
        lastPeakTime: this.lastPeakTime,
      },
      ensembleDiagnostics: this.lastDiagnostics.ensemble as Record<string, unknown> | undefined,
    };
  }

  private normalizeSignal(value: number, windowLen: number = 150): { normalizedValue: number; range: number } {
    const recent = this.signalBuffer.slice(-windowLen);
    const { low, high, range } = robustBounds(recent);
    const scale = PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_SCALE;
    if (range < this.minNormalizeRange()) {
      return {
        normalizedValue: value * PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_FALLBACK_GAIN,
        range,
      };
    }
    const clipped = Math.min(high, Math.max(low, value));
    const normalizedValue = ((clipped - low) / range - 0.5) * scale;
    return { normalizedValue, range };
  }

  private normalizeWindow(values: number[], windowLen: number = 150): number[] {
    const refWindow = this.signalBuffer.slice(-windowLen);
    const { low, high, range } = robustBounds(refWindow);
    const scale = PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_SCALE;
    if (range < this.minNormalizeRange()) {
      return values.map((v) => v * PEAK_DETECTION_DEFAULTS.HEARTBEAT_NORM_FALLBACK_GAIN);
    }
    return values.map((v) => {
      const c = Math.min(high, Math.max(low, v));
      return ((c - low) / range - 0.5) * scale;
    });
  }

  private estimateSampleRate(): number {
    if (this.timestampBuffer.length < 10) return this.cachedSampleRate || DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
    if (this.frameTick % 30 !== 0 && this.cachedSampleRate > 0) {
      return this.cachedSampleRate;
    }
    const recent = this.timestampBuffer.slice(-50);
    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      const d = recent[i] - recent[i - 1];
      if (d >= 10 && d <= 100) intervals.push(d);
    }
    if (intervals.length < 6) return this.cachedSampleRate || DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 33;
    this.cachedSampleRate = clamp(1000 / median, 20, 40);
    return this.cachedSampleRate;
  }

  private estimatePeriodicity(): { bpm: number; score: number } {
    if (this.signalBuffer.length < 60) return { bpm: 0, score: 0 };

    const sampleRate = this.estimateSampleRate();
    const windowLen =
      this.consecutivePeaks < 3
        ? PEAK_DETECTION_DEFAULTS.HEARTBEAT_WINDOW_WARMUP
        : PEAK_DETECTION_DEFAULTS.HEARTBEAT_WINDOW_STABLE;
    const recentSignal = this.normalizeWindow(this.signalBuffer.slice(-windowLen), windowLen);
    const mean = recentSignal.reduce((s, v) => s + v, 0) / recentSignal.length;
    const centered = recentSignal.map((v) => v - mean);
    const energy = centered.reduce((s, v) => s + v * v, 0);

    if (energy < 400) return { bpm: 0, score: 0 };

    const minLag = Math.max(5, Math.round((sampleRate * 60) / 200));
    const maxLag = Math.min(centered.length - 8, Math.round((sampleRate * 60) / 38));
    // Autocorrelación compartida (dsp.autocorrDominantLag) — sin duplicar el bucle.
    const { lag, score } = autocorrDominantLag(centered, minLag, maxLag);

    if (lag === 0 || score < 0.18) return { bpm: 0, score: Math.max(0, score) };
    return { bpm: (60 * sampleRate) / lag, score: clamp(score, 0, 1) };
  }

  private calculateSQI(range: number, periodicityScore: number): number {
    if (this.signalBuffer.length < 30) return 0;

    const rangeFactor = Math.min(1, range / 4) * 24;
    const nSig = this.signalBuffer.length;
    let meanAbsDeriv = 0;
    let derivCount = 0;
    const derivStart = Math.max(0, nSig - 61);
    for (let i = derivStart + 1; i < nSig; i++) {
      meanAbsDeriv += Math.abs(this.signalBuffer[i] - this.signalBuffer[i - 1]);
      derivCount++;
    }
    if (derivCount > 0) meanAbsDeriv /= derivCount;
    const slopeFactor = Math.min(1, meanAbsDeriv / 0.8) * 14;

    let rrFactor = 0;
    if (this.rrIntervals.length >= 3) {
      const cv = computeRrHrv(this.rrIntervals).cv;
      rrFactor = Math.max(0, 1 - cv * 2) * 24;
    }

    const peakFactor = Math.min(1, this.consecutivePeaks / 4) * 22;
    const periodicityFactor = periodicityScore * 16;

    let sqi = clamp(rangeFactor + slopeFactor + rrFactor + peakFactor + periodicityFactor, 0, 100);
    const agree = (this.lastDiagnostics.ensemble?.agreement as { elgendi?: number } | undefined)?.elgendi;
    if (typeof agree === 'number' && agree > 0) {
      sqi = clamp(sqi + agree * 10, 0, 100);
    }
    return sqi;
  }

  /**
   * TRACKER DE RITMO — establece un HR estable fusionando la estimación por
   * AUTOCORRELACIÓN (robusta, ventana temporal → no salta por un latido perdido o
   * doble) con el RR latido-a-latido (preciso pero frágil). El HR publicado sale
   * de aquí, no del RR crudo: por eso el ritmo "se asienta" en vez de bailar.
   *
   *   - Concuerdan (autocorr ≈ RR): lock fuerte, se prioriza el RR para precisión.
   *   - Discrepan: se confía en la fuente más fiable (autocorr si su score es alto).
   *   - Cambios acotados por una tasa máxima (bpm/s) → no da saltos no fisiológicos.
   */
  private updateTrackedBpm(now: number, rrBpm: number): void {
    const HRmin = VITAL_THRESHOLDS.HR.MIN;
    const HRmax = VITAL_THRESHOLDS.HR.MAX;
    const spec = this.cachedPeriodicity;
    const specOk = spec.bpm >= HRmin && spec.bpm <= HRmax && spec.score >= 0.35;
    const rrOk = rrBpm >= HRmin && rrBpm <= HRmax && this.rrIntervals.length >= 2;

    let target = 0;
    let conf = 0;
    if (specOk && rrOk) {
      const agree = Math.abs(spec.bpm - rrBpm) / Math.max(1, rrBpm) < 0.12;
      if (agree) {
        target = rrBpm * 0.6 + spec.bpm * 0.4;
        conf = clamp(0.65 + spec.score * 0.35, 0, 1);
      } else if (spec.score >= 0.55) {
        target = spec.bpm;
        conf = spec.score;
      } else {
        target = rrBpm;
        conf = 0.5;
      }
    } else if (rrOk) {
      target = rrBpm;
      conf = 0.45;
    } else if (specOk) {
      target = spec.bpm;
      conf = spec.score * 0.7;
    } else {
      this.trackedBpmConf *= 0.99;
      return;
    }

    if (this.trackedBpm <= 0) {
      if (conf >= 0.4) {
        this.trackedBpm = target;
        this.trackedBpmConf = conf;
      }
      this.lastTrackUpdateMs = now;
      return;
    }

    const dtS =
      this.lastTrackUpdateMs > 0 ? clamp((now - this.lastTrackUpdateMs) / 1000, 0.01, 1) : 0.033;
    this.lastTrackUpdateMs = now;
    const maxStep = 18 * dtS; // tasa máxima de cambio del ritmo (bpm/s)
    const alpha = clamp(0.15 + conf * 0.3, 0.1, 0.5);
    const raw = this.trackedBpm + (target - this.trackedBpm) * alpha;
    const change = clamp(raw - this.trackedBpm, -maxStep, maxStep);
    this.trackedBpm += change;
    this.trackedBpmConf = this.trackedBpmConf * 0.7 + conf * 0.3;
  }

  private calculateConfidence(ensembleConf: number, isPeak: boolean): number {
    const effectiveSqi = this.signalQualityIndex;
    const sqiFactor = effectiveSqi / 100;
    const peakSupport = Math.min(1, this.consecutivePeaks / 5);
    const ens = clamp(ensembleConf, 0, 1);
    const peakBoost = isPeak ? 0.12 : 0;

    if (this.rrIntervals.length < 2) {
      return clamp(sqiFactor * 0.22 + peakSupport * 0.22 + ens * 0.36 + peakBoost, 0, 0.85);
    }

    const mean = this.rrIntervals.reduce((a, b) => a + b, 0) / this.rrIntervals.length;
    const variance = this.rrIntervals.reduce((a, rr) => a + (rr - mean) ** 2, 0) / this.rrIntervals.length;
    const cv = Math.sqrt(variance) / Math.max(1, mean);
    const rrStability = clamp(1 - cv * 1.5, 0, 1);

    return clamp(
      rrStability * 0.32 + peakSupport * 0.22 + sqiFactor * 0.2 + ens * 0.16 + peakBoost,
      0,
      1,
    );
  }

  private vibrate(): void {
    triggerHeartbeatHaptic().catch(() => undefined);
  }

  private async playBeep(): Promise<void> {
    if (!this.audioContext || !this.audioUnlocked) return;
    const t0 = Date.now();
    if (t0 - this.lastBeepTime < 280) return;
    try {
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      const t = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      osc.frequency.setValueAtTime(820, t);
      osc.frequency.exponentialRampToValueAtTime(460, t + 0.08);
      gain.gain.setValueAtTime(0.14, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      osc.connect(gain);
      gain.connect(this.audioContext.destination);
      osc.start(t);
      osc.stop(t + 0.12);
      this.lastBeepTime = t0;
    } catch {
      /* Audio beep may fail if AudioContext is in a closed state */
    }
  }

  getRRIntervals(): number[] { return [...this.rrIntervals]; }
  getLastPeakTime(): number { return this.lastPeakTime; }

  /**
   * Reabre detección sin vaciar buffers (dedo quieto que dejó de latir).
   */
  softReacquirePeaks(nowMs?: number): void {
    const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.gateRelaxUntilMs = t + 6500;
    this.reacquireModeUntilMs = t + 6500;
    this.consecutivePeaks = 0;
    this.beatDetector.softReset();
  }

  /** Limpia estado de picos/RR al quitar el dedo o al volver a colocarlo. */
  resetPeakTracking(): void {
    this.signalBuffer = [];
    this.timestampBuffer = [];
    this.rrIntervals = [];
    this.smoothBPM = 0;
    this.trackedBpm = 0;
    this.trackedBpmConf = 0;
    this.lastTrackUpdateMs = 0;
    this.lastPeakTime = 0;
    this.lastEmittedPeakTime = 0;
    this.consecutivePeaks = 0;
    this.emittedPeakCount = 0;
    this.frameTick = 0;
    this.cachedGateRange = 0;
    this.gateRelaxUntilMs = 0;
    this.reacquireModeUntilMs = 0;
    this.lastDiagnostics = {};
    this.beatDetector.reset();
  }

  reset(): void {
    this.resetPeakTracking();
    this.signalQualityIndex = 0;
    this.internalSqi = 0;
    this.cachedSampleRate = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE;
    this.cachedPeriodicity = { bpm: 0, score: 0 };
    this.fingerContactConfirmed = false;
    this.ppgSqi = 0;
    this.ppgPerfusionIndex = 0;
    this.ppgMotionScore = 0;
  }

  dispose(): void {
    this.removeAudioUnlockListeners();
    if (this.audioContext) {
      this.audioContext.close().catch(() => {
        // Ignore audio context close failures
      });
    }
  }
}
