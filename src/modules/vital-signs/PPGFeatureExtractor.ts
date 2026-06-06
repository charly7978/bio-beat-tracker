/**
 * EXTRACTOR DE CARACTERÍSTICAS PPG AVANZADO
 * 
 * Refactorizado con:
 * - Detección robusta de fiducial points (onset, systolic peak, dicrotic notch, diastolic peak)
 * - Validación cruzada VPG (1ª derivada) / APG (2ª derivada)
 * - Features de área (integral sistólica/diastólica) + IPA ratio
 * - Pulse width a múltiples niveles (10%, 25%, 50%, 75%)
 * - Detección de ciclos cardíacos completos
 * 
 * Referencias:
 * - Elgendi 2024 (Diagnostics) - APG ratios para BP
 * - pyPPG (PMC 2024) - 632 features estandarizados
 */

import { calculateHRV } from '../../utils/physio';

// ═══════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════

export interface FiducialPoints {
  onset: number;       // Start of cardiac cycle (foot/valley)
  systolicPeak: number; // Systolic peak index
  dicroticNotch: number; // Dicrotic notch index (-1 if not found)
  diastolicPeak: number; // Diastolic peak index (-1 if not found)
  nextOnset: number;    // Start of next cycle
}

export interface APGFeatures {
  a: number; b: number; c: number; d: number; e: number;
  bDivA: number;
  cDivA: number;
  dDivA: number;
  eDivA: number;
  agi: number;  // Aging Index: (b - c - d - e) / a
}

export interface CycleFeatures {
  // Temporal (in ms)
  sutMs: number;         // Systolic Upstroke Time
  diastolicTimeMs: number; // Pico sistólico → siguiente onset (ciclo tardío)
  diastolicPhaseMs: number; // Muesca dicrótica → siguiente onset (fase diastólica real)
  pw10Ms: number;        // Pulse width at 10% amplitude
  pw25Ms: number;        // Pulse width at 25% amplitude
  pw50Ms: number;        // Pulse width at 50% amplitude
  pw75Ms: number;        // Pulse width at 75% amplitude
  dicroticNotchTimeMs: number; // Time to dicrotic notch from onset
  
  // Amplitude
  systolicAmplitude: number;
  diastolicAmplitude: number;
  dicroticDepth: number; // Normalized depth of dicrotic notch (0-1)
  
  // Area
  systolicArea: number;
  diastolicArea: number;
  areaRatio: number;    // systolicArea / diastolicArea (IPA)
  ipaRatio: number;     // Inflection Point Area ratio
  
  // Morphological
  stiffnessIndex: number;
  augmentationIndex: number;
  pwvProxy: number;
  
  // APG (second derivative)
  apg: APGFeatures;
  
  // Quality
  quality: number; // 0-1
  
  // Advanced 2024 Features
  kValue: number;       // Ratio of area under pulse to peak height * duration
  vMax: number;         // Maximum ascending slope

  // 2025 Features
  harmonicDistortion: number;  // HD = sqrt(harmonic_energy / total_energy) — correlato de rigidez arterial (Nature 2025)
}

// ═══════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════

export class PPGFeatureExtractor {

  // ─────────────────────────────────────────
  // CARDIAC CYCLE DETECTION
  // ─────────────────────────────────────────

  /**
   * Detect individual cardiac cycles from PPG signal
   * Uses valley detection validated with first derivative zero-crossings
   */
  static detectCardiacCycles(buffer: number[], sampleRate: number = 30): FiducialPoints[] {
    if (buffer.length < sampleRate * 2) return [];

    // 1. Find valleys (cycle onsets) using first derivative
    const vpg = this.firstDerivative(buffer);
    const valleys = this.findValleys(buffer, vpg, sampleRate);

    if (valleys.length < 2) return [];

    const cycles: FiducialPoints[] = [];

    for (let i = 0; i < valleys.length - 1; i++) {
      const onset = valleys[i];
      const nextOnset = valleys[i + 1];
      const cycleLength = nextOnset - onset;

      // Validate cycle length (350ms - 1800ms → ~33-171 BPM) to reject non-human noise
      const cycleLengthMs = (cycleLength / sampleRate) * 1000;
      if (cycleLengthMs < 350 || cycleLengthMs > 1800) continue;

      // 2. Find systolic peak within cycle
      const systolicPeak = this.findSystolicPeak(buffer, onset, nextOnset);
      if (systolicPeak <= onset) continue;

      // 3. Find dicrotic notch and diastolic peak
      const { notch, diastolicPeak } = this.findDicroticFeatures(
        buffer, vpg, systolicPeak, nextOnset
      );

      cycles.push({
        onset,
        systolicPeak,
        dicroticNotch: notch,
        diastolicPeak,
        nextOnset
      });
    }

    return cycles;
  }

  /**
   * Extract comprehensive features for a single cardiac cycle
   */
  static extractCycleFeatures(
    buffer: number[],
    fiducials: FiducialPoints,
    sampleRate: number = 30
  ): CycleFeatures | null {
    const { onset, systolicPeak, dicroticNotch, diastolicPeak, nextOnset } = fiducials;

    // Validate indices
    if (onset < 0 || nextOnset >= buffer.length || systolicPeak <= onset) return null;

    const msPerSample = 1000 / sampleRate;
    const onsetVal = buffer[onset];
    const peakVal = buffer[systolicPeak];
    const amplitude = peakVal - onsetVal;

    if (amplitude <= 0) return null;

    // ── Temporal features ──
    const sutMs = (systolicPeak - onset) * msPerSample;
    const diastolicTimeMs = (nextOnset - systolicPeak) * msPerSample;
    const divideForPhase = dicroticNotch >= 0
      ? dicroticNotch
      : Math.round(systolicPeak + (nextOnset - systolicPeak) * 0.42);
    const diastolicPhaseMs = (nextOnset - divideForPhase) * msPerSample;
    const dicroticNotchTimeMs = dicroticNotch >= 0 
      ? (dicroticNotch - onset) * msPerSample 
      : diastolicTimeMs * 0.6; // estimate

    // Pulse widths at multiple amplitude levels
    const pw10Ms = this.pulseWidthAtLevel(buffer, onset, nextOnset, onsetVal, amplitude, 0.10) * msPerSample;
    const pw25Ms = this.pulseWidthAtLevel(buffer, onset, nextOnset, onsetVal, amplitude, 0.25) * msPerSample;
    const pw50Ms = this.pulseWidthAtLevel(buffer, onset, nextOnset, onsetVal, amplitude, 0.50) * msPerSample;
    const pw75Ms = this.pulseWidthAtLevel(buffer, onset, nextOnset, onsetVal, amplitude, 0.75) * msPerSample;

    // ── Amplitude features ──
    const systolicAmplitude = amplitude;
    const diastolicAmplitude = diastolicPeak >= 0 
      ? buffer[diastolicPeak] - onsetVal 
      : amplitude * 0.5;
    
    const dicroticDepth = dicroticNotch >= 0
      ? (peakVal - buffer[dicroticNotch]) / amplitude
      : 0;

    // ── Area features (trapezoidal integration) ──
    const dividePoint = dicroticNotch >= 0 ? dicroticNotch : Math.round((systolicPeak + nextOnset) / 2);
    const systolicArea = this.trapezoidalArea(buffer, onset, dividePoint, onsetVal);
    const diastolicArea = this.trapezoidalArea(buffer, dividePoint, nextOnset, onsetVal);
    const totalArea = systolicArea + diastolicArea;
    const areaRatio = diastolicArea > 0 ? systolicArea / diastolicArea : 0;
    const ipaRatio = areaRatio; // IPA = systolic/diastolic area

    // ── K-Value ──
    // K = Area / (PeakAmplitude * DurationInSamples)
    const cycleDuration = nextOnset - onset;
    const kValue = (amplitude > 0 && cycleDuration > 0) ? totalArea / (amplitude * cycleDuration) : 0;

    // ── Vmax (Max Slope - Robust 3-point derivative) ──
    let vMax = 0;
    for (let i = onset + 1; i < systolicPeak - 1; i++) {
      // Central derivative: (f(x+1) - f(x-1)) / 2
      const slope = (buffer[i + 1] - buffer[i - 1]) * 0.5;
      if (slope > vMax) vMax = slope;
    }
    vMax = vMax * sampleRate; // normalize to amplitude per second

    // ── Stiffness Index ──
    // SI = body_height / ΔTDVP (time between systolic and diastolic peaks)
    // Without height, use inverse of the time delay as proxy
    let stiffnessIndex = 0;
    if (diastolicPeak >= 0 && diastolicPeak > systolicPeak) {
      const deltaT = (diastolicPeak - systolicPeak) * msPerSample;
      stiffnessIndex = deltaT > 0 ? 1000 / deltaT : 0;
    }

    // ── Augmentation Index ──
    let augmentationIndex = 0;
    if (diastolicPeak >= 0) {
      const p1 = peakVal - onsetVal;
      const p2 = buffer[diastolicPeak] - onsetVal;
      augmentationIndex = p1 > 0 ? (p2 / p1) * 100 : 0;
    }

    // ── PWV proxy ──
    // From systolic upstroke slope + stiffness
    let pwvProxy = 0;
    if (sutMs > 0) {
      const slopeNorm = amplitude / (sutMs / 1000); // amplitude per second
      pwvProxy = 4.0 + slopeNorm * 0.01 + stiffnessIndex * 0.5;
    }

    // ── APG features ──
    const cycleSegment = buffer.slice(onset, nextOnset + 1);
    const apg = this.extractAPGFromSegment(cycleSegment);

    // ── Harmonic Distortion (Nature 2025) ──
    // Cuantifica el contenido armónico del pulso: arterias rígidas producen
    // ondas más puntiagudas (armónicos ricos). Se computa como la fracción
    // de energía no explicada por el seno fundamental del ciclo cardíaco.
    const hd = this.computeHarmonicDistortion(buffer, onset, nextOnset, sampleRate);

    // ── Quality assessment ──
    const quality = this.assessCycleQuality(
      amplitude, sutMs, diastolicTimeMs, pw50Ms, dicroticNotch >= 0
    );

    return {
      sutMs, diastolicTimeMs, diastolicPhaseMs,
      pw10Ms, pw25Ms, pw50Ms, pw75Ms,
      dicroticNotchTimeMs,
      systolicAmplitude, diastolicAmplitude, dicroticDepth,
      systolicArea, diastolicArea, areaRatio, ipaRatio,
      stiffnessIndex, augmentationIndex, pwvProxy,
      apg, quality,
      kValue, vMax,
      harmonicDistortion: hd,
    };
  }

  // ─────────────────────────────────────────
  // FIDUCIAL POINT HELPERS
  // ─────────────────────────────────────────

  private static firstDerivative(buffer: number[]): number[] {
    const d: number[] = [0];
    for (let i = 1; i < buffer.length; i++) {
      d.push(buffer[i] - buffer[i - 1]);
    }
    return d;
  }

  private static secondDerivative(buffer: number[]): number[] {
    const d2: number[] = [0];
    for (let i = 1; i < buffer.length - 1; i++) {
      d2.push(buffer[i + 1] - 2 * buffer[i] + buffer[i - 1]);
    }
    d2.push(0);
    return d2;
  }

  /**
   * Find valleys (cycle onsets) using signal minima validated with VPG zero-crossings
   */
  private static findValleys(
    buffer: number[], vpg: number[], sampleRate: number
  ): number[] {
    const minCycleLen = Math.round(sampleRate * 0.3); // min 300ms between valleys
    const valleys: number[] = [];

    for (let i = 2; i < buffer.length - 2; i++) {
      // Local minimum in signal
      if (buffer[i] <= buffer[i - 1] && buffer[i] <= buffer[i + 1] &&
          buffer[i] <= buffer[i - 2] && buffer[i] <= buffer[i + 2]) {
        // Validate with VPG: should cross from negative to positive near valley
        const vpgCross = (i < vpg.length - 1) && (vpg[i] <= 0 && vpg[i + 1] > 0);
        const vpgNearCross = (i > 0 && i < vpg.length - 2) && 
          (vpg[i - 1] < 0 || vpg[i] < 0) && (vpg[i + 1] > 0 || vpg[i + 2] > 0);

        if (vpgCross || vpgNearCross || vpg.length === 0) {
          // Enforce minimum distance
          if (valleys.length === 0 || (i - valleys[valleys.length - 1]) >= minCycleLen) {
            valleys.push(i);
          }
        }
      }
    }

    return valleys;
  }

  private static findSystolicPeak(buffer: number[], onset: number, nextOnset: number): number {
    // Peak must be in first 70% of cycle
    const searchEnd = onset + Math.round((nextOnset - onset) * 0.7);
    let maxIdx = onset;
    let maxVal = buffer[onset];

    for (let i = onset + 1; i <= Math.min(searchEnd, buffer.length - 1); i++) {
      if (buffer[i] > maxVal) {
        maxVal = buffer[i];
        maxIdx = i;
      }
    }

    return maxIdx;
  }

  private static findDicroticFeatures(
    buffer: number[], vpg: number[], systolicPeak: number, nextOnset: number
  ): { notch: number; diastolicPeak: number } {
    // Search for dicrotic notch: local minimum after systolic peak
    const searchStart = systolicPeak + 2;
    const searchEnd = nextOnset - 1;

    if (searchStart >= searchEnd) {
      return { notch: -1, diastolicPeak: -1 };
    }

    // Find local minima in the diastolic phase
    let notchIdx = -1;
    let notchVal = Infinity;

    for (let i = searchStart + 1; i < searchEnd - 1; i++) {
      if (buffer[i] < buffer[i - 1] && buffer[i] < buffer[i + 1]) {
        if (buffer[i] < notchVal) {
          notchVal = buffer[i];
          notchIdx = i;
          break; // Take first local minimum after peak as dicrotic notch
        }
      }
    }

    // Find diastolic peak: local maximum after notch
    let diastolicPeakIdx = -1;
    if (notchIdx >= 0) {
      let dpMax = buffer[notchIdx];
      for (let i = notchIdx + 1; i < searchEnd; i++) {
        if (buffer[i] > dpMax) {
          dpMax = buffer[i];
          diastolicPeakIdx = i;
        }
      }
      // Validate: diastolic peak should be below systolic peak
      if (diastolicPeakIdx >= 0 && buffer[diastolicPeakIdx] >= buffer[systolicPeak]) {
        diastolicPeakIdx = -1;
      }
    }

    return { notch: notchIdx, diastolicPeak: diastolicPeakIdx };
  }

  // ─────────────────────────────────────────
  // FEATURE EXTRACTION HELPERS
  // ─────────────────────────────────────────

  /**
   * Pulse width at a given amplitude level (as fraction of total amplitude)
   * Returns width in samples
   */
  private static pulseWidthAtLevel(
    buffer: number[], onset: number, nextOnset: number,
    baseVal: number, amplitude: number, level: number
  ): number {
    const threshold = baseVal + amplitude * level;
    let firstCross = -1;
    let lastCross = -1;

    for (let i = onset; i <= nextOnset; i++) {
      if (buffer[i] >= threshold) {
        if (firstCross < 0) firstCross = i;
        lastCross = i;
      }
    }

    return (firstCross >= 0 && lastCross > firstCross) ? (lastCross - firstCross) : 0;
  }

  /**
   * Trapezoidal area above baseline between two indices
   */
  private static trapezoidalArea(
    buffer: number[], startIdx: number, endIdx: number, baseline: number
  ): number {
    let area = 0;
    for (let i = startIdx; i < endIdx && i < buffer.length - 1; i++) {
      const h1 = Math.max(0, buffer[i] - baseline);
      const h2 = Math.max(0, buffer[i + 1] - baseline);
      area += (h1 + h2) / 2;
    }
    return area;
  }

  /**
   * APG features from a single cycle segment
   */
  private static extractAPGFromSegment(segment: number[]): APGFeatures {
    const defaults: APGFeatures = { 
      a: 0, b: 0, c: 0, d: 0, e: 0, 
      bDivA: 0, cDivA: 0, dDivA: 0, eDivA: 0, agi: 0 
    };

    if (segment.length < 10) return defaults;

    const apg = this.secondDerivative(segment);
    if (apg.length < 8) return defaults;

    // Find peaks and valleys in APG ordered by temporal position
    const extrema: { idx: number; val: number; type: 'peak' | 'valley' }[] = [];

    for (let i = 2; i < apg.length - 2; i++) {
      if (!Number.isFinite(apg[i])) continue;
      if (Math.abs(apg[i]) > 100) continue; // reject numerical artifacts
      if (apg[i] > apg[i - 1] && apg[i] > apg[i + 1] &&
          apg[i] > apg[i - 2] && apg[i] > apg[i + 2]) {
        extrema.push({ idx: i, val: apg[i], type: 'peak' });
      }
      if (apg[i] < apg[i - 1] && apg[i] < apg[i + 1] &&
          apg[i] < apg[i - 2] && apg[i] < apg[i + 2]) {
        extrema.push({ idx: i, val: apg[i], type: 'valley' });
      }
    }

    extrema.sort((x, y) => x.idx - y.idx);

    // APG standard: a(peak), b(valley), c(peak), d(valley), e(peak)
    const peaks = extrema.filter(e => e.type === 'peak');
    const valleys = extrema.filter(e => e.type === 'valley');

    const a = peaks.length > 0 && Math.abs(peaks[0].val) < 100 ? peaks[0].val : 0;
    const b = valleys.length > 0 && Math.abs(valleys[0].val) < 100 ? valleys[0].val : 0;
    const c = peaks.length > 1 && Math.abs(peaks[1].val) < 100 ? peaks[1].val : 0;
    const d = valleys.length > 1 && Math.abs(valleys[1].val) < 100 ? valleys[1].val : 0;
    const e = peaks.length > 2 && Math.abs(peaks[2].val) < 100 ? peaks[2].val : 0;

    const bDivA = Math.abs(a) > 1e-10 ? b / a : 0;
    const cDivA = Math.abs(a) > 1e-10 ? c / a : 0;
    const dDivA = Math.abs(a) > 1e-10 ? d / a : 0;
    const eDivA = Math.abs(a) > 1e-10 ? e / a : 0;
    const agi = Math.abs(a) > 1e-10 ? (b - c - d - e) / a : 0;

    return { a, b, c, d, e, bDivA, cDivA, dDivA, eDivA, agi };
  }

  /**
   * Harmonic Distortion via sine-fit residual (Nature Scientific Reports 2025).
   * Ajusta un seno a la frecuencia fundamental del ciclo y mide la energía
   * armónica residual como fracción de la energía total. HD → 0 ≈ seno puro
   * (arteria complaciente); HD → 1 ≈ pulso rico en armónicos (arteria rígida).
   */
  private static computeHarmonicDistortion(
    buffer: number[], onset: number, nextOnset: number, sampleRate: number,
  ): number {
    const n = nextOnset - onset;
    if (n < 8) return 0;
    const f0 = sampleRate / n;
    let sinSum = 0, cosSum = 0, sin2Sum = 0, cos2Sum = 0, sincosSum = 0, totalVar = 0;
    const mean = buffer.slice(onset, nextOnset + 1).reduce((a, b) => a + b, 0) / (n + 1);
    for (let i = 0; i <= n; i++) {
      const t = i / sampleRate;
      const s = Math.sin(2 * Math.PI * f0 * t);
      const c = Math.cos(2 * Math.PI * f0 * t);
      const y = buffer[onset + i] - mean;
      sinSum += y * s; cosSum += y * c;
      sin2Sum += s * s; cos2Sum += c * c; sincosSum += s * c;
      totalVar += y * y;
    }
    if (totalVar < 1e-10) return 0;
    const det = sin2Sum * cos2Sum - sincosSum * sincosSum;
    if (Math.abs(det) < 1e-10) return 0;
    const A = (cos2Sum * sinSum - sincosSum * cosSum) / det;
    const B = (sin2Sum * cosSum - sincosSum * sinSum) / det;
    const fundEnergy = (A * A + B * B) * (n + 1) / 2;
    const harmEnergy = Math.max(0, totalVar - fundEnergy);
    return Math.sqrt(harmEnergy / totalVar);
  }

  /**
   * Assess quality of a single cardiac cycle
   */
  private static assessCycleQuality(
    amplitude: number,
    sutMs: number,
    diastolicTimeMs: number,
    pw50Ms: number,
    hasDicroticNotch: boolean
  ): number {
    let q = 0;

    // Amplitude — lower threshold for weak but real signals
    if (amplitude > 0.2) q += 0.20;
    if (amplitude > 0.8) q += 0.10;
    if (amplitude > 2.0) q += 0.05;

    // SUT in physiological range (wider)
    if (sutMs > 40 && sutMs < 400) q += 0.25;

    // Diastolic time
    if (diastolicTimeMs > sutMs * 0.6) q += 0.15;

    // PW50 in range (wider)
    if (pw50Ms > 60 && pw50Ms < 900) q += 0.15;

    // Dicrotic notch bonus — menor peso porque notch es difícil de detectar
    // en PPG de smartphone y se desvanece con edad (Dawber class 3-4)
    if (hasDicroticNotch) q += 0.10;

    return Math.min(1, q);
  }

  static extractRRVariability(intervals: number[]): { sdnn: number; rmssd: number; cv: number } {
    const { sdnn, rmssd, cv } = calculateHRV(intervals);
    return { sdnn, rmssd, cv };
  }
}
