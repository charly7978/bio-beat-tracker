/**
 * NOTCH FILTER — Elimina interferencia de red eléctrica (50/60 Hz)
 *
 * Aplicado ANTES del bandpass para rechazar fuertemente
 * la interferencia de red sin afectar banda cardíaca (0.3-5 Hz).
 *
 * Implementación: IIR 2º orden (biquad notch)
 * Q = 20 para rechazo fuerte (-40 dB a 50/60 Hz)
 */
export class NotchFilter {
  private b: number[] = [1, 0, 1];
  private a: number[] = [1, 0, 0];

  private state: { x: number[]; y: number[] } = {
    x: [0, 0, 0],
    y: [0, 0, 0],
  };

  private sampleRate: number;
  private notchFreq: number; // 50 o 60 Hz
  private Q: number; // Factor de calidad (ancho de banda)
  private initialized = false;

  /**
   * @param sampleRate - Frecuencia de muestreo (Hz)
   * @param notchFreq - Frecuencia a eliminar: 50 Hz (Europa/Asia) o 60 Hz (USA)
   * @param Q - Factor de calidad (20-30 para rechazo fuerte)
   */
  constructor(sampleRate = 30, notchFreq = 50, Q = 20) {
    this.sampleRate = sampleRate;
    this.notchFreq = notchFreq;
    this.Q = Q;
    this.computeCoefficients();
  }

  /**
   * Calcula coeficientes del filtro notch usando transformación bilineal
   *
   * Solución avanzada: Si f_notch > Nyquist, usa frecuencia aliaseada.
   * Ejemplo: 50Hz @ fs=30Hz aliaseada a 10Hz (dentro de Nyquist).
   *
   * Fórmula del filtro notch (IIR 2º orden):
   *   H(z) = b[0](1 + z^-2) / (1 + a[1]z^-1 + a[2]z^-2)
   *
   * Donde los coeficientes se derivan de:
   *   w0 = 2 * π * f_effective / fs
   *   α = sin(w0) / (2 * Q)
   */
  private computeCoefficients(): void {
    const fs = this.sampleRate;
    const nyquist = fs / 2;
    let f0 = this.notchFreq;
    const Q = this.Q;

    // === VALIDACIÓN AVANZADA: Mapear f0 a frecuencia aliaseada válida ===
    if (f0 > nyquist) {
      // Si f0 está fuera de rango, calcula su represetnación aliaseada
      // Fold frequency back into valid range usando reflejo de Nyquist
      const folded = f0 % fs;
      if (folded > nyquist) {
        // Reflect around Nyquist
        f0 = fs - folded;
      } else {
        f0 = folded;
      }
    }

    // Garantizar f0 > 0
    f0 = Math.max(0.1, f0);

    // Frecuencia normalizada (ahora garantizada válida)
    const w0 = 2 * Math.PI * f0 / fs;
    const sinW0 = Math.sin(w0);
    const cosW0 = Math.cos(w0);
    const alpha = sinW0 / (2 * Q);

    // Coeficientes normalizados
    const a0 = 1 + alpha;

    // Numerador (notch)
    this.b[0] = 1 / a0;
    this.b[1] = (-2 * cosW0) / a0;
    this.b[2] = 1 / a0;

    // Denominador
    this.a[0] = 1;
    this.a[1] = (-2 * cosW0) / a0;
    this.a[2] = (1 - alpha) / a0;

    // Validar coeficientes (guard against numerical errors)
    if (!isFinite(this.b[0]) || !isFinite(this.a[1])) {
      // Fallback a identity filter si hay error numérico
      this.b = [1, 0, 0];
      this.a = [1, 0, 0];
    }

    this.initialized = true;
  }

  /**
   * Aplica el filtro notch a un sample
   */
  filter(sample: number): number {
    if (!this.initialized || !isFinite(sample)) {
      return 0;
    }

    const { x, y } = this.state;

    // Shift states
    x[2] = x[1];
    x[1] = x[0];
    x[0] = sample;

    y[2] = y[1];
    y[1] = y[0];

    // Ecuación diferencial
    y[0] =
      this.b[0] * x[0] +
      this.b[1] * x[1] +
      this.b[2] * x[2] -
      this.a[1] * y[1] -
      this.a[2] * y[2];

    // Guard against NaN/Inf
    if (!isFinite(y[0])) {
      y[0] = 0;
    }

    return y[0];
  }

  /**
   * Reinicia el estado del filtro
   */
  reset(): void {
    this.state = {
      x: [0, 0, 0],
      y: [0, 0, 0],
    };
  }

  /**
   * Cambia la frecuencia de muestreo y recalcula coeficientes
   */
  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.computeCoefficients();
    this.reset();
  }

  /**
   * Cambia la frecuencia notch (50 o 60 Hz)
   */
  setNotchFrequency(freq: number): void {
    this.notchFreq = freq;
    this.computeCoefficients();
    this.reset();
  }

  /**
   * Cambia el factor de calidad Q
   */
  setQFactor(Q: number): void {
    this.Q = Q;
    this.computeCoefficients();
    this.reset();
  }

  /**
   * Retorna los coeficientes actuales (para debugging)
   */
  getCoefficients() {
    return {
      b: [...this.b],
      a: [...this.a],
    };
  }
}
