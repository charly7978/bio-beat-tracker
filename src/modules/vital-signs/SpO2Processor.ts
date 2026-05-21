import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { CalibrationManager } from './CalibrationManager';

export interface SpO2Estimate {
  spo2: number;
  rValue: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  samplesUsed: number;
  pi: number;
}

const BUFFER_MAX = 18;
const EMIT_EVERY_N_FRAMES = 8;
const STALE_FRAMES_MAX = 15;
const EMA_ALPHA = 0.25;
const VARIANCE_WINDOW = 5;
const STALE_VARIANCE_THRESHOLD = 0.3;

export class SpO2Processor {
  private rBuffer: number[] = [];
  private framesSinceLastEmit = 0;
  private lastSpO2 = 0;
  private lastRValue = 0;
  private lastConfidence: SpO2Estimate['confidence'] = 'INSUFFICIENT';
  private staleFrames = 0;
  private estimateHistory: number[] = [];
  private intercept: number;
  private slope: number;

  constructor() {
    const cfg = VITAL_THRESHOLDS.SPO2;
    this.intercept = cfg.R_MODEL_INTERCEPT;
    this.slope = cfg.R_MODEL_SLOPE;
  }

  update(
    redAC: number,
    redDC: number,
    greenAC: number,
    greenDC: number,
    sqi: number = 100,
  ): SpO2Estimate {
    const insufficient: SpO2Estimate = {
      spo2: 0, rValue: 0, confidence: 'INSUFFICIENT', samplesUsed: 0, pi: 0,
    };

    const cfg = VITAL_THRESHOLDS.SPO2;

    if (sqi < 5) return this.staleOrInsufficient(insufficient);
    if (redDC < cfg.MIN_RED_DC || greenDC < cfg.MIN_GREEN_DC) return this.staleOrInsufficient(insufficient);

    const piRed = (redAC / redDC) * 100;
    const piGreen = (greenAC / greenDC) * 100;
    if (piRed < cfg.MIN_PI_PERCENT || piGreen < cfg.MIN_PI_PERCENT) return this.staleOrInsufficient(insufficient);

    const ratioRed = redAC / redDC;
    const ratioGreen = greenAC / greenDC;
    if (!isFinite(ratioRed) || !isFinite(ratioGreen) || ratioRed <= 0 || ratioGreen <= 0) {
      return this.staleOrInsufficient(insufficient);
    }

    const currentR = ratioRed / ratioGreen;
    if (currentR < cfg.R_VALUE_MIN || currentR > cfg.R_VALUE_MAX) return this.staleOrInsufficient(insufficient);

    const pi = Math.max(piRed, piGreen);

    this.rBuffer.push(currentR);
    if (this.rBuffer.length > BUFFER_MAX) {
      this.rBuffer = this.rBuffer.slice(-BUFFER_MAX);
    }

    if (this.rBuffer.length < 3) return insufficient;

    const sortedR = [...this.rBuffer].sort((a, b) => a - b);
    const medianR = sortedR[Math.floor(sortedR.length / 2)] ?? 0;

    this.applyCalibration();

    const rawSpO2 = Math.min(
      cfg.DISPLAY_CAP,
      Math.max(cfg.MIN_VALID, this.intercept - this.slope * medianR),
    );

    if (!isFinite(rawSpO2) || rawSpO2 < cfg.MIN_VALID) return insufficient;

    let spo2 = rawSpO2;
    if (this.lastSpO2 > 0) {
      spo2 = this.lastSpO2 * (1 - EMA_ALPHA) + rawSpO2 * EMA_ALPHA;
    }

    let confidence: SpO2Estimate['confidence'] = 'LOW';
    const bufCount = this.rBuffer.length;
    if (bufCount >= 12 && pi > cfg.MIN_PI_PERCENT * 2) confidence = 'HIGH';
    else if (bufCount >= 6) confidence = 'MEDIUM';

    if (spo2 < 70 || spo2 > 100) return insufficient;

    this.lastSpO2 = spo2;
    this.lastRValue = medianR;
    this.lastConfidence = confidence;
    this.staleFrames = 0;

    this.estimateHistory.push(spo2);
    if (this.estimateHistory.length > VARIANCE_WINDOW) {
      this.estimateHistory.shift();
    }

    if (this.isEstimateStale(confidence)) {
      confidence = 'LOW';
    }

    this.framesSinceLastEmit++;
    if (this.framesSinceLastEmit < EMIT_EVERY_N_FRAMES) {
      return this.buildThrottledEmit(confidence, pi);
    }
    this.framesSinceLastEmit = 0;

    return {
      spo2: Math.round(spo2),
      rValue: medianR,
      confidence,
      samplesUsed: this.rBuffer.length,
      pi,
    };
  }

  private applyCalibration(): void {
    const cal = CalibrationManager.getInstance();
    const info = cal.getCalibrationInfo('SPO2');
    if (info.available && !info.expired) {
      const profile = cal.getActiveProfile('SPO2');
      if (profile) {
        this.intercept = profile.coefficients.intercept ?? VITAL_THRESHOLDS.SPO2.R_MODEL_INTERCEPT;
        this.slope = profile.coefficients.slope ?? VITAL_THRESHOLDS.SPO2.R_MODEL_SLOPE;
        return;
      }
    }
    this.intercept = VITAL_THRESHOLDS.SPO2.R_MODEL_INTERCEPT;
    this.slope = VITAL_THRESHOLDS.SPO2.R_MODEL_SLOPE;
  }

  private isEstimateStale(confidence: SpO2Estimate['confidence']): boolean {
    if (this.estimateHistory.length < VARIANCE_WINDOW) return false;
    const avg = this.estimateHistory.reduce((a, b) => a + b, 0) / this.estimateHistory.length;
    const variance = Math.sqrt(
      this.estimateHistory.reduce((sum, v) => sum + (v - avg) ** 2, 0) / this.estimateHistory.length,
    );
    return variance < STALE_VARIANCE_THRESHOLD && confidence === 'LOW';
  }

  private buildThrottledEmit(confidence: SpO2Estimate['confidence'], pi: number): SpO2Estimate {
    return {
      spo2: Math.round(this.lastSpO2),
      rValue: this.lastRValue,
      confidence,
      samplesUsed: this.rBuffer.length,
      pi,
    };
  }

  private staleOrInsufficient(insufficient: SpO2Estimate): SpO2Estimate {
    this.staleFrames++;
    if (this.lastSpO2 <= 0) {
      this.framesSinceLastEmit = 0;
      return insufficient;
    }
    if (this.staleFrames >= STALE_FRAMES_MAX) {
      this.framesSinceLastEmit = 0;
      this.lastSpO2 = 0;
      this.lastRValue = 0;
      this.lastConfidence = 'INSUFFICIENT';
      return insufficient;
    }
    return {
      spo2: Math.round(this.lastSpO2),
      rValue: this.lastRValue,
      confidence: 'LOW',
      samplesUsed: this.rBuffer.length,
      pi: 0,
    };
  }

  reset(): void {
    this.rBuffer = [];
    this.framesSinceLastEmit = 0;
    this.lastSpO2 = 0;
    this.lastRValue = 0;
    this.lastConfidence = 'INSUFFICIENT';
    this.staleFrames = 0;
    this.estimateHistory = [];
    const cfg = VITAL_THRESHOLDS.SPO2;
    this.intercept = cfg.R_MODEL_INTERCEPT;
    this.slope = cfg.R_MODEL_SLOPE;
  }
}
