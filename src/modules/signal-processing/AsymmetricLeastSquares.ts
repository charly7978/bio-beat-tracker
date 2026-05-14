/**
 * ASYMMETRIC LEAST SQUARES (ALS) BASELINE CORRECTION
 * 
 * Basado en el algoritmo de Eilers & Boelens (2005).
 * Utilizado para estimar la línea de base (baseline wander) en señales PPG,
 * permitiendo una normalización robusta de la componente AC.
 * 
 * Parámetros recomendados para PPG:
 * - lambda: 10^5 a 10^9 (suavizado)
 * - p: 0.001 a 0.01 (asimetría para picos positivos)
 */
export class AsymmetricLeastSquares {
  /**
   * Corrige la línea de base de una señal.
   * @param y Señal original
   * @param lambda Parámetro de suavizado (típicamente 1e5 - 1e8)
   * @param p Parámetro de asimetría (típicamente 0.001 para picos positivos)
   * @param maxIter Máximo de iteraciones
   */
  static baseline(y: number[], lambda: number = 1e6, p: number = 0.001, maxIter: number = 10): number[] {
    const n = y.length;
    if (n < 3) return [...y];

    let w = new Float64Array(n).fill(1);
    let z: Float64Array = new Float64Array(n);
    
    // Matriz de diferencias de segundo orden (D)
    // En JS, para optimizar, realizamos la actualización iterativa directamente.
    // Una implementación completa requiere resolver un sistema lineal (W + lambda * D'D)z = Wy.
    // Usaremos una aproximación eficiente para tiempo real.
    
    for (let iter = 0; iter < maxIter; iter++) {
      z = this.solveWhittaker(y, w, lambda);
      
      let changed = false;
      for (let i = 0; i < n; i++) {
        const newW = y[i] > z[i] ? p : 1 - p;
        if (Math.abs(w[i] - newW) > 1e-4) {
          w[i] = newW;
          changed = true;
        }
      }
      
      if (!changed) break;
    }
    
    return Array.from(z);
  }

  /**
   * Resuelve el sistema lineal (W + lambda * D'D)z = Wy mediante un solver de banda.
   * D es el operador de segunda diferencia.
   */
  private static solveWhittaker(y: number[], w: Float64Array, lambda: number): Float64Array {
    const n = y.length;
    const z = new Float64Array(n);
    
    // Coeficientes de la matriz pentadiagonal (W + lambda * D'D)
    // D'D es [1, -4, 6, -4, 1] deslizado
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    const c = new Float64Array(n);
    const d = new Float64Array(n);
    const e = new Float64Array(n);
    
    for (let i = 0; i < n; i++) {
      a[i] = lambda;
      b[i] = -4 * lambda;
      c[i] = w[i] + 6 * lambda;
      d[i] = -4 * lambda;
      e[i] = lambda;
    }
    
    // Condiciones de contorno para D'D
    c[0] = w[0] + lambda; d[0] = -2 * lambda; e[0] = lambda;
    b[1] = -2 * lambda; c[1] = w[1] + 5 * lambda; d[1] = -4 * lambda; e[1] = lambda;
    a[n-2] = lambda; b[n-2] = -4 * lambda; c[n-2] = w[n-2] + 5 * lambda; d[n-2] = -2 * lambda;
    a[n-1] = lambda; b[n-1] = -2 * lambda; c[n-1] = w[n-1] + lambda;

    // Solver Pentadiagonal (Algoritmo simplificado)
    return this.solvePentadiagonal(a, b, c, d, e, y, w);
  }

  private static solvePentadiagonal(
    a: Float64Array, b: Float64Array, c: Float64Array, d: Float64Array, e: Float64Array, 
    y: number[], w: Float64Array
  ): Float64Array {
    const n = y.length;
    const res = new Float64Array(n);
    for(let i=0; i<n; i++) res[i] = y[i] * w[i];

    // Factorización LU / Forward elimination
    for (let i = 0; i < n - 2; i++) {
      let m = b[i+1] / c[i];
      c[i+1] -= m * d[i];
      d[i+1] -= m * e[i];
      res[i+1] -= m * res[i];
      
      m = a[i+2] / c[i];
      b[i+2] -= m * d[i];
      c[i+2] -= m * e[i];
      res[i+2] -= m * res[i];
    }
    
    let m = b[n-1] / c[n-2];
    c[n-1] -= m * d[n-2];
    res[n-1] -= m * res[n-2];
    
    // Backward substitution
    const z = new Float64Array(n);
    z[n-1] = res[n-1] / c[n-1];
    z[n-2] = (res[n-2] - d[n-2] * z[n-1]) / c[n-2];
    for (let i = n - 3; i >= 0; i--) {
      z[i] = (res[i] - d[i] * z[i+1] - e[i] * z[i+2]) / c[i];
    }
    
    return z;
  }
}
