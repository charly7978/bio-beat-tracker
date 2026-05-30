import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

/**
 * ACONDICIONADOR ACTIVO DE SEÑAL (DSP en vivo, frame a frame).
 *
 * Toma la señal cruda y la ESTABILIZA activamente (no decide "cuándo mostrar":
 * TRABAJA la señal):
 *
 *  1) Estabilización de LÍNEA BASE: resta una EMA lenta → quita la deriva (la onda
 *     deja de irse para arriba/abajo y queda firme en la línea media).
 *  2) Denoise que PRESERVA PICOS (edge-preserving, tipo filtro bilateral): suaviza
 *     el ruido pequeño pero SIGUE los flancos/picos sistólicos grandes — el peso a
 *     la muestra nueva CRECE con la magnitud del cambio. Así reduce el jitter sin
 *     recortar el pulso real (a diferencia de un Hampel/mediana que sí lo recorta).
 *
 * Es trabajo computacional REAL sobre la señal MEDIDA (no fabrica nada): a un objeto
 * inerte le entra ruido y le sale ruido estabilizado (chico); a un dedo real le sale
 * un pulso limpio y firme.
 */

export interface ActiveStabilizerState {
  ema: number;
  baseline: number;
  initialized: boolean;
}

export function createActiveStabilizer(): ActiveStabilizerState {
  return { ema: 0, baseline: 0, initialized: false };
}

export function resetActiveStabilizer(state: ActiveStabilizerState): void {
  state.ema = 0;
  state.baseline = 0;
  state.initialized = false;
}

export function stabilizeSample(state: ActiveStabilizerState, x: number): number {
  const C = VITAL_THRESHOLDS.ACTIVE_STAB;
  if (!state.initialized) {
    state.baseline = x;
    state.ema = 0;
    state.initialized = true;
    return 0;
  }

  // 1) Línea base: EMA lenta (no alcanza a "comerse" el pulso) → resta la deriva.
  state.baseline = state.baseline * (1 - C.BASELINE_ALPHA) + x * C.BASELINE_ALPHA;
  const detrended = x - state.baseline;

  // 2) Denoise edge-preserving: alpha sube con |delta| → ruido (delta chico) se
  //    suaviza; pico/flanco (delta grande) se sigue (no se recorta).
  const delta = detrended - state.ema;
  const ad = Math.abs(delta) / Math.max(1e-9, C.EDGE_THRESHOLD);
  const alpha = Math.min(1, C.ALPHA_MIN + (1 - C.ALPHA_MIN) * ad);
  state.ema = state.ema * (1 - alpha) + detrended * alpha;
  return state.ema;
}
