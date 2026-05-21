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

const BUFFER_MAX = 7;
const STALE_FRAMES_MAX = 3;
const EMA_ALPHA = 0.4;

export class SpO2Processor {
  private rBuffer: number[] = [];
  private lastSpO2 = 0;
  private lastRValue = 0;
  private staleFrames = 0;
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

    // Solo gates duros: DC insuficiente o R imposible
    if (redDC < cfg.MIN_RED_DC || greenDC < cfg.MIN_GREEN_DC) {
      if (this.frameCount % 30 === 0) log.warn(`[SpO2] DC bajo: redDC=${redDC.toFixed(1)} greenDC=${greenDC.toFixed(1)}`);
      return this.staleOrInsufficient(insufficient);
    }

    const ratioRed = redAC / redDC;
    const ratioGreen = greenAC / greenDC;
    if (!isFinite(ratioRed) || !isFinite(ratioGreen) || ratioRed <= 0 || ratioGreen <= 0) {
      if (this.frameCount % 30 === 0) log.warn(`[SpO2] ratio no finito: ${ratioRed} / ${ratioGreen}`);
      return this.staleOrInsufficient(insufficient);
    }

    const currentR = ratioRed / ratioGreen;

    if (currentR < cfg.R_VALUE_MIN || currentR > cfg.R_VALUE_MAX) {
      if (this.frameCount % 30 === 0) log.warn(`[SpO2] R fuera: ${currentR.toFixed(4)} [${cfg.R_VALUE_MIN},${cfg.R_VALUE_MAX}]`);
      return this.staleOrInsufficient(insufficient);
    }

    // Debug log cada 15 frames
    if (this.frameCount % 15 === 0) {
      log.info(`[SpO2] ACr=${redAC.toFixed(3)} DCr=${redDC.toFixed(0)} ACg=${greenAC.toFixed(3)} DCg=${greenDC.toFixed(0)} R=${currentR.toFixed(4)}`);
    }

    this.rBuffer.push(currentR);
    if (this.rBuffer.length > BUFFER_MAX) {
      this.rBuffer = this.rBuffer.slice(-BUFFER_MAX);
    }

    if (this.rBuffer.length < 3) return insufficient;

    const sortedR = [...this.rBuffer].sort((a, b) => a - b);
    const medianR = sortedR[Math.floor(sortedR.length / 2)] ?? 0;

    this.applyCalibration();

    const rawSpO2 = this.intercept - this.slope * medianR;
    if (!isFinite(rawSpO2)) return insufficient;

    const clampedSpO2 = Math.max(cfg.MIN_VALID, Math.min(cfg.DISPLAY_CAP, rawSpO2));

    // EMA responsivo
    let spo2 = clampedSpO2;
    if (this.lastSpO2 > 0) {
      spo2 = this.lastSpO2 * (1 - EMA_ALPHA) + clampedSpO2 * EMA_ALPHA;
    }

    spo2 = Math.max(cfg.MIN_VALID, Math.min(cfg.DISPLAY_CAP, spo2));

    // Confianza según cantidad de muestras
    let confidence: SpO2Estimate['confidence'] = 'LOW';
    if (this.rBuffer.length >= BUFFER_MAX) confidence = 'MEDIUM';
    if (this.rBuffer.length >= BUFFER_MAX && this.frameCount > 60) confidence = 'HIGH';

    this.lastSpO2 = spo2;
    this.lastRValue = medianR;
    this.staleFrames = 0;

    if (this.frameCount % 30 === 0) {
      log.info(`[SpO2] R_med=${medianR.toFixed(4)} raw=${rawSpO2.toFixed(1)}% out=${spo2.toFixed(1)}% conf=${confidence} n=${this.rBuffer.length}`);
    }

    return {
      spo2: Math.round(spo2),
      rValue: medianR,
      confidence,
      samplesUsed: this.rBuffer.length,
      pi: Math.max(ratioRed, ratioGreen) * 100,
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

  private staleOrInsufficient(insufficient: SpO2Estimate): SpO2Estimate {
    this.staleFrames++;
    if (this.lastSpO2 <= 0) return insufficient;
    if (this.staleFrames >= STALE_FRAMES_MAX) {
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
    this.lastSpO2 = 0;
    this.lastRValue = 0;
    this.staleFrames = 0;
    this.frameCount = 0;
    const cfg = VITAL_THRESHOLDS.SPO2;
    this.intercept = cfg.R_MODEL_INTERCEPT;
    this.slope = cfg.R_MODEL_SLOPE;
  }
}
