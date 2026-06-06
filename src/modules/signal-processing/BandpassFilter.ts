/**
 * FILTRO PASABANDA IIR BUTTERWORTH 4º ORDEN - OPTIMIZADO PARA PPG
 *
 * CRÍTICO PARA DETECCIÓN DE LATIDOS:
 * - Frecuencia cardíaca: 18-300 BPM = 0.3-5 Hz (rango amplio para robustez)
 * - Elimina DC (línea base, cambios lentos de iluminación)
 * - Elimina alta frecuencia (ruido eléctrico, vibraciones, movimiento)
 *
 * IMPLEMENTACIÓN: Biquad IIR 4º orden (2 biquads en cascada por etapa)
 * para roll-off más pronunciado (24 dB/oct vs 12 dB/oct de 2º orden).
 * 
 * Referencias:
 * - De Haan & Jeanne 2013: CHROM/POS para rPPG
 * - Proakis & Manolakis, "Digital Signal Processing" (4th ed.)
 * - https://tomroelandts.com/articles/biquad-cookbook
 */
import { DSP_CONSTANTS } from '../../config/signalProcessing';

export class BandpassFilter {
  // Coeficientes del filtro pasa-altos 0.5Hz (elimina DC)
  private hpfB: number[][];
  private hpfA: number[][];

  // Coeficientes del filtro pasa-bajos (elimina ruido HF)
  private lpfB: number[][];
  private lpfA: number[][];

  // Estados internos del filtro (un estado por biquad)
  private hpfState: { x: number[]; y: number[] }[];
  private lpfState: { x: number[]; y: number[] }[];

  private sampleRate: number;
  private highCutFreq: number;
  private initialized = false;

  constructor(sampleRate: number = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE, highCutFreq: number = 4.5) {
    this.sampleRate = sampleRate;
    this.highCutFreq = highCutFreq;

    // Inicializar coeficientes (2 biquads por etapa = 4º orden)
    this.hpfB = [[0, 0, 0], [0, 0, 0]];
    this.hpfA = [[1, 0, 0], [1, 0, 0]];
    this.lpfB = [[0, 0, 0], [0, 0, 0]];
    this.lpfA = [[1, 0, 0], [1, 0, 0]];

    // Estados (2 biquads × 3 taps)
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
   * Calcula coeficientes Butterworth 4º orden (2 biquads en cascada por etapa)
   * usando transformación bilineal.
   *
   * Para 4º orden se descompone el polinomio de Butterworth:
   *   H(s) = 1 / (s² + 2ζ₁s + 1)(s² + 2ζ₂s + 1)
   * Donde ζ₁ = 2cos(π/8) ≈ 0.9239, ζ₂ = 2cos(3π/8) ≈ 0.3827
   */
  private computeCoefficients(): void {
    const fs = this.sampleRate;

    // === PASA-ALTOS a 0.5Hz (estándar clínico para HR) ===
    const fcHp = 0.5;
    this.computeHPF(fcHp, fs);

    // === PASA-BAJOS configurable ===
    this.computeLPF(this.highCutFreq, fs);

    this.initialized = true;
  }

  private computeHPF(fc: number, fs: number): void {
    const wc = Math.tan(Math.PI * fc / fs);
    // Factores de amortiguamiento Butterworth 4º orden
    const zeta = [2 * Math.cos(Math.PI / 8), 2 * Math.cos(3 * Math.PI / 8)];

    for (let i = 0; i < 2; i++) {
      const k = wc;
      const norm = 1 / (1 + zeta[i] * k + k * k);
      this.hpfB[i][0] = norm;
      this.hpfB[i][1] = -2 * norm;
      this.hpfB[i][2] = norm;
      this.hpfA[i][0] = 1;
      this.hpfA[i][1] = 2 * (k * k - 1) * norm;
      this.hpfA[i][2] = (1 - zeta[i] * k + k * k) * norm;
    }
  }

  private computeLPF(fc: number, fs: number): void {
    const wc = Math.tan(Math.PI * fc / fs);
    const zeta = [2 * Math.cos(Math.PI / 8), 2 * Math.cos(3 * Math.PI / 8)];

    for (let i = 0; i < 2; i++) {
      const k = wc;
      const norm = 1 / (1 + zeta[i] * k + k * k);
      this.lpfB[i][0] = k * k * norm;
      this.lpfB[i][1] = 2 * k * k * norm;
      this.lpfB[i][2] = k * k * norm;
      this.lpfA[i][0] = 1;
      this.lpfA[i][1] = 2 * (k * k - 1) * norm;
      this.lpfA[i][2] = (1 - zeta[i] * k + k * k) * norm;
    }
  }
  
  /**
   * Aplica filtro biquad IIR
   */
  private applyBiquad(
    input: number,
    b: number[],
    a: number[],
    state: { x: number[]; y: number[] },
  ): number {
    state.x[2] = state.x[1];
    state.x[1] = state.x[0];
    state.x[0] = input;

    state.y[2] = state.y[1];
    state.y[1] = state.y[0];

    state.y[0] =
      b[0] * state.x[0] +
      b[1] * state.x[1] +
      b[2] * state.x[2] -
      a[1] * state.y[1] -
      a[2] * state.y[2];

    if (!isFinite(state.y[0]) || Math.abs(state.y[0]) > 1e10) {
      state.y[0] = 0;
    }

    return state.y[0];
  }

  /**
   * Aplica una etapa completa (HPF o LPF) a través de sus 2 biquads en cascada.
   */
  private applyStage(
    input: number,
    bCoefs: number[][],
    aCoefs: number[][],
    states: { x: number[]; y: number[] }[],
  ): number {
    let v = input;
    for (let i = 0; i < 2; i++) {
      v = this.applyBiquad(v, bCoefs[i], aCoefs[i], states[i]);
    }
    return v;
  }

  /**
   * FILTRO PASABANDA COMPLETO (4º orden, cascada HPF → LPF)
   * Roll-off 24 dB/oct para mejor rechazo fuera de banda.
   */
  filter(value: number): number {
    if (!this.initialized || !isFinite(value)) {
      return 0;
    }

    const hpFiltered = this.applyStage(value, this.hpfB, this.hpfA, this.hpfState);
    const bpFiltered = this.applyStage(hpFiltered, this.lpfB, this.lpfA, this.lpfState);

    return bpFiltered;
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
