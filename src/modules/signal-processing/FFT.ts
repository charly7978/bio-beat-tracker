/**
 * FFT — Cooley-Tukey radix-2 iterativa (in-place, sin allocations)
 *
 * Optimizada para procesamiento en tiempo real:
 * - In-place: reutiliza buffers Float32Array (sin allocations por frame)
 * - Iterativa (no recursiva): evita stack overhead
 * - Bit-reversal precomputado: O(1) lookup
 * - Twiddles precomputados: O(1) lookup
 *
 * Tamaño DEBE ser potencia de 2.
 *
 * Referencias:
 * - Cooley & Tukey (1965): An Algorithm for the Machine Calculation of Complex Fourier Series
 * - Heideman, Johnson & Burrus (1984): Gauss and the History of the FFT
 */
export class FFT {
  private readonly N: number;
  private readonly halfN: number;
  private readonly logN: number;

  // Precomputados (sin allocations en hot path)
  private readonly bitReversed: Uint32Array;
  private readonly cosTable: Float32Array;
  private readonly sinTable: Float32Array;

  // Buffers reutilizables para evitar allocations
  private readonly realBuf: Float32Array;
  private readonly imagBuf: Float32Array;

  /**
   * @param size - Tamaño de FFT (debe ser potencia de 2)
   */
  constructor(size: number) {
    if (size <= 0 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of 2, got ${size}`);
    }
    this.N = size;
    this.halfN = size >> 1;
    this.logN = Math.log2(size);

    // Bit-reversal lookup table
    this.bitReversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let rev = 0;
      let x = i;
      for (let j = 0; j < this.logN; j++) {
        rev = (rev << 1) | (x & 1);
        x >>= 1;
      }
      this.bitReversed[i] = rev;
    }

    // Twiddle factors precomputados
    this.cosTable = new Float32Array(this.halfN);
    this.sinTable = new Float32Array(this.halfN);
    for (let i = 0; i < this.halfN; i++) {
      const angle = (-2 * Math.PI * i) / size;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    // Buffers internos
    this.realBuf = new Float32Array(size);
    this.imagBuf = new Float32Array(size);
  }

  /**
   * FFT in-place. Real input → Complex output (real, imag arrays).
   * @param input - Array de entrada (real)
   * @param outReal - Buffer de salida para parte real (size N)
   * @param outImag - Buffer de salida para parte imaginaria (size N)
   */
  forward(input: ArrayLike<number>, outReal: Float32Array, outImag: Float32Array): void {
    const N = this.N;

    // Bit-reversal permutation: copia con índices invertidos
    for (let i = 0; i < N; i++) {
      outReal[this.bitReversed[i]] = input[i] ?? 0;
      outImag[this.bitReversed[i]] = 0;
    }

    // Butterflies iterativas
    for (let size = 2; size <= N; size <<= 1) {
      const halfSize = size >> 1;
      const tableStep = this.halfN / halfSize;

      for (let i = 0; i < N; i += size) {
        let k = 0;
        for (let j = i; j < i + halfSize; j++) {
          const tr = outReal[j + halfSize] * this.cosTable[k] - outImag[j + halfSize] * this.sinTable[k];
          const ti = outReal[j + halfSize] * this.sinTable[k] + outImag[j + halfSize] * this.cosTable[k];
          outReal[j + halfSize] = outReal[j] - tr;
          outImag[j + halfSize] = outImag[j] - ti;
          outReal[j] += tr;
          outImag[j] += ti;
          k += tableStep;
        }
      }
    }
  }

  /**
   * Calcula magnitud al cuadrado (|X[k]|²) desde real/imag.
   * Útil para PSD (Power Spectral Density).
   */
  static magnitudeSquared(real: Float32Array, imag: Float32Array, out: Float32Array, length?: number): void {
    const n = length ?? real.length;
    for (let i = 0; i < n; i++) {
      out[i] = real[i] * real[i] + imag[i] * imag[i];
    }
  }

  getSize(): number {
    return this.N;
  }

  getInternalBuffers() {
    return { real: this.realBuf, imag: this.imagBuf };
  }
}

/**
 * Ventana Hann (Hanning) precomputada
 * w[n] = 0.5 * (1 - cos(2π*n / (N-1)))
 *
 * Mejor SNR que Hamming para análisis espectral.
 * Side-lobes -31.5 dB.
 */
export function hannWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  const factor = (2 * Math.PI) / (size - 1);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos(factor * i));
  }
  return window;
}

/**
 * Energía de coherencia de la ventana (para normalización PSD)
 * U = (1/N) * Σ w[n]²
 */
export function windowEnergy(window: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < window.length; i++) {
    sum += window[i] * window[i];
  }
  return sum / window.length;
}
