import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

export interface FingerRgbSnapshot {
  red: number;
  green: number;
  blue: number;
  coverage: number;
  fingerScore: number;
}

export interface FingerEnsembleMetrics {
  brightnessScore: number;
  coverageScore: number;
  histogramScore: number;
  temporalScore: number;
  ensembleScore: number;
}

export interface HistogramStats {
  binsOccupied: number;
  peakHeight: number;
}

let prevFrameGray: Uint8ClampedArray | null = null;
let zloR = 0;
let zloG = 0;
let zloB = 0;
let zloCalibrated = false;

export function resetZlo(): void {
  zloCalibrated = false;
}

export function calibrateZlo(r: number, g: number, b: number): void {
  zloR = r;
  zloG = g;
  zloB = b;
  zloCalibrated = true;
}

export function getZlo(): { r: number; g: number; b: number; calibrated: boolean } {
  return { r: zloR, g: zloG, b: zloB, calibrated: zloCalibrated };
}

export function computeHistogramStats(grayPixels: Uint8ClampedArray): HistogramStats {
  const hist = new Uint32Array(256);
  for (let i = 0; i < grayPixels.length; i++) {
    hist[grayPixels[i]]++;
  }
  let binsOccupied = 0;
  let peakHeight = 0;
  const total = grayPixels.length;
  for (let i = 0; i < 256; i++) {
    if (hist[i] > 0) binsOccupied++;
    const h = hist[i] / total;
    if (h > peakHeight) peakHeight = h;
  }
  return { binsOccupied, peakHeight };
}

export function computeTemporalVariance(
  currentGray: Uint8ClampedArray,
): number {
  if (!prevFrameGray || prevFrameGray.length !== currentGray.length) {
    prevFrameGray = new Uint8ClampedArray(currentGray);
    return 1;
  }
  let sumDelta = 0;
  for (let i = 0; i < currentGray.length; i++) {
    sumDelta += Math.abs(currentGray[i] - prevFrameGray[i]);
  }
  prevFrameGray = new Uint8ClampedArray(currentGray);
  const meanDelta = sumDelta / currentGray.length;
  return meanDelta / 255;
}

export function computeFingerEnsemble(
  snapshot: FingerRgbSnapshot,
  grayPixels: Uint8ClampedArray | null,
  temporalVariance: number,
): FingerEnsembleMetrics {
  const total = snapshot.red + snapshot.green + snapshot.blue;

  const brightnessNorm = Math.min(total / 255, 3) / 3;
  const brightScore = brightnessNorm > 0.5 ? 1.0 : brightnessNorm > 0.25 ? 0.5 : brightnessNorm / 0.25 * 0.3;

  const covScore = snapshot.coverage > 0.7 ? 1.0 : snapshot.coverage > 0.4 ? 0.7 : snapshot.coverage / 0.4 * 0.4;

  let histScore = 0.3;
  if (grayPixels) {
    const h = computeHistogramStats(grayPixels);
    if (h.binsOccupied < 60 && h.peakHeight > 0.12) {
      histScore = 1.0;
    } else if (h.binsOccupied < 100 && h.peakHeight > 0.08) {
      histScore = 0.6;
    }
  }

  const tempScore = temporalVariance < 0.015 ? 1.0 : temporalVariance < 0.03 ? 0.6 : temporalVariance < 0.05 ? 0.3 : 0.1;

  const wBright = 0.30;
  const wCover = 0.30;
  const wHist = 0.20;
  const wTemp = 0.20;

  const ensemble = wBright * brightScore + wCover * covScore + wHist * histScore + wTemp * tempScore;

  return {
    brightnessScore: brightScore,
    coverageScore: covScore,
    histogramScore: histScore,
    temporalScore: tempScore,
    ensembleScore: ensemble,
  };
}

export function isFingerPresentByEnsemble(metrics: FingerEnsembleMetrics): boolean {
  return metrics.ensembleScore > VITAL_THRESHOLDS.FINGER.ENSEMBLE_FINGER_THRESHOLD;
}

export function hasFingerHemoglobinSignature(s: FingerRgbSnapshot): boolean {
  const F = VITAL_THRESHOLDS.FINGER;
  const r = s.red;
  const g = Math.max(1, s.green);
  const b = Math.max(1, s.blue);
  const total = r + g + b;

  // 1. Piso de intensidad absoluta — un dedo real con flash SIEMPRE tiene brillo
  if (total < F.ACQUIRE_INTENSITY_MIN * 0.8) return false;

  const redDominance = r - (g + b) / 2;
  const rg = r / g;
  const rb = r / b;

  // 2. Firma Espectral de la Sangre (Hemoglobina)
  // El tejido humano absorbe el verde y el azul masivamente, dejando el rojo como dominante.
  // Sin dedo (apuntando al aire), el ruido del sensor suele ser grisáceo (RG/RB cerca de 1).
  if (r < F.MIN_RED_INTENSITY) return false;
  if (rg < 1.15) return false; // El rojo debe ser al menos 15% superior al verde
  if (rb < 1.35) return false; // El rojo debe ser al menos 35% superior al azul
  if (redDominance < 15) return false;

  // 3. Rechazo de ruido de sensor de alta ganancia (ISO alto apuntando a la nada)
  // En la oscuridad, el sensor sube el ISO y genera ruido "sal y pimienta" que puede
  // parecer pulso. Un dedo real es una masa homogénea de color.
  if (g > 100 && b > 90 && redDominance < 25) return false;

  // 4. Cobertura Espacial
  return (
    s.coverage >= F.MIN_COVERAGE &&
    s.fingerScore >= F.ACQUIRE_SMOOTHED_FINGER_MIN
  );
}
