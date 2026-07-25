/**
 * DETECTOR DE PICOS SISTÓLICOS — Elgendi et al. 2013.
 *
 * Port fiel de `_ppg_findpeaks_elgendi` de NeuroKit2, que implementa:
 *
 *   Elgendi M, Norton I, Brearley M, Abbott D, Schuurmans D (2013).
 *   "Systolic Peak Detection in Acceleration Photoplethysmograms Measured from
 *   Emergency Responders in Tropical Conditions". PLoS ONE 8(10): e76585.
 *
 * Sensibilidad reportada 99,89 % y predictividad positiva 99,84 % sobre 40
 * registros / 5.071 latidos.
 *
 * EL MÉTODO, en una frase: dos medias móviles de distinta duración —una del
 * ancho de un pico sistólico, otra del ancho de un latido— y se declara latido
 * allí donde la rápida supera a la lenta durante al menos el ancho de un pico.
 * Es un detector de EVENTOS por umbral adaptativo: no asume ritmo regular, así
 * que tolera arritmia, y no depende de amplitud absoluta, así que tolera la
 * deriva de perfusión.
 *
 * PRECONDICIÓN INNEGOCIABLE: la señal debe venir filtrada a 0,5–8 Hz. El
 * algoritmo trabaja sobre el cuadrado de la parte positiva, de modo que
 * cualquier deriva de línea base por debajo de 0,5 Hz domina el cuadrado y
 * arruina el umbral. Ver `butterworth.ts`.
 *
 * Los valores por defecto son los de NeuroKit2. El paper original reporta como
 * óptimos W1=175 ms, W2=1000 ms y α=0; se dejan configurables por eso.
 */

export interface ElgendiParams {
  /** Ancho de la media móvil que realza el PICO sistólico (s). NeuroKit2: 0.111 */
  peakWindowSec: number;
  /** Ancho de la media móvil que realza el LATIDO completo (s). NeuroKit2: 0.667 */
  beatWindowSec: number;
  /** Offset α del umbral, como fracción de la media del cuadrado. NeuroKit2: 0.02 */
  beatOffset: number;
  /** Refractario mínimo entre picos (s). NeuroKit2: 0.3 → 200 bpm máx. */
  minDelaySec: number;
}

export const ELGENDI_DEFAULTS: ElgendiParams = {
  peakWindowSec: 0.111,
  beatWindowSec: 0.667,
  beatOffset: 0.02,
  minDelaySec: 0.3,
};

/**
 * Media móvil de ventana rectangular (boxcar), centrada.
 *
 * NeuroKit2 usa `scipy.signal.convolve(..., mode="same")` con un kernel plano.
 * Se replica con acumulador deslizante: O(n) en vez de O(n·w), lo que importa
 * porque esto corre sobre cada ventana a varios Hz en un teléfono.
 */
export function movingAverage(x: number[], windowSamples: number): number[] {
  const n = x.length;
  const w = Math.max(1, Math.round(windowSamples));
  const out = new Array<number>(n);
  const half = Math.floor(w / 2);

  let sum = 0;
  for (let i = 0; i < Math.min(w, n); i++) sum += x[i]!;

  for (let i = 0; i < n; i++) {
    const start = i - half;
    const end = start + w - 1;
    // Recalcular por bordes es despreciable frente al bucle central.
    if (start < 0 || end >= n) {
      let s = 0;
      let count = 0;
      for (let k = Math.max(0, start); k <= Math.min(n - 1, end); k++) {
        s += x[k]!;
        count++;
      }
      out[i] = count > 0 ? s / count : 0;
      continue;
    }
    if (start === 0) {
      sum = 0;
      for (let k = start; k <= end; k++) sum += x[k]!;
    } else {
      sum += x[end]! - x[start - 1]!;
    }
    out[i] = sum / w;
  }
  return out;
}

/**
 * Detecta picos sistólicos. Devuelve ÍNDICES de muestra dentro de `signal`.
 *
 * @param signal Señal PPG ya filtrada a 0,5–8 Hz (ver precondición arriba).
 * @param fsHz   Frecuencia de muestreo uniforme.
 */
export function findPeaksElgendi(
  signal: number[],
  fsHz: number,
  params: ElgendiParams = ELGENDI_DEFAULTS,
): number[] {
  const n = signal.length;
  if (n < 8 || fsHz <= 0) return [];

  // Paso 1 — "Ignore the samples with negative amplitudes and square the
  // samples with values larger than zero": recorta lo negativo y eleva al
  // cuadrado. El recorte descarta la fase diastólica (que no contiene el
  // flanco buscado) y el cuadrado expande la diferencia entre el pico
  // sistólico y el ruido de fondo.
  const squared = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = signal[i]!;
    squared[i] = v > 0 ? v * v : 0;
  }

  // Paso 2 — dos medias móviles sobre el cuadrado.
  const maPeak = movingAverage(squared, params.peakWindowSec * fsHz);
  const maBeat = movingAverage(squared, params.beatWindowSec * fsHz);

  // Paso 3 — umbral: thr1 = ma_beat + beatoffset · mean(sqrd).
  let meanSquared = 0;
  for (let i = 0; i < n; i++) meanSquared += squared[i]!;
  meanSquared /= n;
  const offset = params.beatOffset * meanSquared;

  // Paso 4 — bloques donde ma_peak supera el umbral; cada bloque suficientemente
  // largo es un latido, y su máximo local es el pico sistólico.
  const minLen = Math.round(params.peakWindowSec * fsHz);
  const minDelay = Math.round(params.minDelaySec * fsHz);

  const peaks: number[] = [];
  let waveStart = -1;

  for (let i = 0; i < n; i++) {
    const above = maPeak[i]! > maBeat[i]! + offset;
    if (above && waveStart < 0) {
      waveStart = i;
    } else if (!above && waveStart >= 0) {
      pushWavePeak(signal, waveStart, i - 1, minLen, minDelay, peaks);
      waveStart = -1;
    }
  }
  // Bloque que llega hasta el final de la ventana.
  if (waveStart >= 0) {
    pushWavePeak(signal, waveStart, n - 1, minLen, minDelay, peaks);
  }

  return peaks;
}

/**
 * Confirma un bloque como latido y añade su máximo si supera el refractario.
 * Bloques más cortos que el ancho de un pico se descartan por construcción del
 * método: no pueden ser una subida sistólica.
 */
function pushWavePeak(
  signal: number[],
  start: number,
  end: number,
  minLen: number,
  minDelay: number,
  peaks: number[],
): void {
  if (end - start + 1 < minLen) return;

  let bestIdx = start;
  let bestVal = signal[start]!;
  for (let k = start + 1; k <= end; k++) {
    const v = signal[k]!;
    if (v > bestVal) {
      bestVal = v;
      bestIdx = k;
    }
  }

  // Refractario: se OMITE el candidato demasiado próximo al anterior, no se
  // sustituye. Sustituir parece más listo pero desplaza un pico ya emitido, lo
  // que parte un intervalo RR en dos (uno larguísimo y uno cortísimo) y arruina
  // la medida de consistencia del ritmo. NeuroKit2 omite, y omitir es correcto.
  const last = peaks.length > 0 ? peaks[peaks.length - 1]! : -Infinity;
  if (bestIdx - last >= minDelay) {
    peaks.push(bestIdx);
  }
}
