/**
 * Utilidades matemáticas compartidas.
 * Evita duplicar helpers numéricos en cada módulo del pipeline.
 */

/** Clamp numérico — limita `value` al rango [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
