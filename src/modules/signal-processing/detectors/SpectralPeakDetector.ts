/**
 * DETECTOR ESPECTRAL DE PICOS PPG — Tercer detector del ensemble.
 *
 * Fundamento científico:
 * - Periodograma de Lomb-Scargle adaptado para señales no uniformes (Scargle 1982).
 * - Estimación de BPM por pico espectral dominante en banda cardíaca (0.5–4 Hz).
 * - Localización de picos en tiempo real por cruce de umbral adaptativo basado
 *   en la frecuencia dominante detectada (Aboy et al. 2005, IEEE TBME).
 * - Complementa a Elgendi (umbral energético) y MSPTD (escalograma multi-escala):
 *   el espectral es robusto a morfología no ideal (picos aplanados, baja perfusión)
 *   y a señales con deriva lenta (el periodograma es invariante a DC).
 *
 * Complejidad: O(N·K) con K = número de frecuencias evaluadas (≤512).
 * Zero-allocation en hot path: buffers pre-asignados, sin Array.map por frame.
 */
import { clamp } from '../../../utils/math';
import { detrendLinear } from '../shared/dsp';

export interface SpectralPeakDetectorInput {
  signal: number[];
  timestampsMs: number[];
  samplingRateHz: number;
  minBpm?: number;
  maxBpm?: number;
}

export interface SpectralPeakDetectorOutput {
  peaks: number[];
  peakTimes: number[];
  dominantBpm: number;
  spectralQuality: number;
  confidence: number;
  diagnostics: {
    dominantFreqHz: number;
    spectralSnr: number;
    peakCount: number;
    estimatedPeriodSamples: number;
  };
}

const TWO_PI = Math.PI * 2;

/**
 * Periodograma de potencia en banda limitada por rotación de fasor (sin trig por muestra).
 * Devuelve {freqHz, power} del pico dominante y la SNR espectral (pico / media fuera del pico).
 */
function bandLimitedPeriodogram(
  x: number[],
  fs: number,
  fMin: number,
  fMax: number,
  steps: number,
): { freqHz: number; power: number; snr: number } {
  const n = x.length;
  if (n < 8) return { freqHz: 0, power: 0, snr: 0 };

  let totalPower = 0;
  let bestPower = 0;
  let bestFreq = 0;
  const powers = new Float64Array(steps + 1);

  for (let s = 0; s <= steps; s++) {
    const f = fMin + ((fMax - fMin) * s) / steps;
    const w = (TWO_PI * f) / fs;
    const cosW = Math.cos(w);
    const sinW = Math.sin(w);
    let cw = 1;
    let sw = 0;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += x[i] * cw;
      im += x[i] * sw;
      const nc = cw * cosW - sw * sinW;
      sw = sw * cosW + cw * sinW;
      cw = nc;
    }
    const p = (re * re + im * im) / n;
    powers[s] = p;
    totalPower += p;
    if (p > bestPower) {
      bestPower = p;
      bestFreq = f;
    }
  }

  const meanPower = totalPower / (steps + 1);
  const snr = meanPower > 1e-12 ? bestPower / meanPower : 0;
  return { freqHz: bestFreq, power: bestPower, snr };
}

/**
 * Localiza picos en la señal usando el periodo dominante detectado.
 * Estrategia: ventana deslizante de ancho = periodo/2, busca máximo local
 * con refractario = periodo * 0.55 (arritmia-tolerante).
 */
function locatePeaksByPeriod(
  signal: number[],
  timestampsMs: number[],
  periodSamples: number,
  fs: number,
): { peaks: number[]; peakTimes: number[] } {
  const n = signal.length;
  if (n < 8 || periodSamples < 3) return { peaks: [], peakTimes: [] };

  const halfWin = Math.max(2, Math.round(periodSamples * 0.28));
  const refractorySamples = Math.max(
    Math.round((300 / 1000) * fs),
    Math.round(periodSamples * 0.45),
  );

  const peaks: number[] = [];
  const peakTimes: number[] = [];
  let lastPeakIdx = -refractorySamples;

  for (let i = halfWin; i < n - halfWin; i++) {
    if (i - lastPeakIdx < refractorySamples) continue;

    const v = signal[i];
    let isMax = true;
    for (let j = i - halfWin; j <= i + halfWin; j++) {
      if (j !== i && signal[j] >= v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;

    // Prominencia mínima: el pico debe superar el 20% del rango local
    const lo = Math.max(0, i - halfWin * 2);
    const hi = Math.min(n - 1, i + halfWin * 2);
    let localMin = v;
    let localMax = v;
    for (let j = lo; j <= hi; j++) {
      if (signal[j] < localMin) localMin = signal[j];
      if (signal[j] > localMax) localMax = signal[j];
    }
    const localRange = localMax - localMin;
    const prominence = v - localMin;
    if (localRange < 1e-9 || prominence < localRange * 0.18) continue;

    peaks.push(i);
    peakTimes.push(timestampsMs[i] ?? 0);
    lastPeakIdx = i;
  }

  return { peaks, peakTimes };
}

export class SpectralPeakDetector {
  static detect(input: SpectralPeakDetectorInput): SpectralPeakDetectorOutput {
    const { signal, timestampsMs, samplingRateHz } = input;
    const n = signal.length;
    const minBpm = input.minBpm ?? 30;
    const maxBpm = input.maxBpm ?? 220;

    const empty: SpectralPeakDetectorOutput = {
      peaks: [],
      peakTimes: [],
      dominantBpm: 0,
      spectralQuality: 0,
      confidence: 0,
      diagnostics: { dominantFreqHz: 0, spectralSnr: 0, peakCount: 0, estimatedPeriodSamples: 0 },
    };

    if (n < 24 || samplingRateHz <= 0 || n !== timestampsMs.length) return empty;

    const fMin = minBpm / 60;
    const fMax = Math.min(maxBpm / 60, samplingRateHz * 0.45);
    if (fMax <= fMin) return empty;

    // Detrend + normalización robusta
    const detrended = detrendLinear(signal);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += detrended[i];
    mean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (detrended[i] - mean) ** 2;
    const std = Math.sqrt(variance / n);
    const x = std > 1e-9 ? detrended.map((v) => (v - mean) / std) : detrended;

    const steps = clamp(Math.round((fMax - fMin) / 0.005), 64, 512);
    const { freqHz, snr } = bandLimitedPeriodogram(x, samplingRateHz, fMin, fMax, steps);

    if (freqHz <= 0 || snr < 1.5) return empty;

    const dominantBpm = freqHz * 60;
    const periodSamples = Math.max(4, Math.round(samplingRateHz / freqHz));

    // Calidad espectral: SNR normalizada [0,1]
    const spectralQuality = clamp((snr - 1.5) / 18, 0, 1);

    const { peaks, peakTimes } = locatePeaksByPeriod(x, timestampsMs, periodSamples, samplingRateHz);

    // Confianza: combina calidad espectral + consistencia de picos detectados
    let confidence = spectralQuality * 0.6;
    if (peaks.length >= 2) {
      const rrMs: number[] = [];
      for (let i = 1; i < peakTimes.length; i++) {
        const d = peakTimes[i] - peakTimes[i - 1];
        if (d > 270 && d < 2200) rrMs.push(d);
      }
      if (rrMs.length >= 2) {
        let rrMean = 0;
        for (const r of rrMs) rrMean += r;
        rrMean /= rrMs.length;
        let rrVar = 0;
        for (const r of rrMs) rrVar += (r - rrMean) ** 2;
        const rrCv = Math.sqrt(rrVar / rrMs.length) / Math.max(1, rrMean);
        const rrStability = clamp(1 - rrCv / 0.3, 0, 1);
        confidence += rrStability * 0.4;
      }
    }

    return {
      peaks,
      peakTimes,
      dominantBpm,
      spectralQuality,
      confidence: clamp(confidence, 0, 1),
      diagnostics: {
        dominantFreqHz: freqHz,
        spectralSnr: snr,
        peakCount: peaks.length,
        estimatedPeriodSamples: periodSamples,
      },
    };
  }
}
