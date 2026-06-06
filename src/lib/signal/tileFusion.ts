import { clamp } from '@/utils/math';
import { detrendLinear } from '@/modules/signal-processing/shared/dsp';

/**
 * FUSIÓN ADAPTATIVA MULTI-CELDA POR PULSATILIDAD (Tiling & Aggregation).
 *
 * Estado del arte para PPG por cámara (Sensors/MDPI 2017, R2I-rPPG 2024, PMC
 * 2023): la ROI no capta igual en toda su superficie — unas celdas tienen pulso
 * fuerte, otras están saturadas, opacas o en el borde. En vez de promediar TODO
 * por igual (lo que diluye el pulso y exige colocación exacta), se PUNTÚA cada
 * celda por su PULSATILIDAD real y se fusiona dando más peso a las mejores.
 *
 * Esto "favorece la colocación del dedo": el sistema BUSCA solo la mejor zona,
 * esté donde esté el dedo, y optimiza la SNR de la señal inicial.
 */

/**
 * Pulsatilidad de una celda = amplitud AC (banda cardíaca) / DC, robusta.
 * Detrend lineal (quita deriva lenta) + rango p90−p10 (robusto a outliers) sobre
 * la media (≈ índice de perfusión de la celda). Mayor = pulso más fuerte ahí.
 * Devuelve 0 si no hay datos suficientes (→ fallback al peso por presencia).
 */
export function tilePulsatility(greenSamples: number[]): number {
  const n = greenSamples.length;
  if (n < 8) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += greenSamples[i]!;
  mean /= n;
  if (mean <= 1) return 0;

  const det = detrendLinear(greenSamples);
  const sorted = [...det].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(n * 0.1)] ?? 0;
  const p90 = sorted[Math.floor(n * 0.9)] ?? 0;
  const ac = Math.max(0, p90 - p10);
  return ac / mean;
}

/**
 * Factor de realce del peso de una celda según su pulsatilidad RELATIVA a la mejor.
 * La celda con mejor pulso (norm=1) → (1+gain); la peor (norm=0) → 1. Si no hay
 * info de pulsatilidad (maxPulsatility≈0, p.ej. arranque) → 1 (neutro = comportamiento
 * actual, fallback seguro).
 */
export function pulsatilityBoost(
  pulsatility: number,
  maxPulsatility: number,
  gain: number,
): number {
  if (maxPulsatility <= 1e-9) return 1;
  const norm = clamp(pulsatility / maxPulsatility, 0, 1);
  // Mapeo sigmoidal: comprime los pesos bajos (tiles ruidosos) y expande los altos
  // (mejores tiles). Transición más nítida que lineal → mejor SNR de fusión.
  const s = 1 / (1 + Math.exp(-5 * (norm - 0.5)));
  const s0 = 1 / (1 + Math.exp(2.5));
  const sNorm = (s - s0) / (1 - 2 * s0);
  return 1 + gain * sNorm;
}

/**
 * Suavizado temporal de pesos por tile (EMA frame a frame). Evita cambios bruscos
 * de contribución entre frames consecutivos que producirían artefactos audibles en
 * la señal fusionada (chirridos/click). Se usa en el hot path de extractROI.
 */
export interface TileWeightSmoother {
  weights: Float64Array;
  alpha: number;
}

export function createWeightSmoother(numTiles: number, alpha = 0.35): TileWeightSmoother {
  return { weights: new Float64Array(numTiles), alpha };
}

export function smoothTileWeights(
  sm: TileWeightSmoother,
  rawWeights: Float64Array | number[],
): Float64Array {
  const a = sm.alpha;
  const ia = 1 - a;
  const out = sm.weights;
  for (let i = 0; i < out.length; i++) {
    out[i] = out[i] * ia + (rawWeights[i] ?? 0) * a;
  }
  return out;
}
