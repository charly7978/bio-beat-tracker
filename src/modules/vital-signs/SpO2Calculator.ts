import { createLogger } from '../../utils/logger';
import { clamp } from '../../utils/math';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { CalibrationManager } from './CalibrationManager';

const log = createLogger('SpO2Calculator');

export interface RGBData {
  redAC: number;
  redDC: number;
  greenAC: number;
  greenDC: number;
  blueAC?: number;
  blueDC?: number;
}

/**
 * Calculadora de SpO2 con ratio-of-ratios (Beer-Lambert).
 *
 * Extraída de VitalSignsProcessor para facilitar testeo y mantenimiento.
 * Fórmula: SpO2 = intercept - slope × R_median, con filtro de mediana sobre R.
 * Verde se usa como proxy IR por mejor SNR en yema del dedo con flash blanco.
 */
export class SpO2Calculator {
  private rValueHistory: number[] = [];
  private readonly R_HISTORY_SAMPLES = VITAL_THRESHOLDS.SPO2.R_HISTORY_SAMPLES;

  /** Calcula SpO2 a partir de los canales RGB. Retorna 0 si no hay señal válida. */
  calculate(raw: RGBData, frameCount: number): number {
    const spoCfg = VITAL_THRESHOLDS.SPO2;
    const { redAC, redDC, greenAC, greenDC, blueAC, blueDC } = raw;

    if (redDC < spoCfg.MIN_RED_DC || greenDC < spoCfg.MIN_GREEN_DC) return 0;

    const piRed = (redAC / redDC) * 100;
    const piGreen = (greenAC / greenDC) * 100;
    const piBlue = typeof blueAC === 'number' && typeof blueDC === 'number' && blueDC > 0 ? (blueAC / blueDC) * 100 : 0;

    if (frameCount % 10 === 0) {
      log.info(`[SpO2 Debug] ACr:${redAC.toFixed(3)} DCr:${redDC.toFixed(0)} PIr:${piRed.toFixed(3)}% | ACg:${greenAC.toFixed(3)} DCg:${greenDC.toFixed(0)} PIg:${piGreen.toFixed(3)}% | ACb:${blueAC?.toFixed(3)} DCb:${blueDC?.toFixed(0)} PIb:${piBlue.toFixed(3)}%`);
    }

    // Solo rojo como gate principal (mejor SNR en cámara). Verde se usa en el ratio
    // pero no bloquea — si su PI es muy bajo el R_rg se sale de rango naturalmente.
    if (piRed < spoCfg.MIN_PI_PERCENT) return 0;

    const ratioRed = redAC / redDC;
    const ratioGreen = greenAC / greenDC;
    if (!isFinite(ratioRed) || !isFinite(ratioGreen) || ratioRed <= 0 || ratioGreen <= 0) return 0;

    const R_rg = ratioRed / ratioGreen;

    // Compensación multi-wavelength por melanina usando canal azul
    let currentR = R_rg;
    if (typeof blueAC === 'number' && typeof blueDC === 'number' && blueDC > 0 && blueAC > 0) {
      const ratioBlue = blueAC / blueDC;
      const R_bg = ratioBlue / ratioGreen;
      currentR = R_rg - 0.15 * R_bg;
    }

    if (currentR < spoCfg.R_VALUE_MIN || currentR > spoCfg.R_VALUE_MAX) {
      if (frameCount % 15 === 0) log.warn(`[SpO2] R fuera de rango: ${currentR.toFixed(3)}`);
      return 0;
    }

    this.rValueHistory.push(currentR);
    if (this.rValueHistory.length > this.R_HISTORY_SAMPLES) {
      this.rValueHistory.shift();
    }

    if (this.rValueHistory.length < 3) return 0;

    const sortedR = [...this.rValueHistory].sort((a, b) => a - b);
    const medianR = sortedR[Math.floor(sortedR.length / 2)] ?? 0;

    let spo2 = Math.min(
      spoCfg.DISPLAY_CAP,
      Math.max(
        spoCfg.MIN_VALID,
        spoCfg.R_MODEL_INTERCEPT - spoCfg.R_MODEL_SLOPE * medianR,
      ),
    );

    const calib = CalibrationManager.getInstance();
    const activeSpo2Profile = calib.getActiveProfile('SPO2');
    if (spo2 > 0 && activeSpo2Profile) {
      const spo2Offset = activeSpo2Profile.coefficients.spo2Offset ?? 0;
      spo2 = clamp(spo2 + spo2Offset, spoCfg.MIN_VALID, spoCfg.DISPLAY_CAP);
    }

    if (frameCount % 30 === 0) {
      log.info(`[SpO2 Result] R_med:${medianR.toFixed(3)} -> SpO2:${spo2.toFixed(1)}% (n=${this.rValueHistory.length})`);
    }

    return Number.isFinite(spo2) ? spo2 : 0;
  }

  getRValueHistory(): number[] {
    return this.rValueHistory;
  }

  reset(): void {
    this.rValueHistory = [];
  }
}
