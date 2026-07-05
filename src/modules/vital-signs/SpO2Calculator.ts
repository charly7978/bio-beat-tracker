import { createLogger } from '../../utils/logger';
import { clamp } from '../../utils/math';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { CalibrationManager } from './CalibrationManager';
import { fastICA } from '../../utils/ica';

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
 * Inversa de la función de transferencia de la cámara (tone mapping).
 * Utiliza un modelo sigmoide típico de cámara (d=2.2, theta=0.5) para linealizar la componente DC.
 */
function cameraLinearize(c: number): number {
  const y = clamp(c / 255, 0.001, 0.999);
  const theta = 0.5;
  const d = 2.2;
  return theta * Math.pow(y / (1 - y), 1 / d) * 255;
}

/**
 * Linealiza la componente AC utilizando la derivada local de la inversa del tone mapping.
 */
function cameraLinearizeAC(ac: number, dc: number): number {
  const y = clamp(dc / 255, 0.001, 0.999);
  const theta = 0.5;
  const d = 2.2;
  const term = y / (1 - y);
  const slope = (theta / d) * Math.pow(term, (1 / d) - 1) * (1 / Math.pow(1 - y, 2));
  return ac * slope;
}

/**
 * Calcula la autocorrelación de una señal a un lag específico.
 */
function computeAutocorrelation(sig: number[], lag: number): number {
  const N = sig.length;
  if (N <= lag) return 0;
  let sum = 0;
  for (let i = 0; i < N - lag; i++) {
    sum += sig[i] * sig[i + lag];
  }
  return sum / (N - lag);
}

/**
 * Calculadora de SpO2 con ratio-of-ratios (Beer-Lambert) corregido por gamma y BSS.
 */
export class SpO2Calculator {
  private rValueHistory: number[] = [];
  private readonly R_HISTORY_SAMPLES = VITAL_THRESHOLDS.SPO2.R_HISTORY_SAMPLES;

  // Historiales deslizantes para BSS (ICA) y SNR
  private redAcHistory: number[] = [];
  private greenAcHistory: number[] = [];
  private blueAcHistory: number[] = [];
  private readonly ICA_WINDOW_SIZE = 64;

  /** Calcula SpO2 a partir de los canales RGB. Retorna 0 si no hay señal válida. */
  calculate(raw: RGBData, frameCount: number): number {
    const spoCfg = VITAL_THRESHOLDS.SPO2;
    let { redAC, redDC, greenAC, greenDC, blueAC, blueDC } = raw;

    if (redDC < spoCfg.MIN_RED_DC || greenDC < spoCfg.MIN_GREEN_DC) return 0;

    // ── Corrección inversa del tone mapping sigmoidal ──
    const rawRedDC = redDC;
    const rawGreenDC = greenDC;

    redDC = cameraLinearize(redDC);
    greenDC = cameraLinearize(greenDC);
    redAC = cameraLinearizeAC(redAC, rawRedDC);
    greenAC = cameraLinearizeAC(greenAC, rawGreenDC);

    if (typeof blueDC === 'number' && typeof blueAC === 'number' && blueDC > 0) {
      const rawBlueDC = blueDC;
      blueDC = cameraLinearize(blueDC);
      blueAC = cameraLinearizeAC(blueAC, rawBlueDC);
    }

    // Guardar en el historial de componentes AC para BSS (FastICA) y estimación de SNR
    this.redAcHistory.push(redAC);
    this.greenAcHistory.push(greenAC);
    this.blueAcHistory.push(blueAC ?? 0);

    if (this.redAcHistory.length > this.ICA_WINDOW_SIZE) {
      this.redAcHistory.shift();
      this.greenAcHistory.shift();
      this.blueAcHistory.shift();
    }

    // Requerimos al menos 10 muestras para estimar amplitudes AC estables por RMS
    if (this.redAcHistory.length < 10) return 0;

    // Calcular amplitudes AC efectivas mediante RMS de la ventana de componentes AC
    let sumSqRed = 0;
    let sumSqGreen = 0;
    let sumSqBlue = 0;
    const M = this.redAcHistory.length;
    for (let i = 0; i < M; i++) {
      sumSqRed += this.redAcHistory[i] * this.redAcHistory[i];
      sumSqGreen += this.greenAcHistory[i] * this.greenAcHistory[i];
      sumSqBlue += this.blueAcHistory[i] * this.blueAcHistory[i];
    }
    const rmsRed = Math.sqrt(sumSqRed / M);
    const rmsGreen = Math.sqrt(sumSqGreen / M);
    const rmsBlue = Math.sqrt(sumSqBlue / M);

    const piRed = (rmsRed / redDC) * 100;
    const piGreen = (rmsGreen / greenDC) * 100;
    const piBlue = typeof blueDC === 'number' && blueDC > 0 ? (rmsBlue / blueDC) * 100 : 0;

    if (frameCount % 10 === 0) {
      log.info(`[SpO2 Debug] ACr_rms:${rmsRed.toFixed(3)} DCr:${redDC.toFixed(0)} PIr:${piRed.toFixed(3)}% | ACg_rms:${rmsGreen.toFixed(3)} DCg:${greenDC.toFixed(0)} PIg:${piGreen.toFixed(3)}% | ACb_rms:${rmsBlue.toFixed(3)} DCb:${typeof blueDC === 'number' ? blueDC.toFixed(0) : 'N/A'} PIb:${piBlue.toFixed(3)}%`);
    }

    if (piRed < spoCfg.MIN_PI_PERCENT) return 0;

    // Valores R-value base usando las amplitudes RMS de cada canal
    const ratioRed = rmsRed / redDC;
    const ratioGreen = rmsGreen / greenDC;
    const ratioBlue = typeof blueDC === 'number' && blueDC > 0 ? rmsBlue / blueDC : 0;

    if (!isFinite(ratioRed) || !isFinite(ratioGreen) || ratioRed <= 0 || ratioGreen <= 0) return 0;

    const R_rg = ratioRed / ratioGreen;
    const R_bg = ratioGreen > 0 ? ratioBlue / ratioGreen : 0;
    const R_rb = ratioBlue > 0 ? ratioRed / ratioBlue : 0;

    let usedR_rg = R_rg;
    let usedR_bg = R_bg;
    let usedR_rb = R_rb;

    let snrRed = 0;
    let snrGreen = 0;
    let snrBlue = 0;

    // Si tenemos suficientes muestras, corremos FastICA y estimamos SNR
    if (this.redAcHistory.length >= this.ICA_WINDOW_SIZE) {
      const icaResult = fastICA([this.redAcHistory, this.greenAcHistory, this.blueAcHistory]);
      if (icaResult) {
        const { A, S } = icaResult;

        // Buscamos el pitch period de la frecuencia cardíaca mediante autocorrelación en el canal verde (el más pulsátil)
        let detectedLag = 20; // fallback ≈ 90 BPM a 30fps
        let maxAutoCorr = -1;
        for (let lag = 10; lag <= 40; lag++) {
          const acVal = computeAutocorrelation(this.greenAcHistory, lag);
          if (acVal > maxAutoCorr) {
            maxAutoCorr = acVal;
            detectedLag = lag;
          }
        }

        // Puntuamos componentes de FastICA para hallar el componente de pulso cardiaco
        let bestComp = 0;
        let bestScore = -1;
        for (let i = 0; i < 3; i++) {
          const src = S[i];
          const r0 = computeAutocorrelation(src, 0);
          const rLag = computeAutocorrelation(src, detectedLag);
          const periodicity = r0 > 1e-10 ? Math.max(0, rLag / r0) : 0;

          // Correlación absoluta con canal verde de referencia
          let dot = 0;
          let normSrc = 0;
          let normGreen = 0;
          for (let k = 0; k < src.length; k++) {
            dot += src[k] * this.greenAcHistory[k];
            normSrc += src[k] * src[k];
            normGreen += this.greenAcHistory[k] * this.greenAcHistory[k];
          }
          const corr = normSrc > 0 && normGreen > 0 ? Math.abs(dot) / Math.sqrt(normSrc * normGreen) : 0;
          const score = periodicity * corr;

          if (score > bestScore) {
            bestScore = score;
            bestComp = i;
          }
        }

        // Obtener coeficientes de mezcla del componente de pulso
        const aR = A[0][bestComp];
        const aG = A[1][bestComp];
        const aB = A[2][bestComp];

        if (Math.abs(aG) > 1e-5 && Math.abs(aB) > 1e-5) {
          // Coeficientes ICA escalados por las componentes DC para obtener razones de oximetría correctas
          const bDC = typeof blueDC === 'number' && blueDC > 0 ? blueDC : 1;
          const icaR_rg = (Math.abs(aR) / Math.abs(aG)) * (greenDC / redDC);
          const icaR_bg = (Math.abs(aB) / Math.abs(aG)) * (greenDC / bDC);
          const icaR_rb = (Math.abs(aR) / Math.abs(aB)) * (bDC / redDC);

          if (icaR_rg >= spoCfg.R_VALUE_MIN && icaR_rg <= spoCfg.R_VALUE_MAX) {
            usedR_rg = icaR_rg;
          }
          if (icaR_bg >= spoCfg.R_VALUE_MIN && icaR_bg <= spoCfg.R_VALUE_MAX) {
            usedR_bg = icaR_bg;
          }
          if (icaR_rb >= spoCfg.R_VALUE_MIN && icaR_rb <= spoCfg.R_VALUE_MAX) {
            usedR_rb = icaR_rb;
          }
        }

        // Calcular SNR para cada canal usando el lag cardíaco detectado
        const r0Red = computeAutocorrelation(this.redAcHistory, 0);
        const rLagRed = computeAutocorrelation(this.redAcHistory, detectedLag);
        snrRed = r0Red > 1e-10 ? Math.max(0, rLagRed / (r0Red - Math.abs(rLagRed) + 1e-6)) : 0;

        const r0Green = computeAutocorrelation(this.greenAcHistory, 0);
        const rLagGreen = computeAutocorrelation(this.greenAcHistory, detectedLag);
        snrGreen = r0Green > 1e-10 ? Math.max(0, rLagGreen / (r0Green - Math.abs(rLagGreen) + 1e-6)) : 0;

        const r0Blue = computeAutocorrelation(this.blueAcHistory, 0);
        const rLagBlue = computeAutocorrelation(this.blueAcHistory, detectedLag);
        snrBlue = r0Blue > 1e-10 ? Math.max(0, rLagBlue / (r0Blue - Math.abs(rLagBlue) + 1e-6)) : 0;
      }
    }

    // ── Channel SNR Weighting (Task 3) ──
    let w_rg = 1.0;
    let w_bg = 0.0;
    let w_rb = 0.0;

    if (this.redAcHistory.length >= this.ICA_WINDOW_SIZE && (snrRed > 0 || snrGreen > 0 || snrBlue > 0)) {
      const W_rg = snrRed * snrGreen;
      const W_bg = snrBlue * snrGreen;
      const W_rb = snrRed * snrBlue;
      const sumW = W_rg + W_bg + W_rb;
      if (sumW > 1e-6) {
        w_rg = W_rg / sumW;
        w_bg = W_bg / sumW;
        w_rb = W_rb / sumW;
      }
    } else {
      // Fallback a ponderación por PI durante el calentamiento de la ventana
      const W_rg = piRed * piGreen;
      const W_bg = piBlue * piGreen;
      const W_rb = piRed * piBlue;
      const sumW = W_rg + W_bg + W_rb;
      if (sumW > 1e-6) {
        w_rg = W_rg / sumW;
        w_bg = W_bg / sumW;
        w_rb = W_rb / sumW;
      }
    }

    // Fusión multi-canal
    let currentR = usedR_rg * w_rg + usedR_bg * w_bg + usedR_rb * w_rb;
    if (!isFinite(currentR) || currentR <= 0) {
      currentR = R_rg; // Fallback final de seguridad
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

    // Modelo adaptativo: el término lineal y cuadrático se ajusta por la calidad de señal (PI promedio)
    const avgPI = (piRed + piGreen + piBlue) / 3;
    const piFactor = clamp(avgPI / 0.5, 0.7, 1.3);

    // ── Modelo Cuadrático de SpO2 Mejorado (Task 4) ──
    const A = spoCfg.R_MODEL_A ?? -3.5;
    const B = spoCfg.R_MODEL_B ?? -7.5;
    const C = spoCfg.R_MODEL_C ?? 104;

    const adjB = B / piFactor;
    const adjA = A / piFactor;

    let spo2 = Math.min(
      spoCfg.DISPLAY_CAP,
      Math.max(
        spoCfg.MIN_VALID,
        C + adjB * medianR + adjA * medianR * medianR,
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
    this.redAcHistory = [];
    this.greenAcHistory = [];
    this.blueAcHistory = [];
  }
}
