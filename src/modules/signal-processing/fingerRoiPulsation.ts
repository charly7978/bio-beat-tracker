/**
 * Variación temporal del canal R en el ROI — refuerza contacto dedo+flash
 * frente a objetos rojos estáticos (práctica habitual en rPPG / cPPG).
 * Coeficiente de variación (std/mean) sobre ventana corta; sin datos sintéticos.
 */
export function redSeriesCoefficientOfVariation(
  samples: ArrayLike<number>,
  count?: number,
): number {
  const n = count ?? samples.length;
  if (n < 10) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] as number;
  const mean = sum / n;
  if (!Number.isFinite(mean) || Math.abs(mean) < 1e-4) return 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = (samples[i] as number) - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / (n - 1));
  return Number.isFinite(std) ? std / Math.abs(mean) : 0;
}
