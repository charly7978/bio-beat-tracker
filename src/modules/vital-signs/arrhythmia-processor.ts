import { clamp } from '../../utils/math';
import { createLogger } from '../../utils/logger';
import { getMonotonicNow } from '../../utils/physio';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';

const log = createLogger('ArrhythmiaProcessor');

export interface RRData {
  intervals: number[];
  lastPeakTime: number | null;
  timestampNow?: number;
}

export interface ArrhythmiaMetrics {
  rmssd: number;
  cv: number;
  pnn50: number;
  pnn31: number;
  pnn325: number;
  tpr: number;
  shannonEntropy: number;
  sampleEntropy: number;
  rrVariation: number;
  outlierCount: number;
  abruptDiffCount: number;
  prematureBeatCount: number;
}

export type ArrhythmiaConfidence = 'none' | 'mild' | 'moderate' | 'severe';

export interface ArrhythmiaResult {
  arrhythmiaStatus: string;
  arrhythmiaCount: number;
  arrhythmiaConfidence: ArrhythmiaConfidence;
  arrhythmiaScore: number;
  lastArrhythmiaData: {
    timestamp: number;
    rmssd: number;
    rrVariation: number;
    metrics: ArrhythmiaMetrics;
  } | null;
}

export class ArrhythmiaProcessor {
  private readonly A = VITAL_THRESHOLDS.ARRHYTHMIA;
  private readonly RR_WINDOW_SIZE = this.A.RR_WINDOW_SIZE;
  private readonly QUIET_PERIOD_MS = this.A.QUIET_PERIOD_MS;
  private readonly LEARNING_PERIOD_MS = this.A.LEARNING_PERIOD_MS;
  private readonly MIN_EVENT_INTERVAL_MS = this.A.MIN_EVENT_INTERVAL_MS;
  private readonly MIN_VALID_RR_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS;
  private readonly MAX_VALID_RR_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS;

  private rrIntervals: number[] = [];
  private lastPeakTime: number | null = null;
  private isLearningPhase = true;
  private arrhythmiaDetected = false;
  private arrhythmiaCount = 0;
  private lastArrhythmiaTime = 0;
  private measurementStartTime = getMonotonicNow();
  private metrics: ArrhythmiaMetrics = this.emptyMetrics();
  private lastScore = 0;
  private lastDetectionKind: '' | 'RITMO IRREGULAR' | 'LATIDOS PREMATUROS' = '';
  private confirmAccumMs = 0;
  private lastEvalTime = 0;

  private onArrhythmiaDetection?: (detected: boolean) => void;

  public setArrhythmiaDetectionCallback(callback: (detected: boolean) => void): void {
    this.onArrhythmiaDetection = callback;
  }

  public processRRData(rrData?: RRData): ArrhythmiaResult {
    const now = typeof rrData?.timestampNow === 'number' && Number.isFinite(rrData.timestampNow)
      ? rrData.timestampNow
      : getMonotonicNow();

    const sinceStart = now - this.measurementStartTime;
    const inQuiet = sinceStart < this.QUIET_PERIOD_MS;
    const inWarmup = !inQuiet && sinceStart < this.LEARNING_PERIOD_MS;
    this.isLearningPhase = sinceStart < this.LEARNING_PERIOD_MS;

    if (rrData?.intervals && rrData.intervals.length > 0) {
      this.rrIntervals = rrData.intervals
        .filter(i => i >= this.MIN_VALID_RR_MS && i <= this.MAX_VALID_RR_MS)
        .slice(-Math.max(this.RR_WINDOW_SIZE, 14));
      this.lastPeakTime = rrData.lastPeakTime;

      const elapsed = this.lastPeakTime ? now - this.lastPeakTime : Number.MAX_SAFE_INTEGER;
      const hasFreshRhythm = elapsed <= 2500;

      if (inQuiet) {
      } else if (!inWarmup && hasFreshRhythm && this.rrIntervals.length >= this.RR_WINDOW_SIZE) {
        this.detectArrhythmia(now);
      }
    } else {
      this.lastPeakTime = null;
    }

    const status = inQuiet
      ? 'CALIBRANDO...'
      : inWarmup
        ? 'APRENDIENDO RITMO...'
        : this.arrhythmiaDetected
          ? `ARRITMIA DETECTADA${this.lastDetectionKind ? ' · ' + this.lastDetectionKind : ''}`
          : 'RITMO NORMAL';

    return {
      arrhythmiaStatus: status,
      arrhythmiaCount: this.arrhythmiaCount,
      arrhythmiaConfidence: this.computeConfidence(),
      arrhythmiaScore: this.lastScore,
      lastArrhythmiaData: this.arrhythmiaDetected
        ? { timestamp: now, rmssd: this.metrics.rmssd, rrVariation: this.metrics.rrVariation, metrics: { ...this.metrics } }
        : null,
    };
  }

  private detectArrhythmia(now: number): void {
    const valid = this.rrIntervals.slice(-this.RR_WINDOW_SIZE)
      .filter(r => r >= this.MIN_VALID_RR_MS && r <= this.MAX_VALID_RR_MS);

    if (valid.length < this.A.MIN_INTERVALS) {
      this.arrhythmiaDetected = false;
      return;
    }

    const sorted = [...valid].sort((a, b) => a - b);
    const n2 = sorted.length;
    const median = n2 % 2 === 0
      ? (sorted[n2 / 2 - 1] + sorted[n2 / 2]) / 2
      : sorted[Math.floor(n2 / 2)] ?? 0;

    if (median <= 0) {
      this.arrhythmiaDetected = false;
      return;
    }

    const n = valid.length;
    const mean = valid.reduce((a, b) => a + b, 0) / n;
    let sqSum = 0;
    for (const r of valid) sqSum += (r - mean) ** 2;
    const std = Math.sqrt(sqSum / (n - 1));
    const cv = std / mean;

    let rmssd = 0;
    let pnn50 = 0;
    if (n > 1) {
      let sqDiffSum = 0;
      let c50 = 0;
      for (let i = 1; i < n; i++) {
        const d = valid[i] - valid[i - 1];
        sqDiffSum += d * d;
        if (Math.abs(d) > 50) c50++;
      }
      rmssd = Math.sqrt(sqDiffSum / (n - 1));
      pnn50 = c50 / (n - 1);
    }

    const rrVariation = Math.abs(valid[n - 1] - median) / Math.max(1, median);

    let prematureBeatCount = 0;
    for (let i = 0; i < n - 1; i++) {
      const coupling = valid[i];
      const pause = valid[i + 1];
      if (coupling < median * 0.8 && pause > median * 1.2) {
        const pairSum = coupling + pause;
        if (Math.abs(pairSum - 2 * median) / (2 * median) <= 0.25) {
          prematureBeatCount++;
          i++;
        }
      }
    }

    this.metrics = {
      rmssd, cv, pnn50,
      pnn31: 0, pnn325: 0, tpr: 0,
      shannonEntropy: 0, sampleEntropy: 0,
      rrVariation, outlierCount: 0, abruptDiffCount: 0,
      prematureBeatCount,
    };

    const hrvPercent = cv * 100;
    const isIrregular = hrvPercent > 20 || rmssd > 120;
    const rawDetected = isIrregular || prematureBeatCount >= 2;

    const dt = this.lastEvalTime > 0 ? Math.min(Math.max(0, now - this.lastEvalTime), 1000) : 0;
    this.lastEvalTime = now;

    if (rawDetected) {
      this.confirmAccumMs = Math.min(this.confirmAccumMs + dt, this.A.ARRHYTHMIA_CONFIRM_MS * 1.5);
    } else {
      this.confirmAccumMs = Math.max(0, this.confirmAccumMs - dt * 2);
    }
    const confirmed = this.confirmAccumMs >= this.A.ARRHYTHMIA_CONFIRM_MS;

    this.lastDetectionKind = confirmed
      ? prematureBeatCount >= 2 ? 'LATIDOS PREMATUROS' : 'RITMO IRREGULAR'
      : '';

    this.lastScore = clamp(isIrregular ? 0.5 + hrvPercent / 100 : prematureBeatCount * 0.3, 0, 1);

    if (confirmed !== this.arrhythmiaDetected) {
      if (this.onArrhythmiaDetection) {
        this.onArrhythmiaDetection(confirmed);
        log.info(`Estado → ${confirmed ? 'ARRITMIA' : 'NORMAL'} score=${this.lastScore.toFixed(3)}`);
      }
    }

    if (confirmed && now - this.lastArrhythmiaTime >= this.MIN_EVENT_INTERVAL_MS) {
      this.arrhythmiaCount++;
      this.lastArrhythmiaTime = now;
      log.warn(`#${this.arrhythmiaCount} hrv=${hrvPercent.toFixed(1)}% rmssd=${rmssd.toFixed(0)} premature=${prematureBeatCount} [${this.lastDetectionKind}]`);
    }

    this.arrhythmiaDetected = confirmed;
  }

  private computeConfidence(): ArrhythmiaConfidence {
    const s = this.lastScore;
    if (this.isLearningPhase) return 'none';
    if (s >= 0.7) return 'severe';
    if (s >= 0.4) return 'moderate';
    if (s >= 0.2) return 'mild';
    return 'none';
  }

  public reset(): void {
    this.rrIntervals = [];
    this.lastPeakTime = null;
    this.isLearningPhase = true;
    this.arrhythmiaDetected = false;
    this.arrhythmiaCount = 0;
    this.lastArrhythmiaTime = 0;
    this.measurementStartTime = getMonotonicNow();
    this.metrics = this.emptyMetrics();
    this.lastScore = 0;
    this.lastDetectionKind = '';
    this.confirmAccumMs = 0;
    this.lastEvalTime = 0;
    if (this.onArrhythmiaDetection) this.onArrhythmiaDetection(false);
  }

  private emptyMetrics(): ArrhythmiaMetrics {
    return {
      rmssd: 0, cv: 0, pnn50: 0, pnn31: 0, pnn325: 0, tpr: 0,
      shannonEntropy: 0, sampleEntropy: 0,
      rrVariation: 0, outlierCount: 0, abruptDiffCount: 0,
      prematureBeatCount: 0,
    };
  }
}
