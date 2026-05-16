/**
 * HEARTBEAT PROCESSOR — ensemble Elgendi + Pan–Tompkins PPG + autocorrelación.
 * Audio/hápticos y suavizado temporal; la detección de picos sale del ensemble único.
 */
import { clamp } from '../utils/math';
import { PEAK_DETECTION_DEFAULTS } from '../config/signalProcessing';
import { VITAL_THRESHOLDS } from '../config/vitalThresholds';
import { PeakDetectionEnsemble } from './signal-processing/detectors/PeakDetectionEnsemble';
import {
  inferCameraRuntimeHints,
  type CameraRuntimeHints,
} from '../lib/device/cameraDeviceProfile';
import { shouldEmitMetronomeBeat } from '../lib/measurement/beatMetronome';

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
  private frequencyBPM = 0;
  private periodicityScore = 0;

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
  /** Evita parpadeo BPM cuando el gate de amplitud falla 1–2 frames */
  private heldBpm = 0;
  private lastGoodBpmTime = 0;
  private readonly BPM_HOLD_MS = 6000;
  private readonly GATE_RANGE_MIN = 0.048;
  private cameraHints: CameraRuntimeHints = inferCameraRuntimeHints();

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

  private gateRangeMin(): number {
    return this.GATE_RANGE_MIN * this.cameraHints.gateRangeScale;
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

    this.signalBuffer.push(filteredValue);
    this.timestampBuffer.push(now);
    if (this.signalBuffer.length > this.BUFFER_SIZE) {
      this.signalBuffer.shift();
      this.timestampBuffer.shift();
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
      this.cachedGateRange = (gSorted[Math.floor(gSorted.length * 0.9)] ?? 0) - (gSorted[Math.floor(gSorted.length * 0.1)] ?? 0);
    }
    if (this.cachedGateRange < this.gateRangeMin()) {
      if (this.heldBpm > 0 && now - this.lastGoodBpmTime < this.BPM_HOLD_MS) {
        const isPeakHeld = this.tryEmitMetronomeBeat(now, this.heldBpm);
        return {
          bpm: Math.round(this.heldBpm),
          confidence: clamp(this.calculateConfidence(0) * 0.88, 0.1, 0.65),
          isPeak: isPeakHeld,
          filteredValue: 0,
          sqi: this.signalQualityIndex,
          ensembleDiagnostics: this.lastDiagnostics.ensemble,
        };
      }
      return { bpm: 0, confidence: 0, isPeak: false, filteredValue: 0, sqi: 0, ensembleDiagnostics: this.lastDiagnostics.ensemble };
    }

    const windowLen = this.consecutivePeaks < 3 ? 90 : 150;
    const { normalizedValue, range } = this.normalizeSignal(filteredValue, windowLen);

    if (this.frameTick % 6 === 0) {
      this.cachedPeriodicity = this.estimatePeriodicity();
    }
    const periodicity = this.cachedPeriodicity;
    this.periodicityScore = periodicity.score;

    if (periodicity.bpm > 0) {
      this.frequencyBPM = this.frequencyBPM === 0
        ? periodicity.bpm
        : this.frequencyBPM * 0.82 + periodicity.bpm * 0.18;
    } else {
      this.frequencyBPM = this.frequencyBPM * 0.94;
    }

    if (this.frameTick % 4 === 0) {
      this.signalQualityIndex = this.calculateSQI(range, this.periodicityScore);
    }

    const timeSinceLastPeak = this.lastPeakTime > 0 ? now - this.lastPeakTime : Number.MAX_SAFE_INTEGER;
    let isPeak = false;

    const sampleRate = this.estimateSampleRate();
    let ensembleBpm: number | null = null;
    let ensembleConf = 0;

    if (this.signalBuffer.length >= PEAK_DETECTION_DEFAULTS.minSamplesEnsemble) {
      const win = Math.min(240, this.signalBuffer.length);
      const sig = this.signalBuffer.slice(-win);
      const ts = this.timestampBuffer.slice(-win);
      const ens = PeakDetectionEnsemble.analyze({
        signal: sig,
        timestampsMs: ts,
        samplingRateHz: sampleRate,
        sqi: this.signalQualityIndex,
        allowSoloElgendiFusion: this.cameraHints.allowSoloElgendiFusion,
      });
      ensembleBpm = ens.bpmInstant;
      ensembleConf = ens.confidence;
      this.lastDiagnostics = {
        ensemble: {
          ...ens.diagnostics,
          agreement: ens.agreement,
          confidence: ens.confidence,
          rejectedPeaks: ens.rejectedPeaks,
          fusedPeakCount: ens.peaks.length,
        },
        lastPeakTime: ens.peakTimes.length ? ens.peakTimes[ens.peakTimes.length - 1] : this.lastPeakTime,
        consensusReason: ens.diagnostics?.reason as string | undefined,
      };

      if (ens.rrIntervalsMs.length) {
        const tail = ens.rrIntervalsMs.slice(-this.MAX_RR_INTERVALS);
        this.rrIntervals = tail;
      }

      const lastT = ens.peakTimes.length ? ens.peakTimes[ens.peakTimes.length - 1] : 0;
      const ensDiag = ens.diagnostics as { elgendiPeakTimes?: number[] } | undefined;
      const soloElLast =
        ensDiag?.elgendiPeakTimes?.length
          ? ensDiag.elgendiPeakTimes[ensDiag.elgendiPeakTimes.length - 1]!
          : 0;
      const candidateT = lastT > 0 ? lastT : soloElLast;
      const bufferNow = this.timestampBuffer[this.timestampBuffer.length - 1] ?? now;
      const peakWindowMs = this.cameraHints.constrained
        ? PEAK_DETECTION_DEFAULTS.peakEmitWindowMs
        : Math.round(PEAK_DETECTION_DEFAULTS.peakEmitWindowMs * 1.55);
      const peakDelta = candidateT > 0
        ? Math.min(Math.abs(candidateT - now), Math.abs(candidateT - bufferNow))
        : Number.POSITIVE_INFINITY;
      const peakFresh = peakDelta < peakWindowMs;
      const minEmitGap =
        this.MIN_PEAK_INTERVAL_MS * PEAK_DETECTION_DEFAULTS.peakEmitRefractoryFactor;
      const agreement = ens.agreement;
      const detectorConsensus =
        (agreement.elgendi + agreement.panTompkins) / 2;
      const minPeakConf =
        VITAL_THRESHOLDS.QUALITY.MIN_ENSEMBLE_CONF_FOR_PEAK *
        (this.cameraHints.constrained ? 0.5 : 0.42);
      const consensusMin = this.cameraHints.peakConsensusMin;
      const relaxedSolo =
        !this.cameraHints.constrained &&
        this.cameraHints.allowSoloElgendiFusion &&
        soloElLast > 0 &&
        candidateT === soloElLast;
      const ensembleEmit =
        candidateT > 0 &&
        peakFresh &&
        ensembleConf >= minPeakConf &&
        detectorConsensus >= consensusMin &&
        Math.abs(candidateT - this.lastEmittedPeakTime) > minEmitGap;
      const soloEmit =
        relaxedSolo &&
        peakFresh &&
        agreement.elgendi >= 0.26 &&
        ensembleConf >= minPeakConf * 0.55 &&
        Math.abs(soloElLast - this.lastEmittedPeakTime) > minEmitGap;

      if (ensembleEmit || soloEmit) {
        isPeak = true;
        this.lastEmittedPeakTime = candidateT;
        this.lastPeakTime = candidateT;

        if (ens.rrIntervalsMs.length >= 1) {
          const lastInt = ens.rrIntervalsMs[ens.rrIntervalsMs.length - 1];
          if (lastInt >= this.MIN_PEAK_INTERVAL_MS && lastInt <= this.MAX_PEAK_INTERVAL_MS) {
            const instantBPM = 60000 / lastInt;
            if (this.smoothBPM === 0) {
              this.smoothBPM = instantBPM;
            } else {
              const relativeDiff = Math.abs(instantBPM - this.smoothBPM) / Math.max(1, this.smoothBPM);
              let alpha = 0.25;
              if (relativeDiff > 0.30) alpha = 0.08;
              else if (relativeDiff > 0.18) alpha = 0.15;
              if (this.consecutivePeaks < 5) alpha = Math.max(0.06, alpha - 0.08);
              this.smoothBPM = this.smoothBPM * (1 - alpha) + instantBPM * alpha;
            }
            this.consecutivePeaks++;
          }
        }

        this.vibrate();
        this.playBeep();
      } else if (
        !isPeak &&
        ensembleBpm != null &&
        ensembleBpm >= PEAK_DETECTION_DEFAULTS.minBpm &&
        ensembleBpm <= PEAK_DETECTION_DEFAULTS.maxBpm &&
        ensembleConf >= (this.cameraHints.constrained ? 0.12 : 0.24) &&
        detectorConsensus >= (this.cameraHints.constrained ? 0.18 : 0.32) &&
        ens.rrIntervalsMs.length >= 2
      ) {
        const tail = ens.rrIntervalsMs.slice(-4);
        const medRr = tail.sort((a, b) => a - b)[Math.floor(tail.length / 2)] ?? 0;
        if (medRr >= this.MIN_PEAK_INTERVAL_MS && medRr <= this.MAX_PEAK_INTERVAL_MS) {
          const bpmFromEns = 60000 / medRr;
          if (this.smoothBPM === 0) {
            this.smoothBPM = bpmFromEns;
          } else {
            this.smoothBPM = this.smoothBPM * 0.94 + bpmFromEns * 0.06;
          }
        }
      }
    }

    if (!isPeak && this.lastPeakTime > 0 && timeSinceLastPeak > this.MAX_PEAK_INTERVAL_MS) {
      this.consecutivePeaks = Math.max(0, this.consecutivePeaks - 1);
    }

    let displayBPM = this.smoothBPM;
    if (displayBPM <= 0 && ensembleBpm != null && ensembleBpm > 0) {
      displayBPM = ensembleBpm;
    } else if (displayBPM <= 0 && this.frequencyBPM > 0 && this.periodicityScore > 0.35) {
      displayBPM = this.frequencyBPM;
    }
    let consensusCoherent = false;
    let consensusReason = 'PEAKS_ONLY';

    if (ensembleBpm != null && ensembleBpm > 0 && this.smoothBPM > 0) {
      const diff = Math.abs(this.smoothBPM - ensembleBpm);
      const diffPercent = diff / Math.max(1, this.smoothBPM);
      if (diffPercent < 0.12) {
        consensusCoherent = true;
        consensusReason = 'ENSEMBLE_TIME_CONSENSUS';
        displayBPM = this.smoothBPM * 0.55 + ensembleBpm * 0.45;
      }
    }

    if (this.frequencyBPM > 0 && displayBPM > 0) {
      const diff = Math.abs(displayBPM - this.frequencyBPM);
      const diffPercent = diff / Math.max(1, displayBPM);
      if (diffPercent < 0.12) {
        consensusCoherent = true;
        consensusReason = consensusReason === 'ENSEMBLE_TIME_CONSENSUS' ? 'ENSEMBLE_FREQ_CONSENSUS' : 'TIME_FREQ_CONSENSUS';
        const freqWeight = clamp((45 - this.signalQualityIndex) / 30, 0.1, 0.45);
        displayBPM = displayBPM * (1 - freqWeight) + this.frequencyBPM * freqWeight;
      } else if (this.consecutivePeaks >= 5 && this.signalQualityIndex > 65) {
        consensusReason = 'DOMINANT_PEAKS';
      } else if (this.periodicityScore > 0.85 && this.signalQualityIndex < 40) {
        consensusReason = 'DOMINANT_FREQ';
        displayBPM = this.frequencyBPM;
      } else {
        consensusReason = 'DIVERGENT_SOURCES';
      }
    }

    const confidence = this.calculateConfidence(ensembleConf);
    const finalConfidence = consensusCoherent ? Math.min(1.0, confidence * 1.12) : confidence * 0.88;

    if (displayBPM > 0 && finalConfidence >= 0.1) {
      this.heldBpm = displayBPM;
      this.lastGoodBpmTime = now;
    }

    if (!isPeak && displayBPM > 0) {
      isPeak = this.tryEmitMetronomeBeat(now, displayBPM);
    }

    return {
      bpm: displayBPM,
      confidence: finalConfidence,
      isPeak,
      filteredValue: normalizedValue,
      sqi: this.signalQualityIndex,
      consensusReason,
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
    return (this.signalBuffer[n - 1] - this.signalBuffer[n - 3]) * 0.5 + (this.signalBuffer[n - 1] - this.signalBuffer[n - 2]) * 0.5;
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
    if (range < 0.09) return { normalizedValue: 0, range: 0 };
    const clipped = Math.min(high, Math.max(low, value));
    const normalizedValue = ((clipped - low) / range - 0.5) * 120;
    return { normalizedValue, range };
  }

  private normalizeWindow(values: number[], windowLen: number = 150): number[] {
    const refWindow = this.signalBuffer.slice(-windowLen);
    const { low, high, range } = this.getRobustBounds(refWindow);
    if (range < 0.09) return values.map(() => 0);
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

    if (energy < 650) return { bpm: 0, score: 0 };

    const minLag = Math.max(5, Math.round((sampleRate * 60) / 200));
    const maxLag = Math.min(centered.length - 8, Math.round((sampleRate * 60) / 38));

    let bestLag = 0;
    let bestScore = 0;
    const expectedRR = this.getExpectedRR();
    const expectedLag = expectedRR > 0 ? Math.round((expectedRR / 1000) * sampleRate) : 0;

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
      const rhythmBias = expectedLag > 0
        ? 1 - Math.min(0.2, Math.abs(lag - expectedLag) / Math.max(1, expectedLag) * 0.12)
        : 1;
      const weighted = correlation * rhythmBias;

      if (weighted > bestScore) {
        bestScore = weighted;
        bestLag = lag;
      }
    }

    if (bestLag === 0 || bestScore < 0.2) return { bpm: 0, score: Math.max(0, bestScore) };
    return { bpm: (60 * sampleRate) / bestLag, score: clamp(bestScore, 0, 1) };
  }

  private calculateSQI(range: number, periodicityScore: number): number {
    if (this.signalBuffer.length < 30) return 0;

    const rangeFactor = Math.min(1, range / 5) * 22;
    const derivWindow = this.derivativeBuffer.slice(-60);
    const meanAbsDeriv = derivWindow.length > 0
      ? derivWindow.reduce((s, v) => s + Math.abs(v), 0) / derivWindow.length
      : 0;
    const slopeFactor = Math.min(1, meanAbsDeriv / 1.0) * 14;

    let rrFactor = 0;
    if (this.rrIntervals.length >= 3) {
      const m = this.rrIntervals.reduce((a, b) => a + b, 0) / this.rrIntervals.length;
      const v = this.rrIntervals.reduce((a, rr) => a + (rr - m) ** 2, 0) / this.rrIntervals.length;
      const cv = Math.sqrt(v) / Math.max(1, m);
      rrFactor = Math.max(0, 1 - cv * 2) * 22;
    }

    const peakFactor = Math.min(1, this.consecutivePeaks / 4) * 20;
    const periodicityFactor = periodicityScore * 22;

    let sqi = clamp(rangeFactor + slopeFactor + rrFactor + peakFactor + periodicityFactor, 0, 100);
    const agree = (this.lastDiagnostics.ensemble?.agreement as { elgendi?: number } | undefined)?.elgendi;
    if (typeof agree === 'number' && agree > 0) {
      sqi = clamp(sqi + agree * 8, 0, 100);
    }
    return sqi;
  }

  private getExpectedRR(): number {
    if (this.rrIntervals.length >= 3) {
      const recent = this.rrIntervals.slice(-6).sort((a, b) => a - b);
      return recent[Math.floor(recent.length / 2)] ?? recent[0] ?? 0;
    }
    if (this.frequencyBPM > 0) return 60000 / this.frequencyBPM;
    return 0;
  }

  private calculateConfidence(ensembleConf: number): number {
    const sqiFactor = this.signalQualityIndex / 100;
    const peakSupport = Math.min(1, this.consecutivePeaks / 5);
    const ens = clamp(ensembleConf, 0, 1);

    if (this.rrIntervals.length < 2) {
      return clamp(sqiFactor * 0.2 + peakSupport * 0.18 + this.periodicityScore * 0.28 + ens * 0.34, 0, 0.72);
    }

    const mean = this.rrIntervals.reduce((a, b) => a + b, 0) / this.rrIntervals.length;
    const variance = this.rrIntervals.reduce((a, rr) => a + (rr - mean) ** 2, 0) / this.rrIntervals.length;
    const cv = Math.sqrt(variance) / Math.max(1, mean);
    const rrStability = clamp(1 - cv * 1.7, 0, 1);

    return clamp(rrStability * 0.28 + peakSupport * 0.2 + sqiFactor * 0.18 + this.periodicityScore * 0.2 + ens * 0.14, 0, 1);
  }

  /** Beep/vibración alineados al BPM mostrado cuando el ensemble deja de emitir picos. */
  private tryEmitMetronomeBeat(now: number, bpm: number): boolean {
    const ok = shouldEmitMetronomeBeat({
      nowMs: now,
      lastEmittedPeakMs: this.lastEmittedPeakTime,
      displayBpm: bpm,
      consecutivePeaks: this.consecutivePeaks,
      lastGoodBpmAgeMs: now - this.lastGoodBpmTime,
      minBpm: PEAK_DETECTION_DEFAULTS.minBpm,
      maxBpm: PEAK_DETECTION_DEFAULTS.maxBpm,
      refractoryFactor: this.cameraHints.constrained ? 0.9 : 0.76,
    });
    if (!ok) return false;
    this.lastEmittedPeakTime = now;
    this.vibrate();
    void this.playBeep();
    return true;
  }

  private vibrate(): void {
    try { if (navigator.vibrate) navigator.vibrate(55); } catch { /* ignore */ }
  }

  private async playBeep(): Promise<void> {
    if (!this.audioContext || !this.audioUnlocked) return;
    const t0 = Date.now();
    if (t0 - this.lastBeepTime < 220) return;
    try {
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      const t = this.audioContext.currentTime;
      const osc = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      osc.frequency.setValueAtTime(820, t);
      osc.frequency.exponentialRampToValueAtTime(460, t + 0.08);
      gain.gain.setValueAtTime(0.12, t);
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
    this.frequencyBPM = 0;
    this.periodicityScore = 0;
    this.lastPeakTime = 0;
    this.consecutivePeaks = 0;
    this.signalQualityIndex = 0;
    this.frameTick = 0;
    this.cachedGateRange = 0;
    this.cachedSampleRate = 30;
    this.cachedPeriodicity = { bpm: 0, score: 0 };
    this.lastDiagnostics = {};
    this.lastEmittedPeakTime = 0;
    this.heldBpm = 0;
    this.lastGoodBpmTime = 0;
  }

  dispose(): void {
    if (this.audioContext) this.audioContext.close().catch(() => {});
  }
}
