import type { RoiSample } from './roiSampler';

/**
 * COMPONENTES AC Y DC POR CANAL — insumo del cálculo de SpO2.
 *
 * SpO2 por ratio-of-ratios necesita, para dos longitudes de onda, la parte
 * pulsátil (AC) y la no pulsátil (DC):
 *
 *     R = (AC_rojo / DC_rojo) / (AC_verde / DC_verde)
 *
 * Se calcula aquí, sobre las mismas muestras del ROI que alimentan la detección
 * de latidos, para que exista UNA sola fuente de verdad por ventana. En el
 * pipeline anterior estos componentes salían de un banco de filtros paralelo
 * que podía divergir de la señal usada para los latidos.
 *
 * AC por rango robusto (p95 − p05) en vez de máximo − mínimo: un solo cuadro
 * saturado o perdido dispara el rango absoluto e inventa amplitud pulsátil que
 * no existe, lo que se traduce en una SpO2 fabricada.
 */

export interface ChannelAcDc {
  acRed: number;
  dcRed: number;
  acGreen: number;
  dcGreen: number;
  acBlue: number;
  dcBlue: number;
}

const EMPTY: ChannelAcDc = {
  acRed: 0,
  dcRed: 0,
  acGreen: 0,
  dcGreen: 0,
  acBlue: 0,
  dcBlue: 0,
};

export function computeChannelAcDc(samples: RoiSample[]): ChannelAcDc {
  if (samples.length < 8) return { ...EMPTY };
  return {
    ...acDc(samples.map((s) => s.red), 'Red'),
    ...acDc(samples.map((s) => s.green), 'Green'),
    ...acDc(samples.map((s) => s.blue), 'Blue'),
  } as ChannelAcDc;
}

function acDc(values: number[], suffix: 'Red' | 'Green' | 'Blue'): Partial<ChannelAcDc> {
  const n = values.length;
  let dc = 0;
  for (let i = 0; i < n; i++) dc += values[i]!;
  dc /= n;

  const sorted = [...values].sort((a, b) => a - b);
  const p05 = sorted[Math.floor(n * 0.05)]!;
  const p95 = sorted[Math.floor(n * 0.95)]!;
  const ac = Math.max(0, p95 - p05);

  return {
    [`ac${suffix}`]: ac,
    [`dc${suffix}`]: dc,
  } as Partial<ChannelAcDc>;
}
