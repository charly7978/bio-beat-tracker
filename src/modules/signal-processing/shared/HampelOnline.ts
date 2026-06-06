/**
 * IDENTIFICADOR HAMPEL ONLINE — Detección y reemplazo de outliers frame-a-frame.
 *
 * Mantiene una ventana circular de N muestras y aplica el criterio Hampel:
 *   - Calcula la mediana y MAD (Median Absolute Deviation) de la ventana
 *   - Si |x - mediana| > nSigma × 1.4826 × MAD → reemplaza x por la mediana
 *
 * Ventajas vs. hampel1D (offline):
 *   - Stateful: no requiere buffer completo de señal previo
 *   - O(N) por frame (N = ventana, típicamente 5-11 muestras)
 *   - Sin asignaciones dinámicas en hot path (array preasignado en createHampelState)
 *
 * Inspirado en: Hampel 1974 / Davies & Gather 1993 / implementación NIH 2024
 * para detección online de artefactos impulsivos en ECG/PPG.
 */

export interface HampelOnlineState {
  /** Buffer circular de muestras (preasignado) */
  readonly buf: Float64Array;
  /** Índice del próximo slot a escribir */
  head: number;
  /** Cantidad de muestras cargadas (≤ windowSize) */
  count: number;
  /** Tamaño de la ventana (impar recomendado, p.ej. 5, 7, 9, 11) */
  readonly windowSize: number;
  /** Buffer auxiliar para cálculo de mediana/MAD (preasignado) */
  readonly sortBuf: Float64Array;
}

/**
 * Crea estado inicial para el Hampel online.
 * @param windowSize Tamaño de la ventana. Impar y ≥ 3.
 */
export function createHampelState(windowSize: number): HampelOnlineState {
  const w = Math.max(3, windowSize % 2 === 0 ? windowSize + 1 : windowSize);
  return {
    buf: new Float64Array(w),
    head: 0,
    count: 0,
    windowSize: w,
    sortBuf: new Float64Array(w),
  };
}

/**
 * Aplica el identificador Hampel online a una nueva muestra.
 *
 * @param state   Estado stateful (mutado in-place)
 * @param value   Muestra de entrada (del frame actual)
 * @param nSigma  Umbral de sigma (por defecto 3.0 — conservador para PPG)
 * @returns       Muestra de salida: la original si no es outlier, o la mediana si lo es.
 */
export function applyHampelOnline(
  state: HampelOnlineState,
  value: number,
  nSigma = 3.0,
): number {
  if (!Number.isFinite(value)) return 0;

  // Insertar en buffer circular
  state.buf[state.head] = value;
  state.head = (state.head + 1) % state.windowSize;
  if (state.count < state.windowSize) state.count++;

  // Con menos de 3 muestras no hay estadística robusta
  if (state.count < 3) return value;

  const n = state.count;

  // Copiar ventana válida al buffer auxiliar para ordenar sin afectar el circular
  // (La ventana está almacenada en orden de inserción — basta copiar `n` elementos)
  for (let i = 0; i < n; i++) {
    const idx = (state.head - n + i + state.windowSize * 2) % state.windowSize;
    state.sortBuf[i] = state.buf[idx]!;
  }

  // Ordenar los primeros `n` elementos del sortBuf (insertion sort — N ≤ 11, O(N²) aceptable)
  insertionSort(state.sortBuf, n);

  const mid = Math.floor(n / 2);
  const median = state.sortBuf[mid]!;

  // MAD: mediana de |x - mediana|
  for (let i = 0; i < n; i++) {
    state.sortBuf[i] = Math.abs(state.sortBuf[i]! - median);
  }
  insertionSort(state.sortBuf, n);
  const mad = state.sortBuf[mid]!;

  // Umbral Hampel: nSigma × 1.4826 × MAD  (1.4826 = consistencia con Normal)
  const threshold = nSigma * 1.4826 * mad;

  // Si MAD ≈ 0 (señal constante), cualquier desviación de la mediana es outlier.
  // No retornar sin verificar: |value - median| > 0 cuando MAD=0 → es outlier.
  if (threshold < 1e-12) {
    return Math.abs(value - median) > 1e-10 ? median : value;
  }

  return Math.abs(value - median) > threshold ? median : value;
}

/** Reinicia el estado del Hampel (nueva sesión de contacto). */
export function resetHampelState(state: HampelOnlineState): void {
  state.buf.fill(0);
  state.sortBuf.fill(0);
  state.head = 0;
  state.count = 0;
}

// ─── helpers internos ────────────────────────────────────────────────────────

/** Insertion sort in-place sobre los primeros `n` elementos de `arr`. */
function insertionSort(arr: Float64Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const key = arr[i]!;
    let j = i - 1;
    while (j >= 0 && arr[j]! > key) {
      arr[j + 1] = arr[j]!;
      j--;
    }
    arr[j + 1] = key;
  }
}
