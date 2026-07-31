/**
 * MSPTD — Multi-Scale Peak and Trough Detection.
 *
 * Detector de latidos SIN PARÁMETROS. No tiene umbrales que ajustar, ni
 * ventanas que calibrar, ni offsets que tocar por dispositivo: la escala
 * dominante la descubre de la propia señal.
 *
 * ── Por qué este y no otro ────────────────────────────────────────────────
 *
 * Charlton et al. (2022) compararon 15 detectores de latidos de código abierto
 * contra latidos derivados de ECG, sobre 8 datasets. MSPTD y qppg quedaron
 * primeros, con características complementarias. F1 ≥ 90 % en reposo; 55–91 %
 * en movimiento; 98–99 % en adultos con ritmo sinusal.
 *
 * ── Cómo funciona ─────────────────────────────────────────────────────────
 *
 * Construye un ESCALOGRAMA DE MÁXIMOS LOCALES (LMS): una matriz N×S donde la
 * entrada (k, i) dice si la muestra i es mayor que sus vecinas a distancia k.
 *
 *   LMS[k][i] = 1  si  x[i] > x[i−k]  y  x[i] > x[i+k]
 *
 * Una muestra que es máximo local a MUCHAS escalas distintas es un pico
 * estructural (un latido). Una que solo lo es a escala 1 es ruido.
 *
 * La clave —y el motivo de que no necesite parámetros— es que la escala
 * característica se DEDUCE: se elige la fila `d` con más máximos locales, que
 * corresponde al medio periodo dominante de la señal. Después se declaran picos
 * las muestras que son máximo local en TODAS las escalas hasta `d`.
 *
 * ── Diferencias con el original ───────────────────────────────────────────
 *
 * Bishop & Ercole (2018) refinaron AMPD (Scholkmann 2012) usando valores
 * binarios en vez de números aleatorios, y detectando picos y valles. Aquí se
 * implementa esa versión binaria.
 *
 * Referencias:
 *  - Bishop, S. M., & Ercole, A. (2018). "Multi-scale peak and trough detection
 *    optimised for periodic and quasi-periodic neuroscience data."
 *    Acta Neurochirurgica Supplement.
 *  - Charlton, P. H. et al. (2022). "Detecting beats in the photoplethysmogram:
 *    benchmarking open-source algorithms." Physiological Measurement 43(8).
 *    DOI 10.1088/1361-6579/ac826d
 *  - Scholkmann, F. et al. (2012). "An efficient algorithm for automatic peak
 *    detection in noisy periodic and quasi-periodic signals." Algorithms 5(4).
 */

export interface MsptdResult {
  /** Índices de picos (máximos sistólicos), en orden ascendente. */
  peaks: number[];
  /** Índices de valles (onsets), en orden ascendente. */
  troughs: number[];
  /**
   * Escala dominante hallada, en muestras. Corresponde aproximadamente al medio
   * periodo cardíaco: `2 * scale / fs` ≈ intervalo RR en segundos.
   * 0 si no se pudo determinar.
   */
  dominantScale: number;
}

/** Muestras mínimas para que el escalograma tenga sentido. */
const MIN_SAMPLES = 30;

/**
 * Detecta picos y valles por escalograma de máximos locales.
 *
 * @param signal Señal PPG filtrada, en orden cronológico.
 * @param maxScale Escala máxima a explorar, en muestras. Por defecto N/2, que
 *   es el límite del método (una escala mayor no tiene vecinos a ambos lados
 *   para ninguna muestra). Acotarla a la banda cardíaca esperada reduce coste
 *   sin cambiar el resultado.
 */
export function detectMsptd(
  signal: readonly number[],
  maxScale?: number,
): MsptdResult {
  const n = signal.length;
  const empty: MsptdResult = { peaks: [], troughs: [], dominantScale: 0 };
  if (n < MIN_SAMPLES) return empty;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(signal[i])) return empty;
  }

  // Detrend lineal. El escalograma compara vecinos a distancia creciente, así
  // que una deriva monótona haría que las muestras tardías "ganen" a las
  // tempranas por tendencia y no por forma de pulso.
  const x = detrend(signal);

  const L = Math.floor(n / 2);
  const S = Math.max(1, Math.min(maxScale ?? L, L));

  // Recuento de máximos/mínimos locales por escala. No se materializa la matriz
  // N×S completa: para hallar la escala dominante basta el recuento por fila, y
  // luego se re-evalúan las escalas ≤ d. Coste O(N·S) en tiempo, O(S) en memoria.
  const peakCountByScale = new Int32Array(S + 1);
  const troughCountByScale = new Int32Array(S + 1);

  for (let k = 1; k <= S; k++) {
    let pc = 0;
    let tc = 0;
    for (let i = k; i < n - k; i++) {
      const v = x[i];
      if (v > x[i - k] && v > x[i + k]) pc++;
      else if (v < x[i - k] && v < x[i + k]) tc++;
    }
    peakCountByScale[k] = pc;
    troughCountByScale[k] = tc;
  }

  // Escala dominante = la de mayor número de máximos locales. En una señal
  // cuasi-periódica coincide con el medio periodo: por debajo, el ruido añade
  // máximos espurios; por encima, los latidos vecinos se eliminan entre sí.
  const d = argMax(peakCountByScale, S);
  if (d === 0) return empty;

  return {
    peaks: extremaUpToScale(x, d, 'peak'),
    troughs: extremaUpToScale(x, argMax(troughCountByScale, S) || d, 'trough'),
    dominantScale: d,
  };
}

/**
 * Muestras que son extremo local en TODAS las escalas de 1 a `d`.
 * Ese es el criterio de MSPTD: sobrevivir a todas las escalas hasta la dominante.
 */
function extremaUpToScale(
  x: readonly number[],
  d: number,
  kind: 'peak' | 'trough',
): number[] {
  const n = x.length;
  const out: number[] = [];
  const isPeak = kind === 'peak';

  for (let i = d; i < n - d; i++) {
    const v = x[i];
    let survives = true;
    for (let k = 1; k <= d; k++) {
      const ok = isPeak
        ? v > x[i - k] && v > x[i + k]
        : v < x[i - k] && v < x[i + k];
      if (!ok) {
        survives = false;
        break;
      }
    }
    if (survives) out.push(i);
  }
  return out;
}

function argMax(counts: Int32Array, upTo: number): number {
  let best = 0;
  let bestVal = -1;
  for (let k = 1; k <= upTo; k++) {
    if (counts[k] > bestVal) {
      bestVal = counts[k];
      best = k;
    }
  }
  return bestVal > 0 ? best : 0;
}

/** Resta la recta de mínimos cuadrados. */
function detrend(signal: readonly number[]): number[] {
  const n = signal.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += signal[i];
    sumXY += i * signal[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return [...signal];
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = signal[i] - (slope * i + intercept);
  return out;
}

/**
 * Intervalos RR en ms a partir de los picos, filtrados a rango fisiológico.
 *
 * @param peaks Índices de pico.
 * @param sampleRateHz Frecuencia de muestreo real.
 */
export function rrIntervalsFromPeaks(
  peaks: readonly number[],
  sampleRateHz: number,
  minRrMs = 270,
  maxRrMs = 2200,
): number[] {
  if (peaks.length < 2 || !(sampleRateHz > 0)) return [];
  const msPerSample = 1000 / sampleRateHz;
  const out: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    const rr = (peaks[i] - peaks[i - 1]) * msPerSample;
    if (rr >= minRrMs && rr <= maxRrMs) out.push(rr);
  }
  return out;
}
