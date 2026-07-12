/**
 * Funciones de puntuación SUAVES para el modelo de emisión del motor.
 *
 * La clave del enfoque de razonamiento (vs. gate ON/OFF) es que las evidencias
 * se convierten en verosimilitudes CONTINUAS, no en decisiones binarias por
 * umbral. Estas funciones mapean una magnitud física a [0,1] de forma suave.
 */
import { clamp } from '../../utils/math';

/** Rampa suave (smoothstep de Hermite) de 0 a 1 entre `edge0` y `edge1`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Rampa descendente suave (1 → 0). */
export function smoothstepDown(edge0: number, edge1: number, x: number): number {
  return 1 - smoothstep(edge0, edge1, x);
}

/**
 * Campana gaussiana centrada en `center` con ancho `sigma` — verosimilitud de
 * que `x` provenga de una distribución centrada en `center`.
 */
export function gaussianBand(center: number, sigma: number, x: number): number {
  if (sigma <= 0) return x === center ? 1 : 0;
  const z = (x - center) / sigma;
  return Math.exp(-0.5 * z * z);
}

/**
 * Verosimilitud de plateau: ≈1 dentro de [lo, hi] con caídas gaussianas suaves
 * fuera del rango. Útil para "esta magnitud está en rango fisiológico".
 */
export function plateau(lo: number, hi: number, sigma: number, x: number): number {
  if (x < lo) return gaussianBand(lo, sigma, x);
  if (x > hi) return gaussianBand(hi, sigma, x);
  return 1;
}

/** Media geométrica de un conjunto de verosimilitudes (AND suave). */
export function softAnd(...values: number[]): number {
  if (values.length === 0) return 0;
  let logSum = 0;
  for (const v of values) logSum += Math.log(clamp(v, 1e-6, 1));
  return Math.exp(logSum / values.length);
}
