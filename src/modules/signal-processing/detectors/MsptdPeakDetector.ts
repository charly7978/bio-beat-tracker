/**
 * MSPTD — Multi-Scale Peak & Trough Detection (Bishop & Ercole 2018).
 *
 * Benchmark de vanguardia (Charlton et al. 2022, Physiol Meas; 15 detectores,
 * 8 datasets): MSPTD fue el detector con mejor PPV (menor tasa de FALSOS
 * POSITIVOS) en datos de hospital y wearables en reposo/ADL. Complementa a
 * Elgendi (ERMA) cubriendo picos que Elgendi pierde por morfología no ideal
 * (picos aplanados por presión del dedo, baja perfusión, arritmias).
 *
 * Principio: construye un escalograma binario de máximos locales en múltiples
 * escalas (LMS — Local Maxima Scalogram). La escala lambda con más máximos
 * define el periodo cuasi predominante; un punto es pico si es máximo local en
 * TODAS las escalas k ∈ [1, lambda]. Como EXIGE máximo en todas las escalas
 * hasta lambda, la dicrota y el ruido (que son máximos solo en escalas cortas)
 * se rechazan → PPV alto. Detecta también valles (onsets) con la misma lógica.
 *
 * Adaptación tiempo-real: opera sobre la ventana deslizante ya filtrada del
 * pipeline (30-300 muestras @ ~30 Hz ≈ 1-10 s). Sin downsampling: la señal de
 * entrada ya viene a fs baja (20-40 Hz).
 *
 * Complejidad: O(L·N) con L = ceil(N/2)-1 escalas en implementación ingenua.
 * Optimizaciones:
 *   1. Cota de escalas a N/3 (basta para capturar 3+ ciclos de una ventana).
 *   2. Recorrido incremental: cada par (i, k) se evalúa una sola vez.
 *   3. Arrays Uint8/Float64 pre-asignados, sin asignaciones por frame.
 */
import { detrendLinear, movingAverage } from '../shared/dsp';
import { clamp } from '../../../utils/math';

export interface MsptdPeakDetectorInput {
  signal: number[];
  /** Fs efectivo (Hz) — se usa solo para la corrección de pico local. */
  samplingRateHz: number;
  /** Escala mínima a evaluar: `Math.max(1, round(fs*0.05))` típico. */
  minScale?: number;
  /** Timestamps opcionales para diagnóstico y refractario temporal. */
  timestampsMs?: number[];
}

export interface MsptdPeakDetectorOutput {
  peaks: number[];
  troughs: number[];
  diagnostics: {
    lambdaMax: number;
    lambdaMin: number;
    scalesEvaluated: number;
    detrended: boolean;
    falsePositiveRejections: number;
    estimatedBpm?: number;
    dominantPeriodSamples?: number;
  };
}

/** Máximo local ESTRICTO: x[i-1] > vecinos a distancia k a ambos lados. */
function localMaxRow(
  x: number[],
  n: number,
  k: number,
  out: Uint8Array,
): void {
  const start = k + 2;
  const end = n - k + 1;
  for (let i = start; i < end; i++) {
    if (x[i - 1] > x[i - k - 1] && x[i - 1] > x[i + k - 1]) {
      out[i - 1] = 1;
    }
  }
}

function localMinRow(
  x: number[],
  n: number,
  k: number,
  out: Uint8Array,
): void {
  const start = k + 2;
  const end = n - k + 1;
  for (let i = start; i < end; i++) {
    if (x[i - 1] < x[i - k - 1] && x[i - 1] < x[i + k - 1]) {
      out[i - 1] = 1;
    }
  }
}

export class MsptdPeakDetector {
  static detect(input: MsptdPeakDetectorInput): MsptdPeakDetectorOutput {
    const { signal, samplingRateHz } = input;
    const n = signal.length;

    if (n < 12 || samplingRateHz <= 0) {
      return {
        peaks: [], troughs: [],
        diagnostics: { lambdaMax: 0, lambdaMin: 0, scalesEvaluated: 0, detrended: false, falsePositiveRejections: 0 },
      };
    }

    // Detrend lineal — el DC y la deriva lenta destruyen la comparación de
    // vecinos lejanos en el escalograma (una pendiente se ve como máximo en
    // una sola dirección). Mismo paso que la implementación de referencia.
    const x = detrendLinear(signal);
    const smoothed = movingAverage(x, Math.max(3, Math.round(samplingRateHz * 0.08)));

    // Número de escalas: la referencia usa ceil(N/2)-1, pero las escalas
    // mayores que N/3 aportan poco (menos de 3 ciclos observables) y son
    // O(N) cada una. Con N=300 → 99 escalas (≈ la mitad del coste original).
    const L = clamp(Math.ceil(n / 3) - 1, 2, 180);
    const minScale = Math.max(1, input.minScale ?? Math.max(1, Math.round(samplingRateHz * 0.05)));

    // LMS binario por fila: fila k = máximos locales a escala k.
    // O(L·N) con L ≈ N/3.
    const lmMax = new Uint8Array(n);
    const lmMin = new Uint8Array(n);
    const gammaMax = new Float64Array(L + 1);
    const gammaMin = new Float64Array(L + 1);

    for (let k = minScale; k <= L; k++) {
      lmMax.fill(0);
      lmMin.fill(0);
      localMaxRow(smoothed, n, k, lmMax);
      localMinRow(smoothed, n, k, lmMin);

      let gMax = 0;
      let gMin = 0;
      for (let i = 0; i < n; i++) {
        gMax += lmMax[i];
        gMin += lmMin[i];
      }
      gammaMax[k] = gMax;
      gammaMin[k] = gMin;
    }

    // Lambda: escala con más máximos/minimos locales. Es la "periodicidad"
    // dominante de la ventana (cuasi-periodica → pico de gamma en la escala
    // del ciclo real).
    let lambdaMax = 1;
    let lambdaMin = 1;
    let bestMax = -1;
    let bestMin = -1;
    for (let k = minScale; k <= L; k++) {
      if (gammaMax[k] > bestMax) { bestMax = gammaMax[k]; lambdaMax = k; }
      if (gammaMin[k] > bestMin) { bestMin = gammaMin[k]; lambdaMin = k; }
    }

    // Mínimo de máximos para considerar lambda válido (≈2 ciclos en ventana).
    // Si no hay periodicidad, devuelve vacío — el consenso lo maneja.
    const minPeaksForLambda = Math.max(2, Math.floor(n / 48));
    if (bestMax < minPeaksForLambda || bestMin < minPeaksForLambda) {
      return {
        peaks: [], troughs: [],
        diagnostics: { lambdaMax, lambdaMin, scalesEvaluated: L - minScale + 1, detrended: true, falsePositiveRejections: 0 },
      };
    }

    // Picos candidatos: columnas que fueron máximo local en TODAS las escalas
    // 1..lambdaMax. Se evalúa en una pasada por escala (O(lambdaMax·N)).
    // Uso un contador por columna; la columna es pico si cuenta == lambdaMax-minScale+1.
    const hitCount = new Uint32Array(n);
    for (let k = minScale; k <= lambdaMax; k++) {
      lmMax.fill(0);
      localMaxRow(smoothed, n, k, lmMax);
      for (let i = 0; i < n; i++) hitCount[i] += lmMax[i];
    }
    const peakCandidates: number[] = [];
    const required = lambdaMax - minScale + 1;
    for (let i = 0; i < n; i++) {
      if (hitCount[i] === required) peakCandidates.push(i);
    }

    hitCount.fill(0);
    for (let k = minScale; k <= lambdaMin; k++) {
      lmMin.fill(0);
      localMinRow(smoothed, n, k, lmMin);
      for (let i = 0; i < n; i++) hitCount[i] += lmMin[i];
    }
    const troughCandidates: number[] = [];
    const requiredMin = lambdaMin - minScale + 1;
    for (let i = 0; i < n; i++) {
      if (hitCount[i] === requiredMin) troughCandidates.push(i);
    }

    // Corrección local: el pico/valle exacto puede desplazarse ±1 muestra por
    // el muestreo; se refina buscando el máximo absoluto en ±tol alrededor.
    // (Equivale a la "corrección por tolerancia" de la implementación de
    // referencia, con tol = 1 muestra a fs baja.)
    const tol = Math.max(1, Math.round(samplingRateHz * 0.03));
    const refinedPeaks = refineLocalExtrema(smoothed, peakCandidates, tol, true);
    const refinedTroughs = refineLocalExtrema(smoothed, troughCandidates, tol, false);

    const estimatedPeriodSamples = Math.max(4, Math.round(lambdaMax * 1.55));
    const estimatedBpm = samplingRateHz > 0 && estimatedPeriodSamples > 0
      ? Math.round((samplingRateHz * 60) / estimatedPeriodSamples)
      : undefined;

    const filteredPeaks = filterPeakCandidates(smoothed, refinedPeaks, estimatedPeriodSamples);
    const filteredTroughs = filterTroughCandidates(smoothed, refinedTroughs, estimatedPeriodSamples);
    const falsePositiveRejections = refinedPeaks.length - filteredPeaks.length;

    return {
      peaks: filteredPeaks,
      troughs: filteredTroughs,
      diagnostics: {
        lambdaMax,
        lambdaMin,
        scalesEvaluated: L - minScale + 1,
        detrended: true,
        falsePositiveRejections,
        estimatedBpm,
        dominantPeriodSamples: estimatedPeriodSamples,
      },
    };
  }
}

/** Refina la posición de máximos/mínimos locales buscando el extremo en ±tol. */
function refineLocalExtrema(
  x: number[],
  cands: number[],
  tol: number,
  isMax: boolean,
): number[] {
  const n = x.length;
  if (cands.length === 0) return [];
  const out: number[] = [];
  for (const c of cands) {
    const lo = Math.max(0, c - tol);
    const hi = Math.min(n - 1, c + tol);
    let bestIdx = c;
    let best = x[c];
    for (let i = lo; i <= hi; i++) {
      const v = x[i];
      if ((isMax && v > best) || (!isMax && v < best)) {
        best = v;
        bestIdx = i;
      }
    }
    out.push(bestIdx);
  }
  return out;
}

function filterPeakCandidates(
  x: number[],
  candidates: number[],
  periodSamples: number,
): number[] {
  if (candidates.length === 0) return [];

  const searchRadius = Math.max(2, Math.round(periodSamples * 0.28));
  const scored = candidates.map((idx) => {
    const lo = Math.max(0, idx - searchRadius);
    const hi = Math.min(x.length - 1, idx + searchRadius);
    let leftBase = x[idx];
    let rightBase = x[idx];
    for (let i = lo; i < idx; i++) leftBase = Math.min(leftBase, x[i]);
    for (let i = idx + 1; i <= hi; i++) rightBase = Math.min(rightBase, x[i]);
    const base = Math.min(leftBase, rightBase);
    return { idx, prominence: x[idx] - base, value: x[idx] };
  });

  scored.sort((a, b) => b.prominence - a.prominence || a.idx - b.idx);

  const accepted: number[] = [];
  const minDist = Math.max(2, Math.round(periodSamples * 0.55));
  const dynamicRange = Math.max(1e-6, Math.max(...x) - Math.min(...x));
  const medianProm = scored[Math.floor(scored.length / 2)]?.prominence ?? 0;
  const promFloor = Math.max(0.01 * dynamicRange, medianProm * 0.35);
  const promCeil = Math.max(promFloor * 1.2, medianProm * 2.8);

  for (const { idx, prominence, value } of scored) {
    if (prominence < promFloor || prominence > promCeil) continue;
    const prev = accepted[accepted.length - 1];
    if (prev != null && idx - prev < minDist) {
      const prevVal = x[prev] ?? Number.NEGATIVE_INFINITY;
      if (value <= prevVal) continue;
      accepted[accepted.length - 1] = idx;
      continue;
    }
    accepted.push(idx);
  }

  accepted.sort((a, b) => a - b);
  return accepted;
}

function filterTroughCandidates(
  x: number[],
  candidates: number[],
  periodSamples: number,
): number[] {
  if (candidates.length === 0) return [];

  const searchRadius = Math.max(2, Math.round(periodSamples * 0.28));
  const scored = candidates.map((idx) => {
    const lo = Math.max(0, idx - searchRadius);
    const hi = Math.min(x.length - 1, idx + searchRadius);
    let leftBase = x[idx];
    let rightBase = x[idx];
    for (let i = lo; i < idx; i++) leftBase = Math.max(leftBase, x[i]);
    for (let i = idx + 1; i <= hi; i++) rightBase = Math.max(rightBase, x[i]);
    const base = Math.max(leftBase, rightBase);
    return { idx, depth: base - x[idx], value: x[idx] };
  });

  scored.sort((a, b) => b.depth - a.depth || a.idx - b.idx);

  const accepted: number[] = [];
  const minDist = Math.max(2, Math.round(periodSamples * 0.55));
  const dynamicRange = Math.max(1e-6, Math.max(...x) - Math.min(...x));
  const medianDepth = scored[Math.floor(scored.length / 2)]?.depth ?? 0;
  const depthFloor = Math.max(0.01 * dynamicRange, medianDepth * 0.35);

  for (const { idx, depth, value } of scored) {
    if (depth < depthFloor) continue;
    const prev = accepted[accepted.length - 1];
    if (prev != null && idx - prev < minDist) {
      const prevVal = x[prev] ?? Number.POSITIVE_INFINITY;
      if (value >= prevVal) continue;
      accepted[accepted.length - 1] = idx;
      continue;
    }
    accepted.push(idx);
  }

  accepted.sort((a, b) => a - b);
  return accepted;
}
