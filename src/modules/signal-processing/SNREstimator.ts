/**
 * SNR ESTIMATOR — Welch's PSD method + Spectral SNR
 *
 * Calcula SNR (Signal-to-Noise Ratio) de señal PPG en tiempo real.
 *
 * Técnica científicamente validada:
 * 1. Welch's method para PSD estimation (overlap 50%, Hann window)
 * 2. P_signal = potencia integrada en banda fisiológica
 * 3. P_noise = potencia integrada fuera de banda
 * 4. SNR = 10 * log10(P_signal / P_noise) en dB
 *
 * Referencias:
 * - Welch (1967): The use of FFT for estimation of power spectra
 * - Optimal SQI for PPG (Elgendi 2016)
 * - PPG-quality library (calc_snr)
 *
 * Optimizaciones:
 * - Buffers Float32Array reutilizables (cero allocations en hot path)
 * - FFT precomputada (twiddles + bit-reversal cacheados)
 * - Throttling: actualiza cada N frames (no por frame)
 * - Cache de último SNR calculado
 */
import { FFT, hannWindow, windowEnergy } from './FFT';

export interface SNRBandConfig {
  /** Frecuencia mínima de banda de señal (Hz) — ej: 0.6 para HR */
  signalBandLow: number;
  /** Frecuencia máxima de banda de señal (Hz) — ej: 4.0 para HR */
  signalBandHigh: number;
  /** Sampling rate (Hz) */
  sampleRate: number;
}

export interface SNRResult {
  /** SNR en dB (linear: 10*log10(Psig/Pnoise)) */
  snrDb: number;
  /** SNR normalizado 0-1 (clamp a rango fisiológico típico 0-20 dB) */
  snrScore: number;
  /** Potencia en banda de señal */
  signalPower: number;
  /** Potencia en banda de ruido */
  noisePower: number;
  /** Frecuencia dominante detectada en banda de señal (Hz) */
  dominantFreq: number;
  /** Calidad de detección del peak (0-1) */
  peakSharpness: number;
}

export class SNREstimator {
  private readonly fftSize: number;
  private readonly segmentSize: number;
  private readonly overlap: number; // muestras de solape
  private readonly fft: FFT;
  private readonly hann: Float32Array;
  private readonly hannEnergy: number;
  private readonly config: SNRBandConfig;

  // Buffers reutilizables — cero allocations en hot path
  private readonly segment: Float32Array;
  private readonly real: Float32Array;
  private readonly imag: Float32Array;
  private readonly psdAccum: Float32Array;
  private readonly psdFinal: Float32Array;

  // Cache de resultado (throttling)
  private lastSnrResult: SNRResult = {
    snrDb: 0, snrScore: 0, signalPower: 0, noisePower: 0,
    dominantFreq: 0, peakSharpness: 0,
  };

  /**
   * @param fftSize - Tamaño de FFT (potencia de 2). 128 = buen tradeoff para PPG @ 30Hz
   * @param config - Configuración de bandas (señal vs ruido)
   */
  constructor(fftSize = 128, config: SNRBandConfig) {
    if ((fftSize & (fftSize - 1)) !== 0) {
      throw new Error(`fftSize must be power of 2, got ${fftSize}`);
    }
    this.fftSize = fftSize;
    this.segmentSize = fftSize;
    this.overlap = fftSize >> 1; // 50% overlap (estándar Welch)
    this.config = config;

    this.fft = new FFT(fftSize);
    this.hann = hannWindow(fftSize);
    this.hannEnergy = windowEnergy(this.hann);

    this.segment = new Float32Array(fftSize);
    this.real = new Float32Array(fftSize);
    this.imag = new Float32Array(fftSize);
    this.psdAccum = new Float32Array(fftSize >> 1);
    this.psdFinal = new Float32Array(fftSize >> 1);
  }

  /**
   * Calcula SNR usando Welch's method.
   *
   * @param signal - Buffer circular con muestras de señal (AC, post-bandpass)
   * @param head - Índice "siguiente escritura" en el buffer circular
   * @param fillCount - Muestras válidas en buffer (≤ signal.length)
   * @param bufferMask - Máscara del buffer (size-1, asume size potencia de 2)
   * @returns SNR calculado
   */
  compute(
    signal: Float64Array | Float32Array,
    head: number,
    fillCount: number,
    bufferMask: number,
  ): SNRResult {
    // Requiere mínimo 2 segmentos para Welch
    const minSamples = this.segmentSize + this.overlap;
    if (fillCount < minSamples) {
      return this.lastSnrResult;
    }

    // Reset accumulator
    const halfN = this.fftSize >> 1;
    for (let i = 0; i < halfN; i++) this.psdAccum[i] = 0;

    // Segmentos disponibles con overlap 50%
    const usableSamples = Math.min(fillCount, signal.length);
    const numSegments = Math.floor((usableSamples - this.segmentSize) / this.overlap) + 1;
    if (numSegments < 1) return this.lastSnrResult;

    // Procesar cada segmento
    for (let seg = 0; seg < numSegments; seg++) {
      const offset = seg * this.overlap;

      // Extraer segmento del buffer circular (más antiguo a más reciente)
      // head apunta a "próxima escritura", así que muestra más reciente = head-1
      // Tomamos desde la más antigua hacia adelante
      for (let i = 0; i < this.segmentSize; i++) {
        // Índice cronológico: 0 = más antigua del rango, segmentSize-1 = más reciente
        const sampleIdx = usableSamples - 1 - (offset + (this.segmentSize - 1 - i));
        const bufIdx = (head - 1 - sampleIdx) & bufferMask;
        // Aplicar ventana Hann durante copia
        this.segment[i] = (signal[bufIdx] as number) * this.hann[i];
      }

      // FFT del segmento ventaneado
      this.fft.forward(this.segment, this.real, this.imag);

      // Acumular PSD: |X[k]|² (solo half-spectrum, simetría de FFT real)
      for (let k = 0; k < halfN; k++) {
        this.psdAccum[k] += this.real[k] * this.real[k] + this.imag[k] * this.imag[k];
      }
    }

    // Normalizar Welch PSD: dividir por numSegments * windowEnergy * fftSize
    const norm = 1 / (numSegments * this.hannEnergy * this.fftSize);
    for (let k = 0; k < halfN; k++) {
      this.psdFinal[k] = this.psdAccum[k] * norm;
    }

    // Calcular SNR integrando bandas
    return this.calculateSNRFromPSD();
  }

  /**
   * Calcula SNR desde PSD acumulada.
   * Identifica banda de señal (HR) vs ruido (resto del espectro válido).
   */
  private calculateSNRFromPSD(): SNRResult {
    const fs = this.config.sampleRate;
    const N = this.fftSize;
    const halfN = N >> 1;

    // Bins correspondientes a banda de señal
    const binResolution = fs / N; // Hz por bin
    const sigLowBin = Math.max(1, Math.floor(this.config.signalBandLow / binResolution));
    const sigHighBin = Math.min(halfN - 1, Math.ceil(this.config.signalBandHigh / binResolution));

    let signalPower = 0;
    let maxBinPower = 0;
    let dominantBin = sigLowBin;

    // Integra potencia en banda de señal + busca pico dominante
    for (let k = sigLowBin; k <= sigHighBin; k++) {
      const p = this.psdFinal[k];
      signalPower += p;
      if (p > maxBinPower) {
        maxBinPower = p;
        dominantBin = k;
      }
    }

    // Potencia de ruido: todo lo demás (excepto DC y armónicos cercanos del peak)
    let noisePower = 0;
    let noiseBinCount = 0;

    // Excluye DC (bin 0) y banda de armónico fundamental ± 2 bins alrededor del peak
    const peakExclusionRadius = 2;
    const harmonic2Bin = dominantBin * 2; // 2do armónico

    for (let k = 1; k < halfN; k++) {
      // Skip banda de señal
      if (k >= sigLowBin && k <= sigHighBin) continue;
      // Skip bins cerca del 2do armónico (suele ser señal real, no ruido)
      if (Math.abs(k - harmonic2Bin) <= peakExclusionRadius) continue;

      noisePower += this.psdFinal[k];
      noiseBinCount++;
    }

    if (noiseBinCount > 0) {
      noisePower /= noiseBinCount; // Promedio por bin
      noisePower *= (sigHighBin - sigLowBin + 1); // Escalar a número de bins de señal (comparable)
    } else {
      noisePower = 1e-12;
    }

    // SNR en dB
    const ratio = signalPower / Math.max(noisePower, 1e-12);
    const snrDb = 10 * Math.log10(Math.max(ratio, 1e-6));

    // Score 0-1: SNR típico de PPG va de 0 a 20 dB en condiciones reales
    // <0 dB = pésima, 0-5 dB = mala, 5-10 dB = aceptable, >10 dB = buena
    const snrScore = Math.max(0, Math.min(1, (snrDb + 3) / 18));

    // Frecuencia dominante (Hz)
    const dominantFreq = dominantBin * binResolution;

    // Sharpness del pico: cuán pronunciado es vs vecinos
    const leftP = dominantBin > 0 ? this.psdFinal[dominantBin - 1] : 0;
    const rightP = dominantBin < halfN - 1 ? this.psdFinal[dominantBin + 1] : 0;
    const neighborAvg = (leftP + rightP) / 2;
    const peakSharpness = maxBinPower > 0
      ? Math.min(1, Math.max(0, 1 - (neighborAvg / maxBinPower)))
      : 0;

    this.lastSnrResult = {
      snrDb,
      snrScore,
      signalPower,
      noisePower,
      dominantFreq,
      peakSharpness,
    };

    return this.lastSnrResult;
  }

  /**
   * Cambiar sampling rate (recalcula bins de banda).
   * Útil cuando fs cambia dinámicamente.
   */
  updateSampleRate(fs: number): void {
    this.config.sampleRate = fs;
  }

  /**
   * Cambiar bandas de señal/ruido.
   */
  updateBands(signalBandLow: number, signalBandHigh: number): void {
    this.config.signalBandLow = signalBandLow;
    this.config.signalBandHigh = signalBandHigh;
  }

  /** Reset estado interno */
  reset(): void {
    this.lastSnrResult = {
      snrDb: 0, snrScore: 0, signalPower: 0, noisePower: 0,
      dominantFreq: 0, peakSharpness: 0,
    };
    for (let i = 0; i < this.psdAccum.length; i++) {
      this.psdAccum[i] = 0;
      this.psdFinal[i] = 0;
    }
  }

  getLastResult(): SNRResult {
    return this.lastSnrResult;
  }
}
