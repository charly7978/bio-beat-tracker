/**
 * FILTRO PASABANDA IIR BUTTERWORTH 2º ORDEN - ESTÁNDAR ELGENDI / NEUROKIT2
 *
 * Especificación exacta de Elgendi et al. (2013) y NeuroKit2:
 *   - Butterworth 2º orden, pasa-banda 0.5–8 Hz
 *   - Roll-off 12 dB/oct (confirmado en paper y en código fuente NK2)
 *   - Señal PPG filtrada con lowcut=0.5, highcut=8
 *
 * Referencias:
 *   - Elgendi et al. (2013) PLoS ONE 8(10): e76585
 *   - NeuroKit2: ppg_clean(method="elgendi") → signal_filter(lowcut=0.5, highcut=8, order=2)
 *   - Proakis & Manolakis, "Digital Signal Processing" (4th ed.)
 */
import { DSP_CONSTANTS } from '../../config/signalProcessing';

export class BandpassFilter {
  // Coeficientes del filtro IIR Butterworth 2º orden (un solo biquad por etapa)
  private hpfB: [number, number, number];
  private hpfA: [number, number, number];
  private lpfB: [number, number, number];
  private lpfA: [number, number, number];

  // Estados del filtro
  private hpfX: [number, number] = [0, 0];
  private hpfY: [number, number] = [0, 0];
  private lpfX: [number, number] = [0, 0];
  private lpfY: [number, number] = [0, 0];

  sampleRate: number;
  private highCutFreq: number;
  private lowCutFreq: number;

  constructor(
    sampleRate: number = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE,
    highCutFreq: number = 8,
    lowCutFreq: number = 0.5,
  ) {
    this.sampleRate = sampleRate;
    this.highCutFreq = highCutFreq;
    this.lowCutFreq = lowCutFreq;
    this.hpfB = [0, 0, 0];
    this.hpfA = [1, 0, 0];
    this.lpfB = [0, 0, 0];
    this.lpfA = [1, 0, 0];
    this.computeCoefficients();
  }

  private computeCoefficients(): void {
    const fs = this.sampleRate;
    const hpf = butterworthHPF(this.lowCutFreq, fs);
    this.hpfB = hpf.b;
    this.hpfA = hpf.a;
    const lpf = butterworthLPF(this.highCutFreq, fs);
    this.lpfB = lpf.b;
    this.lpfA = lpf.a;
  }

  filter(value: number): number {
    if (!isFinite(value)) return 0;

    const hpfOut =
      this.hpfB[0] * value +
      this.hpfB[1] * this.hpfX[0] +
      this.hpfB[2] * this.hpfX[1] -
      this.hpfA[1] * this.hpfY[0] -
      this.hpfA[2] * this.hpfY[1];
    this.hpfX[1] = this.hpfX[0];
    this.hpfX[0] = value;
    this.hpfY[1] = this.hpfY[0];
    this.hpfY[0] = isFinite(hpfOut) ? hpfOut : 0;

    const lpfOut =
      this.lpfB[0] * this.hpfY[0] +
      this.lpfB[1] * this.lpfX[0] +
      this.lpfB[2] * this.lpfX[1] -
      this.lpfA[1] * this.lpfY[0] -
      this.lpfA[2] * this.lpfY[1];
    this.lpfX[1] = this.lpfX[0];
    this.lpfX[0] = this.hpfY[0];
    this.lpfY[1] = this.lpfY[0];
    this.lpfY[0] = isFinite(lpfOut) ? lpfOut : 0;

    return this.lpfY[0];
  }

  reset(): void {
    this.hpfX = [0, 0];
    this.hpfY = [0, 0];
    this.lpfX = [0, 0];
    this.lpfY = [0, 0];
  }

  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.computeCoefficients();
    this.reset();
  }
}

function butterworthHPF(fc: number, fs: number): { b: [number, number, number]; a: [number, number, number] } {
  const wc = Math.tan(Math.PI * fc / fs);
  const k = wc;
  const norm = 1 / (1 + Math.SQRT2 * k + k * k);
  return {
    b: [norm, -2 * norm, norm],
    a: [1, 2 * (k * k - 1) * norm, (1 - Math.SQRT2 * k + k * k) * norm],
  };
}

function butterworthLPF(fc: number, fs: number): { b: [number, number, number]; a: [number, number, number] } {
  const wc = Math.tan(Math.PI * fc / fs);
  const k = wc;
  const norm = 1 / (1 + Math.SQRT2 * k + k * k);
  return {
    b: [k * k * norm, 2 * k * k * norm, k * k * norm],
    a: [1, 2 * (k * k - 1) * norm, (1 - Math.SQRT2 * k + k * k) * norm],
  };
}
