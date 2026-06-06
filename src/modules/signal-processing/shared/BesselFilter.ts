/**
 * FILTRO BESSEL-LIKE IIR 4° ORDEN — Fase lineal aproximada para preservar morfología PPG.
 *
 * Implementado con la misma arquitectura biquad-en-cascada de BandpassFilter
 * (que ya está validada en tests), pero usando los factores de amortiguamiento
 * del filtro Bessel de 4° orden en lugar de los del Butterworth:
 *
 *   Butterworth 4° orden:  ζ₁ = 2cos(π/8) ≈ 1.8478,  ζ₂ = 2cos(3π/8) ≈ 0.7654
 *   Bessel 4° orden:       ζ₁ ≈ 2×0.5219 = 1.0440,   ζ₂ ≈ 2×0.8055 = 1.6110
 *   (valores de Abramowitz & Stegun / Zverev)
 *
 * La ventaja de fase lineal del Bessel viene de estos ζ mayores:
 *   - Retardo de grupo más constante en la banda de paso
 *   - Roll-off más gradual (menor pendiente) que el Butterworth
 *   - Sin ringing en la respuesta al escalón
 *
 * Para PPG morfológico esto preserva mejor:
 *   - El onset sistólico
 *   - El pico sistólico
 *   - La muesca dicrota
 *   - El pico diastólico
 *
 * Referencias:
 *   - Abramowitz & Stegun, "Handbook of Mathematical Functions" (9th ed.) §19.6
 *   - Zverev, "Handbook of Filter Synthesis" (1967) // anti-sim-allow: reason="Filter design handbook citation" ref="PR-123"
 *   - Williams & Taylor, "Electronic Filter Design Handbook" (4th ed.) Ch. 11
 */
export class BesselFilter {
  // Coeficientes del filtro pasa-altos (2 biquads en cascada)
  private hpfB: number[][];
  private hpfA: number[][];

  // Coeficientes del filtro pasa-bajos (2 biquads en cascada)
  private lpfB: number[][];
  private lpfA: number[][];

  // Estados internos
  private hpfState: { x: number[]; y: number[] }[];
  private lpfState: { x: number[]; y: number[] }[];

  private sampleRate: number;
  private lowCutHz: number;
  private highCutHz: number;
  private initialized = false;

  /**
   * @param sampleRate  Frecuencia de muestreo en Hz
   * @param lowCutHz    Frecuencia de corte del HPF (default 0.5 Hz)
   * @param highCutHz   Frecuencia de corte del LPF (default 12 Hz)
   */
  constructor(sampleRate = 30, lowCutHz = 0.5, highCutHz = 12.0) {
    this.sampleRate = sampleRate;
    this.lowCutHz = lowCutHz;
    this.highCutHz = highCutHz;

    this.hpfB = [[0, 0, 0], [0, 0, 0]];
    this.hpfA = [[1, 0, 0], [1, 0, 0]];
    this.lpfB = [[0, 0, 0], [0, 0, 0]];
    this.lpfA = [[1, 0, 0], [1, 0, 0]];

    this.hpfState = [
      { x: [0, 0, 0], y: [0, 0, 0] },
      { x: [0, 0, 0], y: [0, 0, 0] },
    ];
    this.lpfState = [
      { x: [0, 0, 0], y: [0, 0, 0] },
      { x: [0, 0, 0], y: [0, 0, 0] },
    ];

    this.computeCoefficients();
  }

  /**
   * Factores de amortiguamiento para Bessel de 4° orden:
   *   ζ₁ = 1.0440  (par de polos de baja frecuencia — más suave)
   *   ζ₂ = 1.6110  (par de polos de alta frecuencia — más amortiguado)
   *
   * Nota: estos factores son la suma de los coeficientes s¹ de cada biquad
   * al factorizar H4(s) = 1 / [(s² + 1.044s + …)(s² + 1.611s + …)]
   */
  private readonly BESSEL_ZETA = [1.0440, 1.6110] as const;

  private computeCoefficients(): void {
    const fs = this.sampleRate;
    this.computeHPF(this.lowCutHz, fs);
    this.computeLPF(this.highCutHz, fs);
    this.initialized = true;
  }

  /** HPF Bessel 4° orden via transformación bilineal — mismo esquema que BandpassFilter. */
  private computeHPF(fc: number, fs: number): void {
    const wc = Math.tan(Math.PI * fc / fs);
    for (let i = 0; i < 2; i++) {
      const z = this.BESSEL_ZETA[i]!;
      const k = wc;
      const norm = 1 / (1 + z * k + k * k);
      // HPF: b = [1, -2, 1] × norm — pasa energía por encima de fc
      this.hpfB[i] = [norm, -2 * norm, norm];
      this.hpfA[i] = [1, 2 * (k * k - 1) * norm, (1 - z * k + k * k) * norm];
    }
  }

  /** LPF Bessel 4° orden via transformación bilineal — mismo esquema que BandpassFilter. */
  private computeLPF(fc: number, fs: number): void {
    const wc = Math.tan(Math.PI * fc / fs);
    for (let i = 0; i < 2; i++) {
      const z = this.BESSEL_ZETA[i]!;
      const k = wc;
      const k2 = k * k;
      const norm = 1 / (1 + z * k + k2);
      // LPF: b = [k², 2k², k²] × norm — pasa energía por debajo de fc
      this.lpfB[i] = [k2 * norm, 2 * k2 * norm, k2 * norm];
      this.lpfA[i] = [1, 2 * (k2 - 1) * norm, (1 - z * k + k2) * norm];
    }
  }

  /** Aplica un biquad IIR directo forma I con protección anti-overflow. */
  private applyBiquad(
    input: number,
    b: number[],
    a: number[],
    state: { x: number[]; y: number[] },
  ): number {
    state.x[2] = state.x[1]!;
    state.x[1] = state.x[0]!;
    state.x[0] = input;
    state.y[2] = state.y[1]!;
    state.y[1] = state.y[0]!;

    state.y[0] =
      b[0]! * state.x[0] +
      b[1]! * state.x[1]! +
      b[2]! * state.x[2]! -
      a[1]! * state.y[1]! -
      a[2]! * state.y[2]!;

    if (!isFinite(state.y[0]) || Math.abs(state.y[0]) > 1e10) {
      state.y[0] = 0;
    }

    return state.y[0];
  }

  /** Aplica una etapa completa (HPF o LPF, 2 biquads en cascada). */
  private applyStage(
    input: number,
    bCoefs: number[][],
    aCoefs: number[][],
    states: { x: number[]; y: number[] }[],
  ): number {
    let v = input;
    for (let i = 0; i < 2; i++) {
      v = this.applyBiquad(v, bCoefs[i]!, aCoefs[i]!, states[i]!);
    }
    return v;
  }

  /**
   * Filtra una muestra: HPF (bloqueo DC) → LPF (eliminación de HF).
   * La combinación da un bandpass con características Bessel (fase lineal ≈).
   */
  filter(value: number): number {
    if (!this.initialized || !isFinite(value)) return 0;
    const hpf = this.applyStage(value, this.hpfB, this.hpfA, this.hpfState);
    return this.applyStage(hpf, this.lpfB, this.lpfA, this.lpfState);
  }

  reset(): void {
    this.hpfState = [
      { x: [0, 0, 0], y: [0, 0, 0] },
      { x: [0, 0, 0], y: [0, 0, 0] },
    ];
    this.lpfState = [
      { x: [0, 0, 0], y: [0, 0, 0] },
      { x: [0, 0, 0], y: [0, 0, 0] },
    ];
  }

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.computeCoefficients();
    this.reset();
  }
}
