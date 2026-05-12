/**
 * MFCC PROCESSOR (Mel-Frequency Cepstral Coefficients)
 * 
 * Utilizado para la extracción de características espectrales de la onda de pulso.
 * Base del algoritmo SDFMFCC para la estimación de glucosa.
 */
export class MFCCProcessor {
  private static readonly MEL_FILTERS = 26;
  private static readonly NUM_CEPS = 13;

  /**
   * Calcula los coeficientes MFCC para una ventana de señal.
   */
  static calculate(signal: number[], sampleRate: number): number[] {
    if (signal.length < 16) return new Array(this.NUM_CEPS).fill(0);

    // 1. Pre-énfasis (opcional para PPG, pero ayuda a balancear espectro)
    const emphasized = this.preEmphasis(signal);

    // 2. Windowing (Hamming)
    const windowed = this.hammingWindow(emphasized);

    // 3. FFT & Power Spectrum
    const nfft = this.nextPowerOfTwo(windowed.length);
    const powerSpectrum = this.powerSpectrum(windowed, nfft);

    // 4. Mel Filterbank energies
    const melEnergies = this.melFilterBank(powerSpectrum, sampleRate, nfft);

    // 5. Logarithm
    const logEnergies = melEnergies.map(e => Math.log(Math.max(1e-10, e)));

    // 6. DCT (Discrete Cosine Transform)
    return this.dct(logEnergies).slice(0, this.NUM_CEPS);
  }

  private static preEmphasis(signal: number[], alpha: number = 0.97): number[] {
    const out = new Array(signal.length);
    out[0] = signal[0];
    for (let i = 1; i < signal.length; i++) {
      out[i] = signal[i] - alpha * signal[i - 1];
    }
    return out;
  }

  private static hammingWindow(signal: number[]): number[] {
    const n = signal.length;
    return signal.map((v, i) => v * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1))));
  }

  private static nextPowerOfTwo(n: number): number {
    return Math.pow(2, Math.ceil(Math.log2(n)));
  }

  private static powerSpectrum(signal: number[], nfft: number): number[] {
    const real = new Float64Array(nfft);
    const imag = new Float64Array(nfft);
    for (let i = 0; i < signal.length; i++) real[i] = signal[i];

    // Simple Radix-2 FFT
    this.fft(real, imag);

    const power = new Array(nfft / 2 + 1);
    for (let i = 0; i <= nfft / 2; i++) {
      power[i] = (real[i] * real[i] + imag[i] * imag[i]) / nfft;
    }
    return power;
  }

  private static fft(real: Float64Array, imag: Float64Array): void {
    const n = real.length;
    if (n <= 1) return;

    // Bit-reversal permutation
    for (let i = 0, j = 0; i < n; i++) {
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
      let m = n >> 1;
      while (m >= 1 && j >= m) {
        j -= m;
        m >>= 1;
      }
      j += m;
    }

    // Butterfly computations
    for (let len = 2; len <= n; len <<= 1) {
      const angle = (2 * Math.PI) / len;
      const wlen_r = Math.cos(angle);
      const wlen_i = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let w_r = 1;
        let w_i = 0;
        for (let j = 0; j < len / 2; j++) {
          const u_r = real[i + j];
          const u_i = imag[i + j];
          const v_r = real[i + j + len / 2] * w_r - imag[i + j + len / 2] * w_i;
          const v_i = real[i + j + len / 2] * w_i + imag[i + j + len / 2] * w_r;
          real[i + j] = u_r + v_r;
          imag[i + j] = u_i + v_i;
          real[i + j + len / 2] = u_r - v_r;
          imag[i + j + len / 2] = u_i - v_i;
          const next_w_r = w_r * wlen_r - w_i * wlen_i;
          w_i = w_r * wlen_i + w_i * wlen_r;
          w_r = next_w_r;
        }
      }
    }
  }

  private static melFilterBank(power: number[], sampleRate: number, nfft: number): number[] {
    const minMel = 0;
    const maxMel = 2595 * Math.log10(1 + (sampleRate / 2) / 700);
    const melStep = (maxMel - minMel) / (this.MEL_FILTERS + 1);

    const bin = new Array(this.MEL_FILTERS + 2);
    for (let i = 0; i < bin.length; i++) {
      const mel = minMel + i * melStep;
      const freq = 700 * (Math.pow(10, mel / 2595) - 1);
      bin[i] = Math.floor((nfft + 1) * freq / sampleRate);
    }

    const energies = new Array(this.MEL_FILTERS).fill(0);
    for (let m = 1; m <= this.MEL_FILTERS; m++) {
      for (let k = bin[m - 1]; k < bin[m]; k++) {
        energies[m - 1] += power[k] * (k - bin[m - 1]) / (bin[m] - bin[m - 1]);
      }
      for (let k = bin[m]; k < bin[m + 1]; k++) {
        energies[m - 1] += power[k] * (bin[m + 1] - k) / (bin[m + 1] - bin[m]);
      }
    }
    return energies;
  }

  private static dct(logEnergies: number[]): number[] {
    const n = logEnergies.length;
    const ceps = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        sum += logEnergies[j] * Math.cos(Math.PI * i * (j + 0.5) / n);
      }
      ceps[i] = sum;
    }
    return ceps;
  }
}
