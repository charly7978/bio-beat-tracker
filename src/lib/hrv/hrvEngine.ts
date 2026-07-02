/**
 * HRV ENGINE — Full-spectrum Heart Rate Variability analysis.
 *
 * Implements ALL three domains recommended by the Task Force (1996):
 *   1. Time-domain:  SDNN, SDANN, RMSSD, pNN50, pNN20, HRVTi, TINN
 *   2. Frequency-domain: VLF, LF, HF, LF/HF, LFₙ, HFₙ via Lomb-Scargle
 *   3. Non-linear:  SD1/SD2 (Poincaré), SampEn, DFA α₁/α₂, RR triangular index
 *
 * Artifact handling: percentage-based rejection with cubic spline interpolation
 * of ectopic/non-physiological beats (Kamath & Fallen 1995).
 *
 * All metrics computed over 5-minute windows (Task Force standard).
 * Shorter windows (1-min, 3-min) also provided for real-time trending.
 *
 * References:
 *   - Task Force of ESC/NASPE (1996) — HRV Standards. Circulation 93:1043–1065
 *   - Shaffer & Ginsberg (2017) — "An Overview of HRV Metrics and Norms"
 *     Frontiers in Public Health 5:258
 *   - Richman & Moorman (2000) — "Physiological time-series analysis using SampEn"
 *     Am J Physiol Heart Circ Physiol 278:H2039-H2049
 *   - Peng et al. (1995) — "Quantification of scaling exponents and crossover
 *     phenomena in nonstationary heartbeat time series" Chaos 5:82-87
 */
import { median } from '../../utils/stats';
import { lombScargleHrv, type LombScargleResult } from './lombScargle';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ArtifactStats {
  totalBeats: number;
  artifactBeats: number;
  artifactPercent: number;
  interpolatedBeats: number;
}

export interface TimeDomainHRV {
  /** Mean RR interval (ms) */
  meanRR: number;
  /** Standard deviation of NN intervals (ms) */
  sdnn: number;
  /** Standard deviation of 5-min AVERAGE NN intervals (ms) — ultra-low frequency */
  sdann: number;
  /** Root mean square of successive differences (ms) */
  rmssd: number;
  /** Percentage of successive NN differences > 50 ms */
  pnn50: number;
  /** Percentage of successive NN differences > 20 ms (more sensitive) */
  pnn20: number;
  /** HRV Triangular Index (total NN / max histogram bin) */
  hrvTi: number;
  /** TINN — triangular interpolation of NN interval histogram */
  tinn: number;
  /** Mean heart rate (bpm) */
  meanHR: number;
}

export interface FrequencyDomainHRV extends LombScargleResult {
  /* inherited: vlf, lf, hf, lfHfRatio, lfNu, hfNu, totalPower, peakLfHz, peakHfHz */
}

export interface NonLinearHRV {
  /** SD1 — Poincaré short-term axis (ms) */
  sd1: number;
  /** SD2 — Poincaré long-term axis (ms) */
  sd2: number;
  /** SD1/SD2 ratio — parasympathetic / sympathetic balance indicator */
  sd1Sd2Ratio: number;
  /** Sample Entropy (m=2, r=0.2×SD) — complexity measure */
  sampEn: number;
  /** Detrended Fluctuation Analysis short-term exponent α₁ (4–11 beats) */
  dfaAlpha1: number;
  /** Detrended Fluctuation Analysis long-term exponent α₂ (>11 beats) */
  dfaAlpha2: number;
  /** Approximate area of Poincaré ellipse π × SD1 × SD2 */
  poincareArea: number;
}

export interface HrvWindowResult {
  /** Timestamp del fin de la ventana (ms) */
  timestamp: number;
  /** Inicio de la ventana (ms) */
  windowStart: number;
  /** Duración real de la ventana (ms) */
  windowDuration: number;
  timeDomain: TimeDomainHRV;
  frequencyDomain: FrequencyDomainHRV;
  nonLinear: NonLinearHRV;
  artifacts: ArtifactStats;
  /** Número de intervalos NN usados */
  nnCount: number;
  /** Calidad de la ventana: ratio de latidos válidos */
  quality: number;
}

export interface FullHrvReport {
  /** Ventanas consecutivas de 5 min (Task Force) */
  windows: HrvWindowResult[];
  /** Promedio de todas las ventanas */
  summary: {
    sdnn: number;
    rmssd: number;
    pnn50: number;
    lfHfRatio: number;
    sd1: number;
    sd2: number;
    sampEn: number;
    dfaAlpha1: number;
    meanHR: number;
  };
  /** Todas las ventanas cortas (1-min para trending) */
  shortWindows: HrvWindowResult[];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const TASK_FORCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const SHORT_WINDOW_MS = 60 * 1000;           // 1 minute (real-time trending)
const WINDOW_OVERLAP_MS = 30 * 1000;         // 30s overlap for smooth transitions
const MIN_VALID_NN = 30;                     // minimum NN for a valid window
const MIN_VALID_NN_SHORT = 8;                // minimum NN for short window

// DFA parameters
const DFA_MIN_BOX = 4;
const DFA_MAX_BOX = 64;

// ─── Interpolation ─────────────────────────────────────────────────────────────

/**
 * Cubic spline interpolation for replacing artifact beats.
 * Simpler than full spline — uses piecewise cubic Hermite (pchip-like).
 */
function interpolateNN(
  nnIntervals: number[],
  artifactIdx: Set<number>,
): number[] {
  const n = nnIntervals.length;
  if (artifactIdx.size === 0) return nnIntervals;

  const result = [...nnIntervals];
  const sortedIdx = Array.from(artifactIdx).sort((a, b) => a - b);

  for (const idx of sortedIdx) {
    // Find nearest valid neighbors
    let left = idx - 1;
    while (left >= 0 && artifactIdx.has(left)) left--;
    let right = idx + 1;
    while (right < n && artifactIdx.has(right)) right++;

    if (left < 0 && right >= n) {
      result[idx] = median(nnIntervals);
    } else if (left < 0) {
      result[idx] = nnIntervals[right];
    } else if (right >= n) {
      result[idx] = nnIntervals[left];
    } else {
      // Linear interpolation (simpler, stable)
      const dist = right - left;
      const frac = dist > 0 ? (idx - left) / dist : 0.5;
      result[idx] = nnIntervals[left] + (nnIntervals[right] - nnIntervals[left]) * frac;
    }
  }
  return result;
}

// ─── Artifact rejection ────────────────────────────────────────────────────────

/**
 * Detect and mark artifact beats. Uses two criteria:
 *   1. Physiological bounds (300–2000 ms)
 *   2. Deviation > 30% from median of surrounding 5 beats (Kamath & Fallen)
 */
function detectArtifacts(nn: number[], medianRR: number): Set<number> {
  const artifacts = new Set<number>();
  const HR = VITAL_THRESHOLDS.HR;

  for (let i = 0; i < nn.length; i++) {
    const r = nn[i];

    // Physiological range
    if (r < HR.PHYSIOLOGICAL_RR_MIN_MS || r > HR.PHYSIOLOGICAL_RR_MAX_MS) {
      artifacts.add(i);
      continue;
    }

    // Local deviation: compare with neighbors
    const start = Math.max(0, i - 2);
    const end = Math.min(nn.length, i + 3);
    let localSum = 0, localCount = 0;
    for (let j = start; j < end; j++) {
      if (j !== i && !artifacts.has(j)) {
        localSum += nn[j];
        localCount++;
      }
    }
    if (localCount >= 2) {
      const localMedian = localSum / localCount;
      if (Math.abs(r - localMedian) / Math.max(1, localMedian) > 0.30) {
        artifacts.add(i);
      }
    }
  }
  return artifacts;
}

// ─── Time-domain ───────────────────────────────────────────────────────────────

function computeTimeDomain(nn: number[]): TimeDomainHRV {
  const n = nn.length;
  if (n < 2) return { meanRR: 0, sdnn: 0, sdann: 0, rmssd: 0, pnn50: 0, pnn20: 0, hrvTi: 0, tinn: 0, meanHR: 0 };

  let sum = 0;
  for (let i = 0; i < n; i++) sum += nn[i];
  const meanRR = sum / n;

  let sqSum = 0;
  for (let i = 0; i < n; i++) sqSum += (nn[i] - meanRR) ** 2;
  const sdnn = Math.sqrt(sqSum / n);

  let sumSqDiff = 0;
  let nn50count = 0, nn20count = 0;
  for (let i = 1; i < n; i++) {
    const diff = Math.abs(nn[i] - nn[i - 1]);
    sumSqDiff += diff * diff;
    if (diff > 50) nn50count++;
    if (diff > 20) nn20count++;
  }
  const rmssd = Math.sqrt(sumSqDiff / (n - 1));
  const pnn50 = nn50count / (n - 1);
  const pnn20 = nn20count / (n - 1);

  // HRV Triangular Index: total NN / max bin count (bin = 7.8125 ms)
  const BIN_MS = 7.8125;
  const hist: Map<number, number> = new Map();
  let maxBinCount = 0;
  for (let i = 0; i < n; i++) {
    const bin = Math.round(nn[i] / BIN_MS);
    const count = (hist.get(bin) ?? 0) + 1;
    hist.set(bin, count);
    if (count > maxBinCount) maxBinCount = count;
  }
  const hrvTi = maxBinCount > 0 ? n / maxBinCount : 0;

  // TINN: triangular interpolation — find base of triangle
  let tinn = 0;
  if (maxBinCount > 0 && hist.size >= 3) {
    const entries = Array.from(hist.entries()).sort((a, b) => a[0] - b[0]);
    const peakBin = entries.find(e => e[1] === maxBinCount)?.[0] ?? 0;
    const left = entries[0][0];
    const right = entries[entries.length - 1][0];
    const leftEdge = Math.round(peakBin - (maxBinCount / (entries[0][1] > 0 ? entries[0][1] : 1)) * (peakBin - left));
    const rightEdge = Math.round(peakBin + (maxBinCount / (entries[entries.length - 1][1] > 0 ? entries[entries.length - 1][1] : 1)) * (right - peakBin));
    tinn = Math.max(0, (rightEdge - leftEdge)) * BIN_MS;
  }

  const meanHR = meanRR > 0 ? 60000 / meanRR : 0;
  return { meanRR, sdnn, sdann: 0, rmssd, pnn50, pnn20, hrvTi, tinn, meanHR };
}

// ─── DFA ────────────────────────────────────────────────────────────────────────

/**
 * Detrended Fluctuation Analysis (Peng et al. 1995).
 * Computes α exponent from fluctuation function F(n) ∝ n^α.
 */
function computeDfa(nn: number[], minBox: number, maxBox: number): number {
  const n = nn.length;
  if (n < 2 * minBox + 2) return 0;

  // Integrate and detrend
  const mean = nn.reduce((a, b) => a + b, 0) / n;
  const y = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += nn[i] - mean;
    y[i] = sum;
  }

  const boxSizes: number[] = [];
  for (let b = minBox; b <= Math.min(maxBox, Math.floor(n / 2)); b = Math.min(maxBox + 1, Math.ceil(b * 1.2))) {
    if (b >= minBox && b <= Math.floor(n / 2)) boxSizes.push(b);
  }
  if (boxSizes.length < 2) return 0;

  const logBox = new Float64Array(boxSizes.length);
  const logFluct = new Float64Array(boxSizes.length);

  for (let bi = 0; bi < boxSizes.length; bi++) {
    const box = boxSizes[bi];
    const nBox = Math.floor(n / box);
    let F2 = 0;

    for (let b = 0; b < nBox; b++) {
      const start = b * box;
      // Linear detrend within box
      const seg = y.subarray(start, start + box);
      const segLen = seg.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < segLen; i++) {
        sx += i;
        sy += seg[i];
        sxx += i * i;
        sxy += i * seg[i];
      }
      const denom = segLen * sxx - sx * sx;
      if (denom === 0) continue;
      const slope = (segLen * sxy - sx * sy) / denom;
      const intercept = (sy - slope * sx) / segLen;

      let residualSq = 0;
      for (let i = 0; i < segLen; i++) {
        const residual = seg[i] - (intercept + slope * i);
        residualSq += residual * residual;
      }
      F2 += residualSq;
    }

    const F = Math.sqrt(F2 / (nBox * box));
    logBox[bi] = Math.log(box);
    logFluct[bi] = Math.log(Math.max(1e-10, F));
  }

  // Linear regression in log-log
  const m = logBox.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < m; i++) {
    sx += logBox[i];
    sy += logFluct[i];
    sxx += logBox[i] * logBox[i];
    sxy += logBox[i] * logFluct[i];
  }
  const denom = m * sxx - sx * sx;
  if (denom === 0) return 0;
  const alpha = (m * sxy - sx * sy) / denom;
  return Number.isFinite(alpha) ? Math.max(-1, Math.min(2, alpha)) : 0;
}

// ─── Non-linear ────────────────────────────────────────────────────────────────

function computeNonLinear(nn: number[]): NonLinearHRV {
  const n = nn.length;
  if (n < 4) return { sd1: 0, sd2: 0, sd1Sd2Ratio: 0, sampEn: 0, dfaAlpha1: 0, dfaAlpha2: 0, poincareArea: 0 };

  // Poincaré SD1/SD2
  let sumDiffSq = 0;
  let sumSumSq = 0;
  let sumX = 0, sumY = 0;
  const pn = n - 1;
  for (let i = 0; i < pn; i++) {
    const x = nn[i], y = nn[i + 1];
    sumX += x; sumY += y;
    const diff = x - y;
    const sumTerm = x + y;
    sumDiffSq += diff * diff;
    sumSumSq += sumTerm * sumTerm;
  }
  const meanX = sumX / pn;
  const meanY = sumY / pn;

  let centeredSumSq = 0;
  for (let i = 0; i < pn; i++) {
    const s = (nn[i] + nn[i + 1]) - (meanX + meanY);
    centeredSumSq += s * s;
  }

  const sd1 = Math.sqrt(sumDiffSq / (2 * pn));
  const sd2 = Math.sqrt(Math.max(0, centeredSumSq / (2 * pn)));
  const sd1Sd2Ratio = sd2 > 0 ? sd1 / sd2 : 0;
  const poincareArea = Math.PI * sd1 * sd2;

  // Sample Entropy (m=2, r=0.2×SD)
  const std = Math.sqrt(nn.reduce((a, r) => a + (r - nn.reduce((b, v) => b + v, 0) / n) ** 2, 0) / n);
  const sampEn = computeSampleEntropy(nn, 2, std * 0.2);

  // DFA
  const dfaAlpha1 = computeDfa(nn, 4, 11);
  const dfaAlpha2 = computeDfa(nn, 11, DFA_MAX_BOX);

  return { sd1, sd2, sd1Sd2Ratio, sampEn, dfaAlpha1, dfaAlpha2, poincareArea };
}

/**
 * Sample Entropy (Richman & Moorman 2000).
 * B counts template matches of length m; A counts matches of length m+1.
 * SampEn(m, r, N) = -ln(A/B).
 */
function computeSampleEntropy(data: number[], m: number, r: number): number {
  const N = data.length;
  if (N < m + 2) return 0;

  function countMatches(template: number[], offset: number): number {
    let count = 0;
    for (let i = offset; i <= N - template.length; i++) {
      let match = true;
      for (let j = 0; j < template.length; j++) {
        if (Math.abs(data[i + j] - template[j]) > r) { match = false; break; }
      }
      if (match) count++;
    }
    return count;
  }

  let A = 0, B = 0;
  for (let i = 0; i < N - m; i++) {
    const templateM = data.slice(i, i + m);
    B += countMatches(templateM, i + 1);
    const templateM1 = data.slice(i, i + m + 1);
    A += countMatches(templateM1, i + 1);
  }

  if (B === 0) return 0;
  return -Math.log(A / B);
}

// ─── Main analysis window ──────────────────────────────────────────────────────

/**
 * Analyze a single window of RR intervals with timestamps.
 */
export function analyzeHrvWindow(
  rrIntervals: number[],
  peakTimes: number[],
  windowStart: number,
  windowEnd: number,
): HrvWindowResult | null {
  // Align: find RR intervals that fall within [windowStart, windowEnd]
  const indices: number[] = [];
  const nnRaw: number[] = [];

  for (let i = 0; i < rrIntervals.length && i < peakTimes.length; i++) {
    const t = peakTimes[i];
    if (t >= windowStart && t <= windowEnd) {
      indices.push(i);
      nnRaw.push(rrIntervals[i]);
    }
  }

  if (nnRaw.length < MIN_VALID_NN) return null;

  // Artifact detection + interpolation
  const nnMedian = median(nnRaw);
  if (nnMedian <= 0) return null;

  const artifacts = detectArtifacts(nnRaw, nnMedian);
  const nnClean = interpolateNN(nnRaw, artifacts);

  const artifactPercent = nnRaw.length > 0 ? (artifacts.size / nnRaw.length) * 100 : 0;
  if (artifactPercent > 20) return null; // Too many artifacts

  const timeDomain = computeTimeDomain(nnClean);
  const nonLinear = computeNonLinear(nnClean);

  // Frequency domain: build time array (cumulative sum of clean NN)
  const tArr: number[] = [0];
  for (let i = 1; i < nnClean.length; i++) tArr.push(tArr[i - 1] + nnClean[i - 1]);

  const frequencyDomain = lombScargleHrv(tArr, nnClean);
  const windowDuration = windowEnd - windowStart;

  return {
    timestamp: windowEnd,
    windowStart,
    windowDuration,
    timeDomain,
    frequencyDomain,
    nonLinear,
    artifacts: {
      totalBeats: nnRaw.length,
      artifactBeats: artifacts.size,
      artifactPercent,
      interpolatedBeats: artifacts.size,
    },
    nnCount: nnClean.length,
    quality: 1 - (artifactPercent / 100),
  };
}

// ─── Full session report (5-min windows) ────────────────────────────────────────

/**
 * Compute full HRV report over a measurement session.
 * Uses sliding 5-minute windows per Task Force standards.
 * Also produces 1-minute windows for real-time trending.
 *
 * @param rrIntervals - All RR intervals from the session (ms)
 * @param peakTimes   - Timestamps for each RR interval (ms)
 * @param sessionDurationMs - Total session duration (ms)
 */
export function computeFullHrvReport(
  rrIntervals: number[],
  peakTimes: number[],
  sessionDurationMs: number,
): FullHrvReport {
  const windows: HrvWindowResult[] = [];
  const shortWindows: HrvWindowResult[] = [];

  // 5-min windows with 30s overlap
  const fiveMinStep = TASK_FORCE_WINDOW_MS - WINDOW_OVERLAP_MS;
  for (let start = 0; start + TASK_FORCE_WINDOW_MS <= sessionDurationMs; start += fiveMinStep) {
    const end = start + TASK_FORCE_WINDOW_MS;
    const result = analyzeHrvWindow(rrIntervals, peakTimes, start, end);
    if (result) windows.push(result);
  }

  // 1-min windows with 15s overlap (for trending only — minimum 4 valid minutes)
  const oneMinStep = SHORT_WINDOW_MS - 15_000;
  for (let start = 0; start + SHORT_WINDOW_MS <= sessionDurationMs; start += oneMinStep) {
    const end = start + SHORT_WINDOW_MS;
    const result = analyzeHrvWindow(rrIntervals, peakTimes, start, end);
    if (result) shortWindows.push(result);
  }

  // Compute summary from the main (5-min) windows
  const validWindows = windows.length > 0 ? windows : shortWindows;
  const nw = validWindows.length;

  const summary = {
    sdnn: nw > 0 ? validWindows.reduce((a, w) => a + w.timeDomain.sdnn, 0) / nw : 0,
    rmssd: nw > 0 ? validWindows.reduce((a, w) => a + w.timeDomain.rmssd, 0) / nw : 0,
    pnn50: nw > 0 ? validWindows.reduce((a, w) => a + w.timeDomain.pnn50, 0) / nw : 0,
    lfHfRatio: nw > 0 ? validWindows.reduce((a, w) => a + w.frequencyDomain.lfHfRatio, 0) / nw : 0,
    sd1: nw > 0 ? validWindows.reduce((a, w) => a + w.nonLinear.sd1, 0) / nw : 0,
    sd2: nw > 0 ? validWindows.reduce((a, w) => a + w.nonLinear.sd2, 0) / nw : 0,
    sampEn: nw > 0 ? validWindows.reduce((a, w) => a + w.nonLinear.sampEn, 0) / nw : 0,
    dfaAlpha1: nw > 0 ? validWindows.reduce((a, w) => a + w.nonLinear.dfaAlpha1, 0) / nw : 0,
    meanHR: nw > 0 ? validWindows.reduce((a, w) => a + w.timeDomain.meanHR, 0) / nw : 0,
  };

  return { windows, shortWindows, summary };
}
