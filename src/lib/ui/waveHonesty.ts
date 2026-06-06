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
 * Solución: la altura de la onda se MULTIPLICA por la FUERZA PULSÁTIL REAL [0..1]
 * que pondera perfusión (60%) y periodicidad (40%). Un objeto inerte tiene ambas
 * cerca de 0 → línea plana. Un dedo real tiene al menos una de las dos → la onda
 * emerge gradualmente. Esto evita el "todo o nada" y da retroalimentación visual
 * incluso con señal débil, mientras sigue siendo honesto (no inventa ondas).
 *
 * La combinación lineal (perf 60% + per 40%) reemplaza el producto estricto
 * anterior que exigía AMBAS al máximo, causando que señales débiles pero reales
 * se vieran como línea plana.
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
