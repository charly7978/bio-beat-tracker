/**
 * FRECUENCIA CARDÍACA Y CALIDAD DE RITMO A PARTIR DE LOS PICOS DETECTADOS.
 *
 * Dos principios, ambos por literatura:
 *
 * 1. MEDIANA, no media, sobre los intervalos RR. Un solo latido perdido duplica
 *    un RR y un solo pico espurio lo parte en dos; ambos casos arrastran la
 *    media y dejan la mediana intacta. Es el estimador robusto estándar para
 *    HR a partir de PPG.
 *
 * 2. LA CONSISTENCIA DEL RR ES LA PRUEBA DE VIDA. Un detector de picos encuentra
 *    "picos" en cualquier cosa —incluido ruido filtrado a banda cardíaca, que
 *    oscila igual—, así que el número de picos no dice nada. Lo que el ruido no
 *    puede fabricar es una serie de RR ESTABLE: el corazón late con intervalos
 *    que varían poco entre sí (y cuando varían mucho, lo hacen con estructura,
 *    no al azar). Por eso la publicación se decide con el coeficiente de
 *    variación del RR, no con la amplitud ni con el color del píxel.
 */

/** Rango fisiológico admisible de RR: 30–220 bpm. */
export const RR_MIN_MS = 60000 / 220;
export const RR_MAX_MS = 60000 / 30;

export interface HeartRateEstimate {
  /** 0 si no hay estimación sostenible. */
  bpm: number;
  /** Intervalos RR usados (ms), ya filtrados a rango fisiológico. */
  rrMs: number[];
  /** Coeficiente de variación del RR: la medida de consistencia del ritmo. */
  rrCv: number;
  /** Latidos válidos considerados. */
  beatCount: number;
}

/** Convierte índices de pico a intervalos RR en ms, descartando los no fisiológicos. */
export function rrIntervalsFromPeaks(peaks: number[], fsHz: number): number[] {
  if (peaks.length < 2 || fsHz <= 0) return [];
  const rr: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    const ms = ((peaks[i]! - peaks[i - 1]!) / fsHz) * 1000;
    if (ms >= RR_MIN_MS && ms <= RR_MAX_MS) rr.push(ms);
  }
  return rr;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/**
 * Estima la frecuencia cardíaca. Devuelve bpm = 0 cuando no hay suficientes
 * latidos válidos: sin observación no se inventa un número.
 */
export function estimateHeartRate(peaks: number[], fsHz: number): HeartRateEstimate {
  const rrMs = rrIntervalsFromPeaks(peaks, fsHz);
  if (rrMs.length < 2) {
    return { bpm: 0, rrMs, rrCv: Infinity, beatCount: rrMs.length + (peaks.length ? 1 : 0) };
  }

  const med = median(rrMs);
  if (med <= 0) {
    return { bpm: 0, rrMs, rrCv: Infinity, beatCount: rrMs.length + 1 };
  }

  // Desviación respecto de la MEDIANA (no de la media): un outlier no infla el
  // centro contra el que se mide la dispersión.
  let acc = 0;
  for (const d of rrMs) acc += (d - med) * (d - med);
  const rrCv = Math.sqrt(acc / rrMs.length) / med;

  return { bpm: 60000 / med, rrMs, rrCv, beatCount: rrMs.length + 1 };
}
