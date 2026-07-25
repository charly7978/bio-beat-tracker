/**
 * REMUESTREO A REJILLA UNIFORME.
 *
 * La cámara de un teléfono NO entrega cuadros a intervalo constante: el
 * intervalo real fluctúa con la exposición automática, la carga de la GPU y el
 * planificador del navegador. Es habitual ver 30 fps nominales con jitter de
 * ±15 ms y cuadros perdidos.
 *
 * Todo el análisis posterior —el Butterworth, las ventanas de Elgendi
 * expresadas en segundos, la conversión de RR a bpm— asume muestreo uniforme.
 * Alimentarlo con muestras irregulares desplaza las ventanas efectivas y sesga
 * la frecuencia estimada. Por eso este paso es obligatorio y va ANTES del
 * filtrado, no después.
 *
 * Interpolación lineal: suficiente para una señal ya limitada a <8 Hz muestreada
 * a ~30 Hz (muy por encima de Nyquist), y no introduce el sobreimpulso que un
 * spline puede crear cerca del pico sistólico — un sobreimpulso ahí sería un
 * falso máximo justo donde el detector busca.
 */

export interface TimedSamples {
  values: number[];
  /** Marcas de tiempo en ms, monótonas crecientes. */
  timestampsMs: number[];
}

export interface UniformSignal {
  values: number[];
  fsHz: number;
  startMs: number;
  /** Índice → tiempo absoluto en ms. */
  timeAtIndex: (i: number) => number;
}

/**
 * Remuestrea a una rejilla uniforme cubriendo el intervalo observado.
 *
 * @param targetFsHz Frecuencia destino. Conviene igualarla a la mediana real
 *   observada: subir por encima no añade información y encarece el filtrado.
 */
export function resampleUniform(
  input: TimedSamples,
  targetFsHz: number,
): UniformSignal | null {
  const { values, timestampsMs } = input;
  const n = Math.min(values.length, timestampsMs.length);
  if (n < 4 || targetFsHz <= 0) return null;

  const t0 = timestampsMs[0]!;
  const t1 = timestampsMs[n - 1]!;
  const durationMs = t1 - t0;
  if (durationMs <= 0) return null;

  const count = Math.floor((durationMs / 1000) * targetFsHz) + 1;
  if (count < 4) return null;

  const stepMs = 1000 / targetFsHz;
  const out = new Array<number>(count);

  let j = 0;
  for (let k = 0; k < count; k++) {
    const t = t0 + k * stepMs;
    while (j < n - 2 && timestampsMs[j + 1]! < t) j++;
    const ta = timestampsMs[j]!;
    const tb = timestampsMs[j + 1]!;
    const va = values[j]!;
    const vb = values[j + 1]!;
    const u = tb > ta ? (t - ta) / (tb - ta) : 0;
    out[k] = va + u * (vb - va);
  }

  return {
    values: out,
    fsHz: targetFsHz,
    startMs: t0,
    timeAtIndex: (i: number) => t0 + i * stepMs,
  };
}

/**
 * Frecuencia de muestreo EFECTIVA por mediana de los intervalos.
 *
 * Se usa la mediana y no la media porque un solo cuadro perdido duplica un
 * intervalo y arrastra la media hacia abajo, haciendo creer que la cámara va
 * más lenta de lo que va — y eso desplazaría todas las ventanas temporales.
 */
export function effectiveSampleRate(timestampsMs: number[]): number {
  const n = timestampsMs.length;
  if (n < 3) return 0;
  const deltas: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = timestampsMs[i]! - timestampsMs[i - 1]!;
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return 0;
  deltas.sort((a, b) => a - b);
  const med = deltas[Math.floor(deltas.length / 2)]!;
  return med > 0 ? 1000 / med : 0;
}
