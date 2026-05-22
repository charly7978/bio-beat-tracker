import { createLogger } from '../../utils/logger';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { CalibrationManager } from './CalibrationManager';

const log = createLogger('SpO2Processor');

export interface SpO2Estimate {
  spo2: number;
  rValue: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  samplesUsed: number;
  pi: number;
}

interface MlrWeights {
  w0: number;
  wR: number;
  wDcRed: number;
  wDcGreen: number;
}

const DEFAULT_WEIGHTS: MlrWeights = {
  w0: 104,
  wR: -6,
  wDcRed: 0,
  wDcGreen: 0,
};

export class SpO2Processor {
  private readonly BUFFER_SIZE = 30;
  private readonly MIN_BUFFER = 8;
  private readonly WARMUP = 60;
  private readonly STALE_LIMIT = 3;
  private readonly R_CLAMP_MIN: number;
  private readonly R_CLAMP_MAX: number;
  private readonly MIN_PI: number;
  private readonly MIN_RED_DC: number;
  private readonly MIN_GREEN_DC: number;
  private readonly REJECT_THRESHOLD = 0.30;
  private readonly MAX_REJECTIONS = 5;
  private readonly DISPLAY_CAP: number;
  private readonly MIN_VALID: number;

  private rBuffer: number[] = [];
  private lastSpO2 = 0;
  private lastR = 0;
  private frameCount = 0;
  private staleFrames = 0;
  private consecutiveRejections = 0;

  // RoR / MLR model
  private weights: MlrWeights;
  // adaptive offset — se ajusta con calibrate()
  private adaptiveOffset = 0;

  constructor() {
    const cfg = VITAL_THRESHOLDS.SPO2;
    this.R_CLAMP_MIN = cfg.R_VALUE_MIN;
    this.R_CLAMP_MAX = cfg.R_VALUE_MAX;
    this.MIN_PI = cfg.MIN_PI_PERCENT / 100;
    this.MIN_RED_DC = cfg.MIN_RED_DC;
    this.MIN_GREEN_DC = cfg.MIN_GREEN_DC;
    this.DISPLAY_CAP = cfg.DISPLAY_CAP;
    this.MIN_VALID = cfg.MIN_VALID;
    this.weights = this.loadCalibrationWeights();
  }

  update(
    redAC: number,
    redDC: number,
    greenAC: number,
    greenDC: number,
  ): SpO2Estimate {
    this.frameCount++;

    const insufficient: SpO2Estimate = {
      spo2: 0, rValue: 0, confidence: 'INSUFFICIENT', samplesUsed: 0, pi: 0,
    };

    if (redDC < this.MIN_RED_DC || greenDC < this.MIN_GREEN_DC) {
      return this.staleHold(insufficient);
    }

    const piRed = redAC / redDC;
    const piGreen = greenAC / greenDC;

    if (!isFinite(piRed) || !isFinite(piGreen) || piRed <= 0 || piGreen <= 0) {
      return this.staleHold(insufficient);
    }

    if (piRed < this.MIN_PI || piGreen < this.MIN_PI) {
      return this.staleHold(insufficient);
    }

    const currentR = piRed / piGreen;

    if (currentR < this.R_CLAMP_MIN || currentR > this.R_CLAMP_MAX) {
      if (this.frameCount % 30 === 0) {
        log.warn(`[SpO2] R fuera rango: ${currentR.toFixed(4)}`);
      }
      return this.staleHold(insufficient);
    }

    // outlier rejection vs buffer median
    if (this.rBuffer.length >= 3) {
      const median = this.medianOf(this.rBuffer);
      const relDiff = Math.abs(currentR - median) / Math.max(Math.abs(median), 1e-8);
      if (relDiff > this.REJECT_THRESHOLD) {
        this.consecutiveRejections++;
        if (this.consecutiveRejections >= this.MAX_REJECTIONS) {
          this.rBuffer = [];
          this.consecutiveRejections = 0;
        }
        if (this.frameCount % 15 === 0) {
          log.warn(`[SpO2] Outlier R=${currentR.toFixed(4)} median=${median.toFixed(4)} diff=${(relDiff*100).toFixed(0)}%`);
        }
        return this.staleHold(insufficient);
      }
    }

    this.consecutiveRejections = 0;
    this.rBuffer.push(currentR);
    if (this.rBuffer.length > this.BUFFER_SIZE) {
      this.rBuffer = this.rBuffer.slice(-this.BUFFER_SIZE);
    }

    if (this.frameCount < this.WARMUP || this.rBuffer.length < this.MIN_BUFFER) {
      return insufficient;
    }

    const medianR = this.medianOf(this.rBuffer);

    // apply calibration model
    const rawSpO2 = this.predict(medianR, redDC, greenDC);
    if (!isFinite(rawSpO2)) return insufficient;

    const clamped = Math.max(this.MIN_VALID, Math.min(this.DISPLAY_CAP, rawSpO2));

    let spo2 = clamped;
    if (this.lastSpO2 > 0) {
      const alpha = 0.3;
      spo2 = this.lastSpO2 * (1 - alpha) + clamped * alpha;
    }
    spo2 = Math.max(this.MIN_VALID, Math.min(this.DISPLAY_CAP, spo2));

    let confidence: SpO2Estimate['confidence'] = 'LOW';
    if (this.rBuffer.length >= this.BUFFER_SIZE) confidence = 'MEDIUM';
    if (this.rBuffer.length >= this.BUFFER_SIZE && this.frameCount > 120) confidence = 'HIGH';

    this.lastSpO2 = spo2;
    this.lastR = medianR;
    this.staleFrames = 0;

    if (this.frameCount % 30 === 0) {
      log.info(
        `[SpO2] R=${medianR.toFixed(4)} spo2=${spo2.toFixed(1)}% conf=${confidence} ` +
        `n=${this.rBuffer.length} offset=${this.adaptiveOffset.toFixed(2)}`
      );
    }

    return {
      spo2: Math.round(spo2),
      rValue: medianR,
      confidence,
      samplesUsed: this.rBuffer.length,
      pi: Math.max(piRed, piGreen) * 100,
    };
  }

  calibrate(referenceSpO2: number, redDC = 0, greenDC = 0): void {
    if (referenceSpO2 <= 0 || !isFinite(referenceSpO2)) return;
    if (this.lastR <= 0) return;

    if (redDC > 0 && greenDC > 0 && referenceSpO2 >= this.MIN_VALID) {
      const expected = this.weights.w0 + this.weights.wR * this.lastR +
        this.weights.wDcRed * redDC + this.weights.wDcGreen * greenDC;
      this.adaptiveOffset = referenceSpO2 - expected;
      log.info(`[SpO2] MLR calibrate: reference=${referenceSpO2}% R=${this.lastR.toFixed(4)} offset=${this.adaptiveOffset.toFixed(2)}`);
      return;
    }

    const rawWithDefault = DEFAULT_WEIGHTS.w0 + DEFAULT_WEIGHTS.wR * this.lastR;
    this.adaptiveOffset = referenceSpO2 - rawWithDefault;
    log.info(`[SpO2] RoR calibrate: reference=${referenceSpO2}% R=${this.lastR.toFixed(4)} offset=${this.adaptiveOffset.toFixed(2)}`);
  }

  reset(): void {
    this.rBuffer = [];
    this.lastSpO2 = 0;
    this.lastR = 0;
    this.frameCount = 0;
    this.staleFrames = 0;
    this.consecutiveRejections = 0;
    this.adaptiveOffset = 0;
    this.weights = this.loadCalibrationWeights();
  }

  getFrameCount(): number {
    return this.frameCount;
  }

  getLastR(): number {
    return this.lastR;
  }

  getAdaptiveOffset(): number {
    return this.adaptiveOffset;
  }

  private predict(medianR: number, redDC: number, greenDC: number): number {
    const w = this.weights;
    return w.w0 + w.wR * medianR + w.wDcRed * redDC + w.wDcGreen * greenDC + this.adaptiveOffset;
  }

  private staleHold(insufficient: SpO2Estimate): SpO2Estimate {
    this.staleFrames++;
    if (this.lastSpO2 <= 0 || this.lastR <= 0) return insufficient;
    if (this.staleFrames >= this.STALE_LIMIT) {
      if (this.frameCount % 30 === 0) {
        log.warn(`[SpO2] Stale expired after ${this.staleFrames} frames`);
      }
      return insufficient;
    }
    return {
      spo2: Math.round(this.lastSpO2),
      rValue: this.lastR,
      confidence: 'LOW',
      samplesUsed: this.rBuffer.length,
      pi: 0,
    };
  }

  private loadCalibrationWeights(): MlrWeights {
    const cal = CalibrationManager.getInstance();
    const info = cal.getCalibrationInfo('SPO2');
    if (info.available && !info.expired) {
      const profile = cal.getActiveProfile('SPO2');
      if (profile) {
        const w = profile.coefficients;
        return {
          w0: w.intercept ?? DEFAULT_WEIGHTS.w0,
          wR: w.slope ?? DEFAULT_WEIGHTS.wR,
          wDcRed: w.dcRedWeight ?? 0,
          wDcGreen: w.dcGreenWeight ?? 0,
        };
      }
    }
    return { ...DEFAULT_WEIGHTS };
  }

  private medianOf(arr: number[]): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }
}
