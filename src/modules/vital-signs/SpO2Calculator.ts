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
 * Inversa de la función de transferencia sRGB (tone mapping que aplican las
 * cámaras). Sin esta corrección, los ratios AC/DC están distorsionados por la
 * no-linealidad del espacio de color, lo que sesga la RoR y el SpO2
 * resultante (Frontiers in Digital Health 2023, PMC10705321).
 */
function inverseSRGB(c: number): number {
  const n = clamp(c / 255, 0, 1);
  if (n <= 0.04045) return ((n / 12.92) * 255);
  return (Math.pow((n + 0.055) / 1.055, 2.4)) * 255;
}

/**
 * Derivada de inverseSRGB en el punto c — factor de corrección para la
 * componente AC (la pendiente local del mapeo de tono).
 */
function invGammaSlope(c: number): number {
  const n = clamp(c / 255, 0, 1);
  if (n <= 0.04045) return 1 / 12.92;
  return 2.4 * Math.pow((n + 0.055) / 1.055, 1.4) / 1.055;
}

/**
 * Calculadora de SpO2 con ratio-of-ratios (Beer-Lambert) corregido por gamma.
 *
 * Mejoras sobre la versión clásica:
 * 1. Corrección inversa del tone mapping sRGB (linealiza DC/AC).
 * 2. Multi-channel RoR: combina R/G, G/B y R/B ponderados por PI de cada canal.
 * 3. Modelo adaptativo: el slope se ajusta según la calidad de señal (PI).
 */
export class SpO2Calculator {
  private rValueHistory: number[] = [];
  private readonly R_HISTORY_SAMPLES = VITAL_THRESHOLDS.SPO2.R_HISTORY_SAMPLES;

  /** Calcula SpO2 a partir de los canales RGB. Retorna 0 si no hay señal válida. */
  calculate(raw: RGBData, frameCount: number): number {
    const spoCfg = VITAL_THRESHOLDS.SPO2;
    let { redAC, redDC, greenAC, greenDC, blueAC, blueDC } = raw;

    if (redDC < spoCfg.MIN_RED_DC || greenDC < spoCfg.MIN_GREEN_DC) return 0;

    // ── Corrección inversa del tone mapping sRGB ──
    // La cámara aplica una función no lineal (sRGB gamma) que distorsiona AC/DC.
    // Linealizamos DC con la inversa exacta y AC con la derivada local.
    redDC = inverseSRGB(redDC);
    greenDC = inverseSRGB(greenDC);
    const slopeR = invGammaSlope(redDC);
    const slopeG = invGammaSlope(greenDC);
    redAC *= slopeR;
    greenAC *= slopeG;
    if (typeof blueDC === 'number' && typeof blueAC === 'number' && blueDC > 0) {
      blueDC = inverseSRGB(blueDC);
      blueAC *= invGammaSlope(blueDC);
    }

    const piRed = (redAC / redDC) * 100;
    const piGreen = (greenAC / greenDC) * 100;
    const piBlue = typeof blueAC === 'number' && typeof blueDC === 'number' && blueDC > 0 ? (blueAC / blueDC) * 100 : 0;

    if (frameCount % 10 === 0) {
      log.info(`[SpO2 Debug] ACr:${redAC.toFixed(3)} DCr:${redDC.toFixed(0)} PIr:${piRed.toFixed(3)}% | ACg:${greenAC.toFixed(3)} DCg:${greenDC.toFixed(0)} PIg:${piGreen.toFixed(3)}% | ACb:${blueAC?.toFixed(3)} DCb:${blueDC?.toFixed(0)} PIb:${piBlue.toFixed(3)}%`);
    }

    if (piRed < spoCfg.MIN_PI_PERCENT) return 0;

    const ratioRed = redAC / redDC;
    const ratioGreen = greenAC / greenDC;
    if (!isFinite(ratioRed) || !isFinite(ratioGreen) || ratioRed <= 0 || ratioGreen <= 0) return 0;

    // ── Multi-Channel RoR ──
    // Combina R/G, G/B y R/B ponderados por la PI de cada canal.
    // La PI refleja la SNR del canal: más pulso → más peso en el ratio.
    const R_rg = ratioRed / ratioGreen;
    let currentR = R_rg;
    if (typeof blueAC === 'number' && typeof blueDC === 'number' && blueDC > 0 && blueAC > 0 && piBlue > 0) {
      const ratioBlue = blueAC / blueDC;
      const R_bg = ratioBlue / ratioGreen;
      const R_rb = ratioRed / ratioBlue;
      const wG = clamp(piGreen / (piRed + piGreen + piBlue), 0.3, 0.7);
      const wB = clamp(piBlue / (piRed + piGreen + piBlue), 0, 0.35);
      // R/G primario + G/B secundario (información de melanina) + R/B terciario
      currentR = R_rg * wG + R_bg * (1 - wG - wB) * 0.5 + R_rb * wB * 0.3;
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

    // Modelo adaptativo: el slope se ajusta por la calidad (PI promedio)
    // A mayor PI → más confianza en el ratio → slope nominal.
    // A menor PI → slope reducido (contracción hacia el intercept, más conservador).
    const avgPI = (piRed + piGreen + piBlue) / 3;
    const piFactor = clamp(avgPI / 0.5, 0.7, 1.3);
    const slope = spoCfg.R_MODEL_SLOPE / piFactor;

    let spo2 = Math.min(
      spoCfg.DISPLAY_CAP,
      Math.max(
        spoCfg.MIN_VALID,
        spoCfg.R_MODEL_INTERCEPT - slope * medianR,
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
