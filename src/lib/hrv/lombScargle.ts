/**
 * LOMB-SCARGLE PERIODOGRAM — para series RR no uniformes (Task Force 1996 gold standard).
 *
 * El periodograma de Lomb-Scargle está diseñado para series temporales con muestreo
 * desigual (RR intervals). A diferencia de la FFT que requiere interpolación previa
 * (que introduce error espectral), Lomb-Scargle evalúa la potencia espectral
 * DIRECTAMENTE en los instantes de tiempo reales de cada latido.
 *
 * Referencias:
 *   - Lomb (1976), Scargle (1982)
 *   - Task Force of ESC/NASPE (1996) — Heart Rate Variability Standards
 *   - Laguna et al. (1998) — "Power spectral density of unevenly sampled data"
 *       https://doi.org/10.1109/10.661160
 *   - Clifford & Tarassenko (2005) — "Quantifying errors in spectral estimates of HRV"
 */

export interface LombScargleResult {
  /** Frecuencias evaluadas (Hz) */
  frequencies: Float64Array;
  /** Potencia espectral (ms²) en cada frecuencia */
  power: Float64Array;
  /** Potencia total integrada (ms²) */
  totalPower: number;
  /** Potencia en banda VLF (0.003–0.04 Hz) */
  vlf: number;
  /** Potencia en banda LF (0.04–0.15 Hz) */
  lf: number;
  /** Potencia en banda HF (0.15–0.40 Hz) */
  hf: number;
  /** LF/HF ratio */
  lfHfRatio: number;
  /** Potencia LF normalizada (n.u.) */
  lfNu: number;
  /** Potencia HF normalizada (n.u.) */
  hfNu: number;
  /** Frecuencia pico en banda LF (Hz) */
  peakLfHz: number;
  /** Frecuencia pico en banda HF (Hz) */
  peakHfHz: number;
}

/**
 * Lomb-Scargle periodogram para intervalos RR.
 *
 * @param t  - Tiempos de cada latido (ms), ej. [0, 800, 1520, 2210, ...]
 * @param y  - Intervalos RR (ms), ej. [800, 720, 690, ...]
 * @param fMin - Frecuencia mínima (Hz), default 0.003 (VLF lower bound)
 * @param fMax - Frecuencia máxima (Hz), default 0.50 (HF upper bound)
 * @param nFreqs - Número de frecuencias a evaluar
 */
export function lombScargleHrv(
  t: number[],
  y: number[],
  fMin = 0.003,
  fMax = 0.50,
  nFreqs = 256,
): LombScargleResult {
  const n = Math.min(t.length, y.length);
  if (n < 6) {
    const empty = { frequencies: new Float64Array(0), power: new Float64Array(0), totalPower: 0, vlf: 0, lf: 0, hf: 0, lfHfRatio: 0, lfNu: 0, hfNu: 0, peakLfHz: 0, peakHfHz: 0 };
    return empty;
  }

  // Centrar los datos: restar media
  let sum = 0;
  for (let i = 0; i < n; i++) sum += y[i];
  const mean = sum / n;
  const centered = new Float64Array(n);
  for (let i = 0; i < n; i++) centered[i] = y[i] - mean;

  // Tiempos normalizados a segundos
  const ts = new Float64Array(n);
  for (let i = 0; i < n; i++) ts[i] = t[i] / 1000;

  // Duración total del registro (segundos)
  const T = ts[n - 1] - ts[0];
  if (T <= 0) return emptyResult;

  // Resolución frecuencial mínima: 1/T
  // Oversampling factor ~4 para suavizar el periodograma
  const df = Math.max(fMin, 1 / T) / 4;
  const nFreq = Math.min(nFreqs, Math.max(32, Math.round((fMax - fMin) / df)));

  const freqs = new Float64Array(nFreq);
  const pxx = new Float64Array(nFreq);

  let vlf = 0, lf = 0, hf = 0;
  let maxLfPower = 0, maxHfPower = 0;
  let peakLfHz = 0, peakHfHz = 0;

  for (let k = 0; k < nFreq; k++) {
    const f = fMin + (fMax - fMin) * k / (nFreq - 1);
    freqs[k] = f;

    // Lomb-Scargle: P(f) = (1/2σ²) [ (Σ y cos(2πf(t-τ)))² / Σ cos²(2πf(t-τ)) + (Σ y sin(2πf(t-τ)))² / Σ sin²(2πf(t-τ)) ]
    let sumCos = 0, sumSin = 0;
    let sumCos2 = 0, sumSin2 = 0;

    // τ = (1/4πf) arctan( Σ sin(4πf t) / Σ cos(4πf t) )
    let sumSin2ft = 0, sumCos2ft = 0;
    for (let i = 0; i < n; i++) {
      const theta = 2 * Math.PI * f * ts[i];
      sumSin2ft += Math.sin(2 * theta);
      sumCos2ft += Math.cos(2 * theta);
    }
    const tau = Math.atan2(sumSin2ft, sumCos2ft) / (4 * Math.PI * f);

    for (let i = 0; i < n; i++) {
      const theta = 2 * Math.PI * f * (ts[i] - tau);
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      sumCos += centered[i] * c;
      sumSin += centered[i] * s;
      sumCos2 += c * c;
      sumSin2 += s * s;
    }

    let power = 0;
    if (sumCos2 > 0 && sumSin2 > 0) {
      power = (sumCos * sumCos / sumCos2 + sumSin * sumSin / sumSin2) / 2;
    }
    pxx[k] = power;

    if (f >= 0.003 && f < 0.04) vlf += power;
    if (f >= 0.04 && f < 0.15) {
      lf += power;
      if (power > maxLfPower) { maxLfPower = power; peakLfHz = f; }
    }
    if (f >= 0.15 && f <= 0.40) {
      hf += power;
      if (power > maxHfPower) { maxHfPower = power; peakHfHz = f; }
    }
  }

  const totalPower = vlf + lf + hf;
  const lfHfRatio = hf > 0 ? lf / hf : 0;
  const lfNu = (lf + hf) > 0 ? lf / (lf + hf) : 0;
  const hfNu = (lf + hf) > 0 ? hf / (lf + hf) : 0;

  return {
    frequencies: freqs, power: pxx, totalPower, vlf, lf, hf, lfHfRatio, lfNu, hfNu,
    peakLfHz, peakHfHz,
  };
}

const emptyResult: LombScargleResult = {
  frequencies: new Float64Array(0), power: new Float64Array(0),
  totalPower: 0, vlf: 0, lf: 0, hf: 0, lfHfRatio: 0, lfNu: 0, hfNu: 0,
  peakLfHz: 0, peakHfHz: 0,
};
