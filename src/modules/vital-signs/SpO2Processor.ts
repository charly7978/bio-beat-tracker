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
  private staleFrames = 0;
  private estimateHistory: number[] = [];
  private intercept: number;
  private slope: number;
  private frameCount = 0;

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
  ): SpO2Estimate {
    this.frameCount++;
    const insufficient: SpO2Estimate = {
      spo2: 0, rValue: 0, confidence: 'INSUFFICIENT', samplesUsed: 0, pi: 0,
    };

    const cfg = VITAL_THRESHOLDS.SPO2;

    if (redDC < cfg.MIN_RED_DC || greenDC < cfg.MIN_GREEN_DC) {
      if (this.frameCount % 30 === 0) log.warn(`[SpO2] DC bajo: redDC=${redDC.toFixed(1)} greenDC=${greenDC.toFixed(1)} (min ${cfg.MIN_RED_DC}/${cfg.MIN_GREEN_DC})`);
      return this.staleOrInsufficient(insufficient);
    }

    const piRed = (redAC / redDC) * 100;
    const piGreen = (greenAC / greenDC) * 100;
    const piPct = Math.max(piRed, piGreen);

    if (piPct < 0.005) {
      if (this.frameCount % 30 === 0) log.warn(`[SpO2] PI muy bajo: piRed=${piRed.toFixed(3)}% piGreen=${piGreen.toFixed(3)}% (< 0.005%)`);
      return this.staleOrInsufficient(insufficient);
    }

    const ratioRed = redAC / redDC;
    const ratioGreen = greenAC / greenDC;
    if (!isFinite(ratioRed) || !isFinite(ratioGreen) || ratioRed <= 0 || ratioGreen <= 0) {
      if (this.frameCount % 30 === 0) log.warn(`[SpO2] ratio no finito: ratioRed=${ratioRed} ratioGreen=${ratioGreen}`);
      return this.staleOrInsufficient(insufficient);
    }

    const currentR = ratioRed / ratioGreen;

    if (currentR < cfg.R_VALUE_MIN || currentR > cfg.R_VALUE_MAX) {
      if (this.frameCount % 15 === 0) log.warn(`[SpO2] R fuera de rango [${cfg.R_VALUE_MIN},${cfg.R_VALUE_MAX}]: ${currentR.toFixed(4)} (ACr=${redAC.toFixed(2)} DCr=${redDC.toFixed(0)} ACg=${greenAC.toFixed(2)} DCg=${greenDC.toFixed(0)})`);
      return this.staleOrInsufficient(insufficient);
    }

    if (this.frameCount % 15 === 0) {
      log.info(`[SpO2] ACr=${redAC.toFixed(3)} DCr=${redDC.toFixed(0)} ACg=${greenAC.toFixed(3)} DCg=${greenDC.toFixed(0)} R=${currentR.toFixed(4)} pi=${piPct.toFixed(3)}%`);
    }

    this.rBuffer.push(currentR);
    if (this.rBuffer.length > BUFFER_MAX) {
      this.rBuffer = this.rBuffer.slice(-BUFFER_MAX);
    }

    if (this.rBuffer.length < 3) return insufficient;

    const sortedR = [...this.rBuffer].sort((a, b) => a - b);
    const medianR = sortedR[Math.floor(sortedR.length / 2)] ?? 0;

    this.applyCalibration();

    const formulaSpO2 = this.intercept - this.slope * medianR;
    if (!isFinite(formulaSpO2)) {
      if (this.frameCount % 15 === 0) log.warn(`[SpO2] formulaSpO2 no finito (R_med=${medianR.toFixed(4)})`);
      return this.staleOrInsufficient(insufficient);
    }

    const clampedSpO2 = Math.max(cfg.MIN_VALID, Math.min(cfg.DISPLAY_CAP, formulaSpO2));

    let spo2 = clampedSpO2;
    if (this.lastSpO2 > 0) {
      spo2 = this.lastSpO2 * (1 - EMA_ALPHA) + clampedSpO2 * EMA_ALPHA;
    }

    spo2 = Math.max(cfg.MIN_VALID, Math.min(cfg.DISPLAY_CAP, spo2));

    let confidence: SpO2Estimate['confidence'] = 'LOW';
    const bufCount = this.rBuffer.length;
    if (bufCount >= 12 && piPct > cfg.MIN_PI_PERCENT * 2) confidence = 'HIGH';
    else if (bufCount >= 6) confidence = 'MEDIUM';

    this.lastSpO2 = spo2;
    this.lastRValue = medianR;
    this.staleFrames = 0;

    this.estimateHistory.push(spo2);
    if (this.estimateHistory.length > VARIANCE_WINDOW) {
      this.estimateHistory.shift();
    }

    if (this.isEstimateStale(confidence)) {
      confidence = 'LOW';
    }

    if (this.frameCount % 30 === 0) {
      log.info(`[SpO2] R_med=${medianR.toFixed(4)} formula=${formulaSpO2.toFixed(1)}% clamped=${clampedSpO2.toFixed(1)}% ema=${spo2.toFixed(1)}% conf=${confidence} n=${this.rBuffer.length}`);
    }

    this.framesSinceLastEmit++;
    if (this.framesSinceLastEmit < EMIT_EVERY_N_FRAMES) {
      return this.buildThrottledEmit(confidence, piPct);
    }
    this.framesSinceLastEmit = 0;

    return {
      spo2: Math.round(Math.min(cfg.DISPLAY_CAP, Math.max(cfg.MIN_VALID, spo2))),
      rValue: medianR,
      confidence,
      samplesUsed: this.rBuffer.length,
      pi: piPct,
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

  getFrameCount(): number { return this.frameCount; }

  reset(): void {
    this.rBuffer = [];
    this.framesSinceLastEmit = 0;
    this.lastSpO2 = 0;
    this.lastRValue = 0;
    this.staleFrames = 0;
    this.estimateHistory = [];
    this.frameCount = 0;
    const cfg = VITAL_THRESHOLDS.SPO2;
    this.intercept = cfg.R_MODEL_INTERCEPT;
    this.slope = cfg.R_MODEL_SLOPE;
  }
}
