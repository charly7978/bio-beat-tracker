/**
 * GENERATIVE PULSE MODEL — predictive coding del pulso cardíaco.
 *
 * En vez de puntuar features y decidir "hay latido / no hay latido", este
 * modelo mantiene una PLANTILLA de la forma de onda de un latido (un modelo
 * generativo) y con ella PREDICE la señal observada. La calidad de esa
 * predicción es la medida de "comprensión":
 *
 *   - Un dedo vivo produce ciclos repetibles → la plantilla los reconstruye →
 *     error de predicción bajo y varianza explicada alta.
 *   - Un objeto (o ruido) no tiene estructura de pulso repetible → ninguna
 *     plantilla lo explica → error alto, varianza explicada ~0.
 *
 * El "no hay señal" emerge de la INCAPACIDAD del modelo de explicar la señal,
 * no de un umbral duro. La plantilla se aprende y adapta entre ventanas
 * (EMA con alineación circular de fase), de modo que el modelo "aprende" la
 * morfología del pulso del usuario.
 *
 * Referencias: modelado predictivo pulso-a-pulso para PPG (predicción del ciclo
 * siguiente a partir de ciclos previos, R²>0.9 en literatura 2024–2025) y SQI
 * por template-matching adaptativo (correlación ciclo↔plantilla, Elgendi/Orphanidou).
 */
import { clamp } from '../../utils/math';
import { detrendLinear } from '../../modules/signal-processing/shared/dsp';
import type { GenerativePulseDiagnostics } from './types';

/** Nº de bins de fase de la plantilla (resolución de un ciclo cardíaco). */
const PHASE_BINS = 48;
/** EMA de aprendizaje de la plantilla persistente entre ventanas. */
const TEMPLATE_LEARN_ALPHA = 0.2;
/** Consistencia morfológica mínima para actualizar la plantilla persistente. */
const TEMPLATE_UPDATE_MIN_CONSISTENCY = 0.5;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i]!;
  return s / values.length;
}

/** Correlación de Pearson entre dos vectores de igual longitud. */
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i]! - ma;
    const xb = b[i]! - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da < 1e-12 || db < 1e-12) return 0;
  return clamp(num / Math.sqrt(da * db), -1, 1);
}

export class GenerativePulseModel {
  /** Plantilla persistente aprendida del pulso (fase-binned). */
  private template: number[] | null = null;
  /** Confianza acumulada en la plantilla persistente (0–1). */
  private templateConfidence = 0;

  reset(): void {
    this.template = null;
    this.templateConfidence = 0;
  }

  /**
   * Analiza una ventana de PPG filtrada dado un periodo estimado (en muestras).
   * Devuelve el diagnóstico de predicción y actualiza la plantilla aprendida.
   */
  analyze(filtered: number[], periodSamples: number): GenerativePulseDiagnostics {
    const n = filtered.length;
    const invalidPeriod = !Number.isFinite(periodSamples) || periodSamples < 6 || periodSamples > n / 2;
    if (n < 16 || invalidPeriod) {
      this.decayConfidence();
      return {
        predictionError: 1,
        explainedVariance: 0,
        morphologyLikelihood: 0,
        cycleCount: 0,
        templateStability: this.templateConfidence,
      };
    }

    const signal = detrendLinear(filtered);
    const sigMean = mean(signal);
    const centered = signal.map((v) => v - sigMean);

    // --- Plegado de fase: acumular la señal en bins según la fase del ciclo ---
    const binSum = new Array<number>(PHASE_BINS).fill(0);
    const binCount = new Array<number>(PHASE_BINS).fill(0);
    const phaseOf = (i: number): number => {
      const frac = (i / periodSamples) % 1;
      const bin = Math.floor(frac * PHASE_BINS);
      return bin >= PHASE_BINS ? PHASE_BINS - 1 : bin;
    };
    for (let i = 0; i < n; i++) {
      const bin = phaseOf(i);
      binSum[bin]! += centered[i]!;
      binCount[bin]! += 1;
    }
    // Plantilla de esta ventana (mejor explicación periódica de los datos).
    const windowTemplate = new Array<number>(PHASE_BINS);
    for (let b = 0; b < PHASE_BINS; b++) {
      windowTemplate[b] = binCount[b]! > 0 ? binSum[b]! / binCount[b]! : 0;
    }

    // --- Varianza explicada: predecir cada muestra desde la plantilla ---
    let ssRes = 0;
    let ssTot = 0;
    for (let i = 0; i < n; i++) {
      const pred = windowTemplate[phaseOf(i)]!;
      const resid = centered[i]! - pred;
      ssRes += resid * resid;
      ssTot += centered[i]! * centered[i]!;
    }
    const explainedVariance = ssTot < 1e-12 ? 0 : clamp(1 - ssRes / ssTot, 0, 1);
    const sigStd = Math.sqrt(ssTot / n);
    const predictionError = sigStd < 1e-9 ? 1 : clamp(Math.sqrt(ssRes / n) / sigStd, 0, 1);

    // --- Consistencia morfológica: correlación de cada ciclo con la plantilla ---
    const cycleCount = Math.floor(n / periodSamples);
    let corrSum = 0;
    let corrN = 0;
    for (let c = 0; c < cycleCount; c++) {
      const start = Math.round(c * periodSamples);
      const end = Math.round((c + 1) * periodSamples);
      if (end - start < 6 || end > n) continue;
      // Re-muestrear el ciclo a PHASE_BINS para comparar con la plantilla.
      const cyc = new Array<number>(PHASE_BINS);
      for (let b = 0; b < PHASE_BINS; b++) {
        const idx = start + Math.floor(((b + 0.5) / PHASE_BINS) * (end - start));
        cyc[b] = centered[Math.min(idx, n - 1)]!;
      }
      corrSum += pearson(cyc, windowTemplate);
      corrN += 1;
    }
    const morphologyLikelihood = corrN > 0 ? clamp(corrSum / corrN, 0, 1) : 0;

    // --- Aprendizaje de la plantilla persistente (identidad del pulso) ---
    const templateStability = this.updatePersistentTemplate(windowTemplate, morphologyLikelihood);

    return {
      predictionError,
      explainedVariance,
      morphologyLikelihood,
      cycleCount,
      templateStability,
    };
  }

  /**
   * Actualiza la plantilla persistente por EMA, alineando la fase por
   * correlación circular. Devuelve la estabilidad (correlación con la plantilla
   * previa alineada), que mide cuán consistente es la forma del pulso en el tiempo.
   */
  private updatePersistentTemplate(windowTemplate: number[], consistency: number): number {
    if (consistency < TEMPLATE_UPDATE_MIN_CONSISTENCY) {
      this.decayConfidence();
      return this.templateConfidence;
    }
    if (this.template === null) {
      this.template = windowTemplate.slice();
      this.templateConfidence = consistency * 0.5;
      return this.templateConfidence;
    }
    // Alinear la nueva plantilla a la persistente por mejor rotación circular.
    let bestShift = 0;
    let bestCorr = -Infinity;
    for (let shift = 0; shift < PHASE_BINS; shift++) {
      const rotated = new Array<number>(PHASE_BINS);
      for (let b = 0; b < PHASE_BINS; b++) rotated[b] = windowTemplate[(b + shift) % PHASE_BINS]!;
      const corr = pearson(rotated, this.template);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestShift = shift;
      }
    }
    const aligned = new Array<number>(PHASE_BINS);
    for (let b = 0; b < PHASE_BINS; b++) aligned[b] = windowTemplate[(b + bestShift) % PHASE_BINS]!;
    for (let b = 0; b < PHASE_BINS; b++) {
      this.template[b] = (1 - TEMPLATE_LEARN_ALPHA) * this.template[b]! + TEMPLATE_LEARN_ALPHA * aligned[b]!;
    }
    const stability = clamp(bestCorr, 0, 1);
    this.templateConfidence = clamp(0.85 * this.templateConfidence + 0.15 * stability, 0, 1);
    return this.templateConfidence;
  }

  private decayConfidence(): void {
    this.templateConfidence *= 0.9;
    if (this.templateConfidence < 0.02) {
      this.template = null;
      this.templateConfidence = 0;
    }
  }
}
