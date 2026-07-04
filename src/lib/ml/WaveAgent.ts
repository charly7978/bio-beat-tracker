
export interface WaveReport {
  isBiological: boolean;
  notchDetected: boolean;
  systolicAsymmetry: number;
  areaRatio: number;
}

/**
 * AGENTE DE VERACIDAD (Auditor de Ondas)
 *
 * Analiza la morfología de la señal como un experto en hemodinámica.
 * Verifica si la onda tiene la firma asimétrica de la sangre humana.
 */
export class WaveAgent {
  /**
   * Analiza un buffer de señal para encontrar evidencia de vida (muesca dicrótica).
   */
  analyzeMorphology(signal: number[]): WaveReport {
    if (signal.length < 30) return { isBiological: false, notchDetected: false, systolicAsymmetry: 0, areaRatio: 0 };

    // 1. Detección de Asimetría Sistólica
    // El latido real sube rápido y baja lento.
    const peaks = this.findLocalPeaks(signal);
    if (peaks.length === 0) return { isBiological: false, notchDetected: false, systolicAsymmetry: 0, areaRatio: 0 };

    const firstPeak = peaks[0];
    const riseTime = firstPeak.index;
    const fallTime = signal.length - firstPeak.index;
    const asymmetry = fallTime / Math.max(1, riseTime);

    // 2. Búsqueda de Muesca Dicrótica (Inflexión en el descenso)
    const notchDetected = this.checkForDicroticNotch(signal, firstPeak.index);

    return {
      isBiological: asymmetry > 1.5 && notchDetected,
      notchDetected,
      systolicAsymmetry: asymmetry,
      areaRatio: this.calculateAreaRatio(signal)
    };
  }

  private findLocalPeaks(signal: number[]) {
    const peaks = [];
    for (let i = 1; i < signal.length - 1; i++) {
      if (signal[i] > signal[i - 1] && signal[i] > signal[i + 1] && signal[i] > 0) {
        peaks.push({ index: i, value: signal[i] });
      }
    }
    return peaks.sort((a, b) => b.value - a.value);
  }

  private checkForDicroticNotch(signal: number[], peakIndex: number): boolean {
    // Buscamos un cambio en la segunda derivada durante la caída sistólica
    let found = false;
    for (let i = peakIndex + 2; i < signal.length - 2; i++) {
      const slope = signal[i] - signal[i - 1];
      const nextSlope = signal[i + 1] - signal[i];
      if (nextSlope > slope && signal[i] > 0) {
        found = true;
        break;
      }
    }
    return found;
  }

  private calculateAreaRatio(signal: number[]): number {
    const mean = signal.reduce((a, b) => a + b, 0) / signal.length;
    const above = signal.filter(v => v > mean).length;
    const below = signal.filter(v => v <= mean).length;
    return above / Math.max(1, below);
  }
}

export const waveAgent = new WaveAgent();
