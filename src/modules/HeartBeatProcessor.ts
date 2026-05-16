/**
 * HEARTBEAT PROCESSOR — ensemble Elgendi + Pan–Tompkins PPG.
 * BPM y hápticos solo desde picos emitidos (sin metrónomo ni autocorrelación como display).
 */
import { clamp } from '../utils/math';
import { PEAK_DETECTION_DEFAULTS } from '../config/signalProcessing';
import { VITAL_THRESHOLDS } from '../config/vitalThresholds';
import { PeakDetectionEnsemble } from './signal-processing/detectors/PeakDetectionEnsemble';
import {
  inferCameraRuntimeHints,
  type CameraRuntimeHints,
} from '../lib/device/cameraDeviceProfile';
import { bpmFromEmittedRr, decidePeakEmit } from '../lib/measurement/peakEmitPolicy';
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
  private derivativeBuffer: number[] = [];
  private timestampBuffer: number[] = [];
  private readonly BUFFER_SIZE = 300;

  private lastPeakTime = 0;
  private rrIntervals: number[] = [];
  private readonly MAX_RR_INTERVALS = 30;
  private smoothBPM = 0;

  private audioContext: AudioContext | null = null;
  private audioUnlocked = false;
  private lastBeepTime = 0;

  private consecutivePeaks = 0;
  private signalQualityIndex = 0;

  private frameTick = 0;
  private cachedGateRange = 0;
  private cachedSampleRate = 30;
  private cachedPeriodicity: { bpm: number; score: number } = { bpm: 0, score: 0 };

  private lastDiagnostics: HeartBeatProcessDiagnostics = {};
  private lastEmittedPeakTime = 0;
  /** Mantener BPM publicado entre latidos (~3 s a 45 BPM). */
  private readonly BPM_PUBLISH_HOLD_MS = 4200;
  private readonly GATE_RANGE_MIN = 0.032;
  private cameraHints: CameraRuntimeHints = inferCameraRuntimeHints();
  private placementMode: FingerPlacementMode = 'hybrid';
  private fingerContactConfirmed = false;
  /** SQI del pipeline PPG (SignalQualityIndex) — fuente primaria para el ensemble */
  private ppgSqi = 0;
  private ppgPerfusionIndex = 0;

  constructor() {
    this.setupAudio();
  }

  private setupAudio() {
    const unlock = async () => {
      if (this.audioUnlocked) return;
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        this.audioContext = new AudioContextClass();
        await this.audioContext.resume();
        this.audioUnlocked = true;
        document.removeEventListener('touchstart', unlock);
        document.removeEventListener('click', unlock);
      } catch { /* ignore */ }
    };
    document.addEventListener('touchstart', unlock, { passive: true });
    document.addEventListener('click', unlock, { passive: true });
  }

  getDiagnostics(): HeartBeatProcessDiagnostics {
    return { ...this.lastDiagnostics };
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
  setPpgQualityMetrics(sqi: number, perfusionIndex?: number): void {
    if (Number.isFinite(sqi) && sqi >= 0) this.ppgSqi = sqi;
    if (
      typeof perfusionIndex === 'number' &&
      Number.isFinite(perfusionIndex) &&
      perfusionIndex >= 0
    ) {
      this.ppgPerfusionIndex = perfusionIndex;
    }
  }

  private ensembleInputSqi(localSqi: number): number {
    if (this.ppgSqi < 3) return localSqi;
    return clamp(Math.max(localSqi, this.ppgSqi * 0.65 + localSqi * 0.35), 0, 100);
  }

  private gateRangeMin(): number {
    const base = this.GATE_RANGE_MIN * this.cameraHints.gateRangeScale;
    if (this.placementMode === 'pad') return base * 0.9;
    return base;
  }

  private minNormalizeRange(): number {
    return this.cameraHints.constrained ? 0.07 : 0.032;
  }

  processSignal(filteredValue: number, timestamp?: number): {
    bpm: number;
    confidence: number;
    isPeak: boolean;
    filteredValue: number;
    sqi: number;
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
      if (this.signalBuffer.length > this.BUFFER_SIZE) {
        this.signalBuffer.shift();
        this.timestampBuffer.shift();
      }
    }

    const derivative = this.calculateDerivative();
    this.derivativeBuffer.push(derivative);
    if (this.derivativeBuffer.length > this.BUFFER_SIZE) {
      this.derivativeBuffer.shift();
    }

    if (this.signalBuffer.length < 20) {
      return { bpm: 0, confidence: 0, isPeak: false, filteredValue: 0, sqi: 0, ensembleDiagnostics: {} };
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
    this.signalQualityIndex = this.calculateSQI(range, this.cachedPeriodicity.score);

    let isPeak = false;
    let emitReason = 'WAITING';
    const sampleRate = this.estimateSampleRate();
    let ensembleConf = 0;

    const gateOk = this.cachedGateRange >= this.gateRangeMin();

    if (gateOk && this.signalBuffer.length >= PEAK_DETECTION_DEFAULTS.minSamplesEnsemble) {
      const win = Math.min(this.BUFFER_SIZE, this.signalBuffer.length);
      const sigRaw = this.signalBuffer.slice(-win);
      const ts = this.timestampBuffer.slice(-win);
      const sig = this.normalizeWindow(sigRaw, Math.min(150, sigRaw.length));
      const ens = PeakDetectionEnsemble.analyze({
        signal: sig,
        timestampsMs: ts,
        samplingRateHz: sampleRate,
        sqi: this.ensembleInputSqi(this.signalQualityIndex),
        allowSoloElgendiFusion: this.cameraHints.allowSoloElgendiFusion,
      });
      ensembleConf = ens.confidence;

      const minPeakConf =
        VITAL_THRESHOLDS.QUALITY.MIN_ENSEMBLE_CONF_FOR_PEAK *
        (this.cameraHints.constrained ? 0.42 : 0.52);

      const decision = decidePeakEmit({
        ens,
        lastEmittedPeakMs: this.lastEmittedPeakTime,
        minPeakConf,
        consensusMin: this.cameraHints.peakConsensusMin,
        allowSoloElgendi: this.cameraHints.allowSoloElgendiFusion,
        sampleRateHz: sampleRate,
        windowSamples: win,
        placementMode: this.placementMode,
        fingerContactConfirmed: this.fingerContactConfirmed,
        nowMs: now,
      });

      if (decision.emit) {
        isPeak = true;
        emitReason = decision.reason;
        const prevEmitted = this.lastEmittedPeakTime;
        this.lastEmittedPeakTime = decision.peakTimeMs;
        this.lastPeakTime = decision.peakTimeMs;

        if (prevEmitted > 0) {
          const rrMs = decision.peakTimeMs - prevEmitted;
          if (rrMs >= this.MIN_PEAK_INTERVAL_MS && rrMs <= this.MAX_PEAK_INTERVAL_MS) {
            this.rrIntervals.push(rrMs);
            if (this.rrIntervals.length > this.MAX_RR_INTERVALS) {
              this.rrIntervals = this.rrIntervals.slice(-this.MAX_RR_INTERVALS);
            }
          }
        }

        const instantBpm = bpmFromEmittedRr(this.rrIntervals);
        if (instantBpm > 0) {
          const soloEmit =
            decision.reason === 'SOLO_ELGENDI' || decision.reason === 'SOLO_PAN';
          const maxJump = soloEmit ? 0.2 : 0.32;
          const acceptOutlier =
            this.smoothBPM <= 0 ||
            Math.abs(instantBpm - this.smoothBPM) / Math.max(1, this.smoothBPM) <= maxJump;
          if (acceptOutlier) {
            if (this.smoothBPM === 0) {
              this.smoothBPM = instantBpm;
            } else {
              const rel = Math.abs(instantBpm - this.smoothBPM) / Math.max(1, this.smoothBPM);
              const alpha = rel > 0.2 ? 0.12 : rel > 0.12 ? 0.2 : 0.3;
              this.smoothBPM = this.smoothBPM * (1 - alpha) + instantBpm * alpha;
            }
            this.consecutivePeaks++;
          }
        }

        if (this.rrIntervals.length >= 1 || decision.reason === 'DUAL_FUSED') {
          this.vibrate();
          this.playBeep();
        }
      }

      this.lastDiagnostics = {
        ensemble: {
          ...ens.diagnostics,
          agreement: ens.agreement,
          confidence: ens.confidence,
          rejectedPeaks: ens.rejectedPeaks,
          fusedPeakCount: ens.peaks.length,
          emitReason,
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
      if (peakAgeMs > this.BPM_PUBLISH_HOLD_MS * 1.15) {
        this.consecutivePeaks = 0;
        this.smoothBPM = 0;
      }
    }

    const publishBpm =
      this.smoothBPM > 0 &&
      peakAgeMs < this.BPM_PUBLISH_HOLD_MS &&
      this.consecutivePeaks >= 1 &&
      this.fingerContactConfirmed
        ? Math.round(this.smoothBPM)
        : 0;

    const confidence = this.calculateConfidence(ensembleConf, isPeak);

    return {
      bpm: publishBpm,
      confidence,
      isPeak,
      filteredValue: normalizedValue,
      sqi: this.signalQualityIndex,
      consensusReason: emitReason,
      rrData: {
        intervals: [...this.rrIntervals],
        lastPeakTime: this.lastPeakTime,
      },
      ensembleDiagnostics: this.lastDiagnostics.ensemble as Record<string, unknown> | undefined,
    };
  }

  private calculateDerivative(): number {
    const n = this.signalBuffer.length;
    if (n < 3) return 0;
    return (
      (this.signalBuffer[n - 1] - this.signalBuffer[n - 3]) * 0.5 +
      (this.signalBuffer[n - 1] - this.signalBuffer[n - 2]) * 0.5
    );
  }

  private getRobustBounds(values: number[]): { low: number; high: number; range: number } {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 0) return { low: 0, high: 0, range: 0 };
    const low = sorted[Math.floor((sorted.length - 1) * 0.1)] ?? sorted[0];
    const high = sorted[Math.floor((sorted.length - 1) * 0.9)] ?? sorted[sorted.length - 1];
    return { low, high, range: Math.max(0, high - low) };
  }

  private normalizeSignal(value: number, windowLen: number = 150): { normalizedValue: number; range: number } {
    const recent = this.signalBuffer.slice(-windowLen);
    const { low, high, range } = this.getRobustBounds(recent);
    if (range < this.minNormalizeRange()) return { normalizedValue: value * 8, range };
    const clipped = Math.min(high, Math.max(low, value));
    const normalizedValue = ((clipped - low) / range - 0.5) * 120;
    return { normalizedValue, range };
  }

  private normalizeWindow(values: number[], windowLen: number = 150): number[] {
    const refWindow = this.signalBuffer.slice(-windowLen);
    const { low, high, range } = this.getRobustBounds(refWindow);
    if (range < this.minNormalizeRange()) return values.map((v) => v * 8);
    return values.map((v) => {
      const c = Math.min(high, Math.max(low, v));
      return ((c - low) / range - 0.5) * 120;
    });
  }

  private estimateSampleRate(): number {
    if (this.timestampBuffer.length < 10) return this.cachedSampleRate || 30;
    if (this.frameTick % 30 !== 0 && this.cachedSampleRate > 0) {
      return this.cachedSampleRate;
    }
    const recent = this.timestampBuffer.slice(-50);
    const intervals: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      const d = recent[i] - recent[i - 1];
      if (d >= 10 && d <= 100) intervals.push(d);
    }
    if (intervals.length < 6) return this.cachedSampleRate || 30;
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 33;
    this.cachedSampleRate = clamp(1000 / median, 20, 40);
    return this.cachedSampleRate;
  }

  private estimatePeriodicity(): { bpm: number; score: number } {
    if (this.signalBuffer.length < 60) return { bpm: 0, score: 0 };

    const sampleRate = this.estimateSampleRate();
    const windowLen = this.consecutivePeaks < 3 ? 120 : 180;
    const recentSignal = this.normalizeWindow(this.signalBuffer.slice(-windowLen), windowLen);
    const mean = recentSignal.reduce((s, v) => s + v, 0) / recentSignal.length;
    const centered = recentSignal.map((v) => v - mean);
    const energy = centered.reduce((s, v) => s + v * v, 0);

    if (energy < 400) return { bpm: 0, score: 0 };

    const minLag = Math.max(5, Math.round((sampleRate * 60) / 200));
    const maxLag = Math.min(centered.length - 8, Math.round((sampleRate * 60) / 38));

    let bestLag = 0;
    let bestScore = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0;
      let eA = 0;
      let eB = 0;
      for (let i = lag; i < centered.length; i++) {
        cross += centered[i] * centered[i - lag];
        eA += centered[i] ** 2;
        eB += centered[i - lag] ** 2;
      }
      if (eA === 0 || eB === 0) continue;
      const correlation = cross / Math.sqrt(eA * eB);
      if (correlation > bestScore) {
        bestScore = correlation;
        bestLag = lag;
      }
    }

    if (bestLag === 0 || bestScore < 0.18) return { bpm: 0, score: Math.max(0, bestScore) };
    return { bpm: (60 * sampleRate) / bestLag, score: clamp(bestScore, 0, 1) };
  }

  private calculateSQI(range: number, periodicityScore: number): number {
    if (this.signalBuffer.length < 30) return 0;

    const rangeFactor = Math.min(1, range / 4) * 24;
    const derivWindow = this.derivativeBuffer.slice(-60);
    const meanAbsDeriv = derivWindow.length > 0
      ? derivWindow.reduce((s, v) => s + Math.abs(v), 0) / derivWindow.length
      : 0;
    const slopeFactor = Math.min(1, meanAbsDeriv / 0.8) * 14;

    let rrFactor = 0;
    if (this.rrIntervals.length >= 3) {
      const m = this.rrIntervals.reduce((a, b) => a + b, 0) / this.rrIntervals.length;
      const v = this.rrIntervals.reduce((a, rr) => a + (rr - m) ** 2, 0) / this.rrIntervals.length;
      const cv = Math.sqrt(v) / Math.max(1, m);
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

  private calculateConfidence(ensembleConf: number, isPeak: boolean): number {
    const sqiFactor = this.signalQualityIndex / 100;
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
    try { if (navigator.vibrate) navigator.vibrate(55); } catch { /* ignore */ }
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
    } catch { /* ignore */ }
  }

  getRRIntervals(): number[] { return [...this.rrIntervals]; }
  getLastPeakTime(): number { return this.lastPeakTime; }

  reset(): void {
    this.signalBuffer = [];
    this.derivativeBuffer = [];
    this.timestampBuffer = [];
    this.rrIntervals = [];
    this.smoothBPM = 0;
    this.lastPeakTime = 0;
    this.consecutivePeaks = 0;
    this.signalQualityIndex = 0;
    this.frameTick = 0;
    this.cachedGateRange = 0;
    this.cachedSampleRate = 30;
    this.cachedPeriodicity = { bpm: 0, score: 0 };
    this.lastDiagnostics = {};
    this.lastEmittedPeakTime = 0;
    this.fingerContactConfirmed = false;
    this.ppgSqi = 0;
    this.ppgPerfusionIndex = 0;
  }

  dispose(): void {
    if (this.audioContext) this.audioContext.close().catch(() => {});
  }
}
