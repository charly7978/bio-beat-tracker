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

/**
 * ArrhythmiaProcessor — RR irregularity analysis for PPG-based AF detection.
 *
 * Implements a weighted-scoring system over a multi-feature set informed by
 * state-of-the-art research (Buś 2022/2023, FibriCheck 2025, PMC reviews).
 *
 * Features:
 *   RMSSD, CV, pNN50, pNN31 (best absolute threshold), pNN3.25% (best relative),
 *   Turning Points Ratio (TPR), Shannon Entropy, Sample Entropy,
 *   abrupt-diff count, outlier fraction, irregular-sequence heuristics.
 *
 * Decision: weighted score → confidence level (none/mild/moderate/severe).
 * Callback fires on binary change (detected / not detected) using a
 * confidence ≥ moderate as the trigger threshold.
 */
export class ArrhythmiaProcessor {
  private readonly A = VITAL_THRESHOLDS.ARRHYTHMIA;
  private readonly RR_WINDOW_SIZE = this.A.RR_WINDOW_SIZE;
  private readonly LEARNING_PERIOD_MS = this.A.LEARNING_PERIOD_MS;
  private readonly MIN_EVENT_INTERVAL_MS = this.A.MIN_EVENT_INTERVAL_MS;
  private readonly MIN_VALID_RR_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS;
  private readonly MAX_VALID_RR_MS = VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS;

  // State
  private rrIntervals: number[] = [];
  private lastPeakTime: number | null = null;
  private isLearningPhase = true;
  private arrhythmiaDetected = false;
  private arrhythmiaCount = 0;
  private lastArrhythmiaTime = 0;
  private measurementStartTime = getMonotonicNow();

  // Current metrics & cached score (updated atomically after each detection)
  private metrics: ArrhythmiaMetrics = this.emptyMetrics();
  private lastScore = 0;

  private onArrhythmiaDetection?: (detected: boolean) => void;

  public setArrhythmiaDetectionCallback(callback: (detected: boolean) => void): void {
    this.onArrhythmiaDetection = callback;
  }

  /**
   * Process new RR-interval data and return current arrhythmia assessment.
   */
  public processRRData(rrData?: RRData): ArrhythmiaResult {
    const now = typeof rrData?.timestampNow === 'number' && Number.isFinite(rrData.timestampNow)
      ? rrData.timestampNow
      : getMonotonicNow();

    // End learning phase BEFORE processing data, so the first batch after the
    // calibration window is evaluated immediately rather than being skipped.
    if (now - this.measurementStartTime > this.LEARNING_PERIOD_MS) {
      this.isLearningPhase = false;
    }

    if (rrData?.intervals && rrData.intervals.length > 0) {
      this.rrIntervals = rrData.intervals
        .filter(i => i >= this.MIN_VALID_RR_MS && i <= this.MAX_VALID_RR_MS)
        .slice(-Math.max(this.RR_WINDOW_SIZE, 14));
      this.lastPeakTime = rrData.lastPeakTime;

      const elapsed = this.lastPeakTime ? now - this.lastPeakTime : Number.MAX_SAFE_INTEGER;
      const hasFreshRhythm = elapsed <= 2500;

      if (!this.isLearningPhase && hasFreshRhythm && this.rrIntervals.length >= this.RR_WINDOW_SIZE) {
        this.detectArrhythmia(now);
      } else if (!hasFreshRhythm) {
        this.arrhythmiaDetected = false;
      }
    } else {
      this.lastPeakTime = null;
    }

    const status = this.isLearningPhase
      ? 'CALIBRANDO...'
      : this.arrhythmiaDetected
        ? 'ARRITMIA DETECTADA'
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

  // ──────────────────────────────────────────────
  // Feature computation
  // ──────────────────────────────────────────────

  /**
   * Core detection: compute all features, run weighted scoring, update state.
   */
  private detectArrhythmia(now: number): void {
    if (this.rrIntervals.length < this.RR_WINDOW_SIZE) {
      this.arrhythmiaDetected = false;
      return;
    }

    const recent = this.rrIntervals.slice(-this.RR_WINDOW_SIZE);
    const valid = recent.filter(r => r >= this.MIN_VALID_RR_MS && r <= this.MAX_VALID_RR_MS);
    if (valid.length < this.A.MIN_INTERVALS) {
      this.arrhythmiaDetected = false;
      return;
    }

    const sorted = [...valid].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (median <= 0) {
      this.arrhythmiaDetected = false;
      return;
    }

    const n = valid.length;

    // --- 1. RMSSD & CV ---
    let sumSqDiff = 0;
    let sumRR = 0;
    for (let i = 0; i < n; i++) {
      sumRR += valid[i];
      if (i > 0) {
        const d = valid[i] - valid[i - 1];
        sumSqDiff += d * d;
      }
    }
    const meanRR = sumRR / n;
    const rmssd = n > 1 ? Math.sqrt(sumSqDiff / (n - 1)) : 0;
    let sqSum = 0;
    for (let i = 0; i < n; i++) sqSum += (valid[i] - meanRR) ** 2;
    const std = Math.sqrt(sqSum / n);
    const cv = meanRR > 0 ? std / meanRR : 0;

    // --- 2. pNN50, pNN31, pNN3.25% ---
    let c50 = 0, c31 = 0, c325 = 0;
    for (let i = 1; i < n; i++) {
      const absd = Math.abs(valid[i] - valid[i - 1]);
      if (absd > 50) c50++;
      if (absd > 31) c31++;
      if (absd > valid[i - 1] * 0.0325) c325++;
    }
    const denom = n - 1;
    const pnn50 = denom > 0 ? c50 / denom : 0;
    const pnn31 = denom > 0 ? c31 / denom : 0;
    const pnn325 = denom > 0 ? c325 / denom : 0;

    // --- 3. Turning Points Ratio (TPR) ---
    // Counts peaks & troughs; random series → ~2/3
    let turningPoints = 0;
    for (let i = 1; i < n - 1; i++) {
      if ((valid[i] > valid[i - 1] && valid[i] > valid[i + 1]) ||
          (valid[i] < valid[i - 1] && valid[i] < valid[i + 1])) {
        turningPoints++;
      }
    }
    const tpr = n > 2 ? turningPoints / (n - 2) : 0;

    // --- 4. Shannon Entropy (histogram 25 ms bins) ---
    const bins: Record<number, number> = {};
    for (const r of valid) {
      const k = Math.floor(r / 25);
      bins[k] = (bins[k] ?? 0) + 1;
    }
    let shannon = 0;
    for (const c of Object.values(bins)) {
      const p = c / n;
      shannon -= p * Math.log2(p);
    }

    // --- 5. Sample Entropy (m=2, r=0.2*σ) ---
    const sampleEntropy = n >= 6 ? this.computeSampleEntropy(valid, 2, std * 0.2) : 0;

    // --- 6. Outlier count ---
    const outlierCount = valid.filter(r => Math.abs(r - median) / Math.max(1, median) > this.A.OUTLIER_RATIO).length;

    // --- 7. Abrupt diff count ---
    let abruptDiffCount = 0;
    for (let i = 1; i < n; i++) {
      const d = Math.abs(valid[i] - valid[i - 1]);
      if (d > Math.max(100, median * this.A.ABRUPT_RR_FRAC)) {
        abruptDiffCount++;
      }
    }

    // --- 8. RR variation (last vs median) ---
    const rrVariation = Math.abs(valid[n - 1] - median) / Math.max(1, median);

    this.metrics = {
      rmssd, cv, pnn50, pnn31, pnn325, tpr,
      shannonEntropy: shannon,
      sampleEntropy,
      rrVariation,
      outlierCount,
      abruptDiffCount,
    };

    // ── Weighted scoring ──
    this.lastScore = this.computeScore();
    const newDetected = this.lastScore >= this.A.DETECTION_THRESHOLD;

    if (newDetected !== this.arrhythmiaDetected) {
      if (this.onArrhythmiaDetection) {
        this.onArrhythmiaDetection(newDetected);
        log.info(`Estado → ${newDetected ? 'ARRITMIA' : 'NORMAL'} score=${this.lastScore.toFixed(3)}`);
      }
    }

    if (newDetected && now - this.lastArrhythmiaTime >= this.MIN_EVENT_INTERVAL_MS) {
      this.arrhythmiaCount++;
      this.lastArrhythmiaTime = now;
      log.warn(
        `#${this.arrhythmiaCount} score=${this.lastScore.toFixed(3)} ` +
        `rmssd=${rmssd.toFixed(1)} cv=${cv.toFixed(3)} ` +
        `pnn50=${pnn50.toFixed(2)} pnn31=${pnn31.toFixed(2)} pnn325=${pnn325.toFixed(2)} ` +
        `tpr=${tpr.toFixed(3)} shannon=${shannon.toFixed(2)} sampEn=${sampleEntropy.toFixed(3)} ` +
        `outlier=${outlierCount} abrupt=${abruptDiffCount} rrv=${rrVariation.toFixed(3)}`
      );
    }

    this.arrhythmiaDetected = newDetected;
  }

  /**
   * Weighted arrhythmia score in [0, 1].
   * Each feature contributes a sub-score 0-1 multiplied by its weight.
   */
  private computeScore(): number {
    const A = this.A;
    const m = this.metrics;

    // Sub-scores are clamped to [0, 1] via piecewise linear functions:
    //   score = clamp((value - lo) / (hi - lo), 0, 1)
    // where lo = "normal" cutoff and hi = "strong AF" cutoff.

    const safeRange = (val: number, lo: number, hi: number): number =>
      clamp01((val - lo) / (hi > lo ? hi - lo : 1));

    const sRHRMSSD = safeRange(m.rmssd, A.RMSSD_LO, A.RMSSD_HI);
    const sCV      = safeRange(m.cv, A.CV_LO, A.CV_HI);
    const spNN31   = safeRange(m.pnn31, A.PNN31_LO, A.PNN31_HI);
    const spNN325  = safeRange(m.pnn325, A.PNN325_LO, A.PNN325_HI);
    const spNN50   = safeRange(m.pnn50, A.PNN50_LO, A.PNN50_HI);
    const sTPR     = 1 - Math.abs(m.tpr - A.TPR_TARGET) / A.TPR_TARGET;
    const sShannon = safeRange(m.shannonEntropy, A.SHANNON_LO, A.SHANNON_HI);
    const sSampEn  = safeRange(m.sampleEntropy, A.SAMPEN_LO, A.SAMPEN_HI);
    const sOutlier = safeRange(m.outlierCount, A.OUTLIER_LO, A.OUTLIER_HI);
    const sAbrupt  = safeRange(m.abruptDiffCount, A.ABRUPT_LO, A.ABRUPT_HI);
    const sRRVar   = safeRange(m.rrVariation, A.RRVAR_LO, A.RRVAR_HI);

    const totalWeight = A.W_RMSSD + A.W_CV + A.W_PNN31 + A.W_PNN325 + A.W_PNN50 +
                        A.W_TPR + A.W_SHANNON + A.W_SAMPEN + A.W_OUTLIER + A.W_ABRUPT + A.W_RRVAR;

    const weightedSum =
      sRHRMSSD * A.W_RMSSD +
      sCV      * A.W_CV +
      spNN31   * A.W_PNN31 +
      spNN325  * A.W_PNN325 +
      spNN50   * A.W_PNN50 +
      sTPR     * A.W_TPR +
      sShannon * A.W_SHANNON +
      sSampEn  * A.W_SAMPEN +
      sOutlier * A.W_OUTLIER +
      sAbrupt  * A.W_ABRUPT +
      sRRVar   * A.W_RRVAR;

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Convert score to a 4-level confidence string.
   */
  private computeConfidence(): ArrhythmiaConfidence {
    const s = this.lastScore;
    if (this.isLearningPhase) return 'none';
    if (s >= this.A.SEVERE_THRESHOLD) return 'severe';
    if (s >= this.A.MODERATE_THRESHOLD) return 'moderate';
    if (s >= this.A.MILD_THRESHOLD) return 'mild';
    return 'none';
  }

  // ──────────────────────────────────────────────
  // Sample Entropy (m=2, r = 0.2×SD)
  // ──────────────────────────────────────────────

  /**
   * Proper Sample Entropy via template matching (Richman & Moorman 2000).
   * Counts模板 matches of length m and m+1 within tolerance r.
   */
  private computeSampleEntropy(data: number[], m: number, r: number): number {
    const N = data.length;
    if (N < m + 2) return 0;

    function countMatches(template: number[], offset: number): number {
      let count = 0;
      for (let i = offset; i <= N - template.length; i++) {
        let match = true;
        for (let j = 0; j < template.length; j++) {
          if (Math.abs(data[i + j] - template[j]) > r) {
            match = false;
            break;
          }
        }
        if (match) count++;
      }
      return count;
    }

    let A = 0; // matches of length m+1
    let B = 0; // matches of length m

    for (let i = 0; i < N - m; i++) {
      const templateM = data.slice(i, i + m);
      B += countMatches(templateM, i + 1);
      const templateM1 = data.slice(i, i + m + 1);
      A += countMatches(templateM1, i + 1);
    }

    if (B === 0) return 0;
    return -Math.log(A / B);
  }

  // ──────────────────────────────────────────────
  // Public helpers
  // ──────────────────────────────────────────────

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
    if (this.onArrhythmiaDetection) this.onArrhythmiaDetection(false);
  }

  private emptyMetrics(): ArrhythmiaMetrics {
    return {
      rmssd: 0, cv: 0, pnn50: 0, pnn31: 0, pnn325: 0, tpr: 0,
      shannonEntropy: 0, sampleEntropy: 0,
      rrVariation: 0, outlierCount: 0, abruptDiffCount: 0,
    };
  }
}

/** Clamp a number to [0, 1]. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
