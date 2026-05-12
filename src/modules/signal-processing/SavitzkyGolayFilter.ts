/**
 * SAVITZKY-GOLAY FILTER
 * 
 * Filtro de suavizado que preserva la altura y posición de los picos.
 * Funciona ajustando un polinomio a una ventana deslizante.
 * 
 * Basado en la implementación de coeficientes precalculados para 
 * optimización en tiempo real.
 */
export class SavitzkyGolayFilter {
  /**
   * Coeficientes para un polinomio de orden 2.
   * Window size: 11 (central point = 5)
   */
  private static readonly COEFFS_11_O2 = [
    -0.0839, 0.0210, 0.1026, 0.1608, 0.1958, 0.2075, 0.1958, 0.1608, 0.1026, 0.0210, -0.0839
  ];

  /**
   * Coeficientes para un polinomio de orden 2.
   * Window size: 15 (central point = 7)
   */
  private static readonly COEFFS_15_O2 = [
    -0.0706, -0.0128, 0.0369, 0.0784, 0.1118, 0.1370, 0.1541, 0.1598, 0.1541, 0.1370, 0.1118, 0.0784, 0.0369, -0.0128, -0.0706
  ];

  /**
   * Suaviza una señal completa.
   * @param data Señal original
   * @param windowSize Tamaño de ventana (11 o 15 soportados)
   */
  static smooth(data: number[], windowSize: 11 | 15 = 11): number[] {
    const n = data.length;
    if (n < windowSize) return [...data];

    const coeffs = windowSize === 11 ? this.COEFFS_11_O2 : this.COEFFS_15_O2;
    const half = Math.floor(windowSize / 2);
    const result = new Array(n);

    for (let i = 0; i < n; i++) {
      if (i < half || i >= n - half) {
        result[i] = data[i]; // No podemos filtrar los bordes
        continue;
      }

      let sum = 0;
      for (let j = 0; j < windowSize; j++) {
        sum += data[i - half + j] * coeffs[j];
      }
      result[i] = sum;
    }

    return result;
  }

  /**
   * Versión para streaming: Filtra el último punto basándose en un buffer.
   * Nota: Introduce un retraso de (windowSize-1)/2 muestras.
   */
  static filterStream(buffer: number[], windowSize: 11 | 15 = 11): number {
    if (buffer.length < windowSize) return buffer[buffer.length - 1] || 0;
    
    const coeffs = windowSize === 11 ? this.COEFFS_11_O2 : this.COEFFS_15_O2;
    const half = Math.floor(windowSize / 2);
    const index = buffer.length - 1 - half;
    
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += buffer[index - half + j] * coeffs[j];
    }
    return sum;
  }
}
