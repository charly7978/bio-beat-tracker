/**
 * Consistencia morfológica latido-a-latido (template matching).
 *
 * Discriminador fuerte de PULSO HUMANO REAL frente a ruido pseudo-periódico:
 * un tren de latidos cardíacos repite la MISMA forma de onda ciclo a ciclo
 * (subida sistólica abrupta + caída diastólica + escotadura), mientras que el
 * ruido de un objeto inerte, el flicker de exposición o un artefacto de
 * movimiento NO mantienen una morfología coherente aunque tengan algo de
 * periodicidad. Se construye una plantilla promedio de latido y se mide la
 * correlación media de cada ciclo con ella (índice de auto-similitud, 0..1).
 *
 * Base: la self-similarity / template-matching es uno de los índices de calidad
 * de señal PPG más robustos (Orphanidou 2015; Elgendi 2016; feature-selection
 * SQA 2022). Aquí se usa como evidencia de PRESENCIA de pulso, no solo calidad.
 */

/** Detecta índices de pico (máximos locales) espaciados ~un periodo cardíaco. */
export function detectBeatPeaks(
  signal: number[],
  approxPeriod: number,
): number[] {
  const n = signal.length;
  const peaks: number[] = [];
  if (n < 3 || approxPeriod < 2) return peaks;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = signal[i] - mean;
    variance += d * d;
  }
  const std = Math.sqrt(variance / n);
  // Un pico sistólico real sobresale claramente de la media; el umbral escala
  // con la dispersión de la ventana (robusto a la amplitud absoluta).
  const threshold = mean + std * 0.35;
  // Distancia mínima entre picos = 55% del periodo esperado → evita contar la
  // muesca dicrótica o el ruido como latidos separados.
  const minDist = Math.max(2, Math.floor(approxPeriod * 0.55));
  const radius = Math.max(1, Math.floor(approxPeriod * 0.25));

  for (let i = 1; i < n - 1; i++) {
    const v = signal[i];
    if (v < threshold) continue;
    let isLocalMax = true;
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    for (let j = lo; j <= hi; j++) {
      if (signal[j] > v) {
        isLocalMax = false;
        break;
      }
    }
    if (!isLocalMax) continue;
    const last = peaks[peaks.length - 1];
    if (last !== undefined && i - last < minDist) {
      // Conserva el mayor de dos picos demasiado próximos.
      if (v > signal[last]) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }
  return peaks;
}

/** Correlación de Pearson entre dos segmentos de igual longitud. */
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da <= 1e-12 || db <= 1e-12) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * Índice de auto-similitud latido-a-latido [0..1]. Devuelve 0 si no hay al
 * menos 3 latidos detectables (evidencia insuficiente para afirmar pulso).
 */
export function beatTemplateConsistency(
  signal: number[],
  fs: number,
  bpm: number,
): number {
  if (bpm <= 0 || fs <= 0 || signal.length < fs) return 0;
  const period = (60 * fs) / bpm;
  const peaks = detectBeatPeaks(signal, period);
  if (peaks.length < 3) return 0;

  // Segmento centrado en cada pico, longitud = un periodo completo.
  const half = Math.floor(period * 0.5);
  const segLen = half * 2;
  if (segLen < 4) return 0;

  const segments: number[][] = [];
  for (const p of peaks) {
    const start = p - half;
    const end = p + half;
    if (start < 0 || end >= signal.length) continue;
    const seg = new Array<number>(segLen);
    for (let i = 0; i < segLen; i++) seg[i] = signal[start + i];
    segments.push(seg);
  }
  if (segments.length < 3) return 0;

  // Plantilla = promedio punto a punto de todos los segmentos.
  const template = new Array<number>(segLen).fill(0);
  for (const seg of segments) {
    for (let i = 0; i < segLen; i++) template[i] += seg[i];
  }
  for (let i = 0; i < segLen; i++) template[i] /= segments.length;

  // Correlación media de cada latido con la plantilla.
  let sum = 0;
  for (const seg of segments) sum += pearson(seg, template);
  const mean = sum / segments.length;
  return mean < 0 ? 0 : mean > 1 ? 1 : mean;
}
