import { clamp } from '@/utils/math';
import { median } from '@/utils/stats';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

export interface OscillometricSample {
  dcBaseline: number;
  pulseAmplitude: number;
}

export interface OscillogramFeatures {
  peakIndex: number;
  peakAmplitude: number;
  fwhm: number;
  skewness: number;
  risingEdgeSlope: number;
  fallingEdgeSlope: number;
}

export interface OscillometricBpResult {
  systolic: number;
  diastolic: number;
  map: number;
  pulsePressure: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  amplitudeRatio: number;
  oscillogramQuality: number;
}

const BP = VITAL_THRESHOLDS.BP;
const RAMP_MIN_SAMPLES = 60;
const RAMP_MAX_SAMPLES = 600;

function smooth(values: number[], window: number): number[] {
  const half = Math.max(1, Math.floor(window / 2));
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let sum = 0; let count = 0;
    const start = Math.max(0, i - half);
    const end = Math.min(values.length - 1, i + half);
    for (let j = start; j <= end; j++) {
      sum += values[j]; count++;
    }
    result.push(count > 0 ? sum / count : values[i]);
  }
  return result;
}

function computeSkewness(values: number[], peakIdx: number): number {
  if (values.length < 3 || peakIdx <= 0 || peakIdx >= values.length - 1) return 0;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m3 = 0;
  for (const v of values) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
  }
  const variance = m2 / n;
  if (variance <= 0) return 0;
  const std = Math.sqrt(variance);
  return (m3 / n) / (std * std * std);
}

function findPeakRegion(values: number[]): OscillogramFeatures {
  let peakIdx = 0;
  let peakAmp = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > peakAmp) {
      peakAmp = values[i];
      peakIdx = i;
    }
  }

  const halfMax = peakAmp / 2;
  let leftEdge = 0;
  let rightEdge = values.length - 1;
  for (let i = peakIdx; i >= 0; i--) {
    if (values[i] <= halfMax) { leftEdge = i; break; }
  }
  for (let i = peakIdx; i < values.length; i++) {
    if (values[i] <= halfMax) { rightEdge = i; break; }
  }

  const fwhm = Math.max(1, rightEdge - leftEdge);
  const skew = computeSkewness(values, peakIdx);

  const risingSlope = peakIdx > 0 ? (peakAmp - values[0]) / peakIdx : 0;
  const fallingSlope = peakIdx < values.length - 1
    ? (peakAmp - values[values.length - 1]) / (values.length - 1 - peakIdx)
    : 0;

  return { peakIndex: peakIdx, peakAmplitude: peakAmp, fwhm, skewness: skew, risingEdgeSlope: risingSlope, fallingEdgeSlope: fallingSlope };
}

export function analyzeOscillogram(samples: OscillometricSample[]): OscillometricBpResult {
  if (samples.length < RAMP_MIN_SAMPLES) {
    return { systolic: 0, diastolic: 0, map: 0, pulsePressure: 0, confidence: 'INSUFFICIENT', amplitudeRatio: 0, oscillogramQuality: 0 };
  }

  const useSamples = samples.slice(-RAMP_MAX_SAMPLES);
  const amps = smooth(useSamples.map(s => s.pulseAmplitude), 5);

  const peakRegion = findPeakRegion(amps);
  if (peakRegion.peakAmplitude <= 0) {
    return { systolic: 0, diastolic: 0, map: 0, pulsePressure: 0, confidence: 'INSUFFICIENT', amplitudeRatio: 0, oscillogramQuality: 0 };
  }

  // Normalize oscillogram position (0-1) as proxy for relative pressure
  const peakPos = peakRegion.peakIndex / Math.max(1, amps.length - 1);

  // MAP from peak position within physiological range
  const map = BP.MAP_MIN + peakPos * (BP.MAP_MAX - BP.MAP_MIN);

  // Pulse Pressure from oscillogram width and skewness
  // Wider oscillogram + more negative skew = higher PP
  const fwhmNorm = clamp(peakRegion.fwhm / Math.max(1, amps.length), 0, 1);
  const skewFactor = clamp(1 + peakRegion.skewness * 0.15, 0.5, 1.5);
  const slopeRatio = peakRegion.risingEdgeSlope > 0
    ? clamp(peakRegion.fallingEdgeSlope / peakRegion.risingEdgeSlope, 0.2, 5)
    : 1;
  const ppRaw = BP.PP_MIN + fwhmNorm * (BP.PP_MAX - BP.PP_MIN) * skewFactor * slopeRatio;
  const pulsePressure = clamp(ppRaw, BP.PP_MIN, BP.PP_MAX);

  const sbp = clamp(map + (2 / 3) * pulsePressure, BP.SYSTOLIC_MIN, BP.SYSTOLIC_MAX);
  const dbp = clamp(map - (1 / 3) * pulsePressure, BP.DIASTOLIC_MIN, BP.DIASTOLIC_MAX);

  const ampRatio = samples.length > 0
    ? peakRegion.peakAmplitude / (median(samples.slice(0, Math.min(10, samples.length)).map(s => s.pulseAmplitude)) || 1)
    : 0;

  // Quality: strong oscillogram has clear peak, good amplitude ratio, reasonable width
  let quality = 0;
  if (ampRatio > 1.5) quality += 20;
  if (ampRatio > 2.5) quality += 15;
  if (ampRatio > 4) quality += 10;
  if (peakRegion.fwhm > 3 && peakRegion.fwhm < amps.length * 0.7) quality += 20;
  if (peakRegion.peakIndex > 0.1 * amps.length && peakRegion.peakIndex < 0.9 * amps.length) quality += 15;
  if (samples.length >= RAMP_MIN_SAMPLES * 1.5) quality += 10;
  if (slopeRatio > 0.4 && slopeRatio < 2.5) quality += 10;
  quality = Math.min(100, quality);

  let confidence: OscillometricBpResult['confidence'] = 'LOW';
  if (quality >= 65) confidence = 'HIGH';
  else if (quality >= 40) confidence = 'MEDIUM';

  return {
    systolic: Math.round(sbp),
    diastolic: Math.round(dbp),
    map: Math.round(map),
    pulsePressure: Math.round(pulsePressure),
    confidence,
    amplitudeRatio: Math.round(ampRatio * 10) / 10,
    oscillogramQuality: quality,
  };
}

export function detectPressureRamp(dcBaselines: number[]): boolean {
  if (dcBaselines.length < 30) return false;
  const firstThird = dcBaselines.slice(0, Math.floor(dcBaselines.length / 3));
  const lastThird = dcBaselines.slice(-Math.floor(dcBaselines.length / 3));
  if (firstThird.length < 3 || lastThird.length < 3) return false;

  const firstMean = firstThird.reduce((a, b) => a + b, 0) / firstThird.length;
  const lastMean = lastThird.reduce((a, b) => a + b, 0) / lastThird.length;

  return (lastMean - firstMean) > Math.abs(firstMean) * 0.08;
}
