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
  const r = snapshot.red;
  const g = Math.max(1, snapshot.green);
  const b = Math.max(1, snapshot.blue);
  const total = r + g + b;

  if (total < 35 || r < 35) {
    return {
      brightnessScore: 0,
      coverageScore: 0,
      histogramScore: 0,
      temporalScore: 0,
      ensembleScore: 0,
    };
  }

  const rb = r / b;
  const rg = r / g;
  const blueFraction = b / total;

  // Firma de transiluminación subcutánea real:
  // Bajo torch/flash la piel transmite rojo con fuerte atenuación de azul y verde.
  // Superficies inanimadas (paredes blancas/grises, ambientes) reflejan alto componente azul.
  const hasSubcutaneousOpticalSignature = rb >= 1.35 && rg >= 1.08 && blueFraction <= 0.25;
  if (!hasSubcutaneousOpticalSignature) {
    // Escena inanimada, pared, ropa roja o luz ambiental sin contacto de tejido.
    return {
      brightnessScore: 0.1,
      coverageScore: Math.min(snapshot.coverage, 0.3),
      histogramScore: 0,
      temporalScore: 0,
      ensembleScore: 0.05,
    };
  }

  const brightnessNorm = Math.min(total / 255, 3) / 3;
  const brightScore = brightnessNorm > 0.5 ? 1.0 : brightnessNorm > 0.25 ? 0.6 : (brightnessNorm / 0.25) * 0.3;

  const covScore = snapshot.coverage > 0.7 ? 1.0 : snapshot.coverage > 0.4 ? 0.7 : (snapshot.coverage / 0.4) * 0.4;

  let histScore = 0.0;
  let tempScore = 0.1;
  if (grayPixels) {
    const h = computeHistogramStats(grayPixels);
    if (h.binsOccupied >= 15 && h.binsOccupied < 85 && h.peakHeight > 0.08) {
      histScore = 1.0;
      tempScore = temporalVariance < 0.015 ? 1.0 : temporalVariance < 0.03 ? 0.6 : 0.3;
    } else if (h.binsOccupied >= 10 && h.binsOccupied < 110) {
      histScore = 0.4;
      tempScore = temporalVariance < 0.02 ? 0.5 : 0.2;
    } else {
      histScore = 0.0;
      tempScore = 0.0;
    }
  } else {
    tempScore = temporalVariance < 0.015 ? 1.0 : temporalVariance < 0.03 ? 0.6 : 0.2;
  }

  const wBright = 0.25;
  const wCover = 0.30;
  const wHist = 0.25;
  const wTemp = 0.20;

  let ensemble = wBright * brightScore + wCover * covScore + wHist * histScore + wTemp * tempScore;

  if (rb >= 2.2 && rg >= 1.3 && blueFraction <= 0.16) {
    ensemble = Math.min(1.0, ensemble * 1.15);
  }

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
  if (total < F.ACQUIRE_SOFT_INTENSITY_MIN) return false;

  const redDominance = r - (g + b) / 2;
  const rg = r / g;
  const rb = r / b;
  const blueFraction = b / total;

  if (r < F.MIN_RED_INTENSITY) return false;
  if (rg < F.MIN_RG_RATIO) return false;
  if (rb < F.HEMOGLOBIN_MIN_RB) return false;
  if (redDominance < F.MIN_RED_DOMINANCE) return false;
  if (blueFraction > 0.25) return false;

  if (rg < 1.12 || rb < 1.35) return false;
  if (g > 110 && b > 70 && redDominance < 35) return false;
  if (total > 200 && rb < 1.38) return false;

  return (
    s.coverage >= F.MIN_COVERAGE * 0.95 &&
    s.fingerScore >= F.ACQUIRE_SOFT_FINGER_SCORE_ROI * 0.9
  );
}
