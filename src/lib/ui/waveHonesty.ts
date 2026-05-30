import { clamp } from '@/utils/math';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

/**
 * HONESTIDAD DE AMPLITUD DE LA ONDA.
 *
 * Problema: el bandpass convierte CUALQUIER ruido en una oscilación suave, y el
 * AGC + la auto-escala del renderer lo estiran a amplitud fija → la app dibujaba
 * "ondas hermosas" de objetos inertes (mantel, piso). Eso es fabricación, no
 * medición.
 *
 * Solución (sin trabas binarias): la altura de la onda en pantalla se MULTIPLICA
 * por la FUERZA PULSÁTIL REAL [0..1], que exige DOS cosas físicas a la vez:
 *   - perfusión (AC/DC): un objeto inerte tiene AC/DC ≈ ruido;
 *   - periodicidad (autocorrelación): un pulso real es periódico a frecuencia
 *     cardíaca; un objeto movido/temblor NO lo es de forma sostenida.
 * Producto de ambas → un objeto inerte (o movido) da ~0 → línea PLANA (honesto);
 * un dedo real da ~1 → onda proporcional. Continuo, no es un "bloqueo".
 */
export function realSignalStrength(perfusionIndex: number, periodicity: number): number {
  const Q = VITAL_THRESHOLDS.QUALITY;
  const perf = clamp(
    (perfusionIndex - Q.WAVE_PI_FLOOR) / Math.max(1e-9, Q.WAVE_PI_REF - Q.WAVE_PI_FLOOR),
    0,
    1,
  );
  const per = clamp(periodicity / Math.max(1e-9, Q.WAVE_PERIODICITY_REF), 0, 1);
  return perf * per;
}
