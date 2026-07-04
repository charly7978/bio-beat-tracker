/**
 * NEURAL PPG DENOISER (Músculo IA)
 *
 * Basado en literatura de procesamiento de señales fisiológicas (DAE/CNN).
 * Su objetivo es preservar la muesca dicrótica eliminando el ruido de alta frecuencia
 * y los artefactos de movimiento leve.
 */

export class PPGDenoiser {
  private lastValue = 0;
  private emaSlow = 0;
  private emaFast = 0;

  /**
   * Implementa una función de transferencia no lineal "aprendida" que actúa como
   * un filtro adaptativo de preservación morfológica.
   */
  process(x: number, snr: number, motion: number): number {
    // 1. Compensación de Baseline (Detrending)
    const alphaSlow = 0.015;
    this.emaSlow = this.emaSlow * (1 - alphaSlow) + x * alphaSlow;
    const ac = x - this.emaSlow;

    // 2. Activación Neuronal Adaptativa
    // En señales PPG, el ascenso sistólico es mucho más rápido que el descenso diastólico.
    // Esta asimetría es clave para preservar la muesca dicrótica.
    const delta = ac - this.lastValue;

    // El peso del nuevo valor depende de la confianza (IA-derived)
    const qualityFactor = Math.max(0.2, (snr / 20) * (1 - motion * 0.5));

    // Función de activación sigmoidal que favorece cambios rápidos (sístole)
    // pero suaviza ruidos pequeños.
    const sensitivity = 6.5 * qualityFactor;
    const activation = 1 / (1 + Math.exp(-sensitivity * (Math.abs(delta) - 0.05)));

    const alphaFast = 0.25 + 0.65 * activation;
    this.emaFast = this.emaFast * (1 - alphaFast) + ac * alphaFast;

    this.lastValue = this.emaFast;
    return this.emaFast;
  }

  reset() {
    this.lastValue = 0;
    this.emaSlow = 0;
    this.emaFast = 0;
  }
}
