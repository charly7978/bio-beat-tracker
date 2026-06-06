/**
 * FILTRO NOTCH ADAPTATIVO IIR — Supresión sintonizable de frecuencia estrecha.
 *
 * Diseñado para suprimir el segundo armónico de la frecuencia cardíaca (2×f_HR)
 * que corresponde a la muesca dicrota del PPG. Esta muesca, cuando se amplifica,
 * genera dobles conteos de pico en la detección de arritmias.
 *
 * Diseño: Biquad IIR 2° orden (RBJ cookbook — Robert Bristow-Johnson):
 *   H(z) = (1 - 2cos(w0)z⁻¹ + z⁻²) / (1 + α - 2cos(w0)z⁻¹ + (1-α)z⁻²)
 *   donde:
 *     w0 = 2π × f_notch / fs  (frecuencia normalizada)
 *     α  = sin(w0) / (2 × Q)  (ancho de banda del notch)
 *
 * Q alta (ej. 15–20) → notch muy estrecho → no afecta el pico sistólico adyacente.
 *
 * El filtro es ADAPTATIVO: recalcula coeficientes automáticamente cuando f_notch
 * cambia (cuando el BPM estimado cambia), con histeresis para evitar recálculos
 * excesivos.
 *
 * Uso típico:
 *   - Canal 5 (Arritmias): notch en 2 × f_HR para eliminar artefactos dicrotos
 *   - No usar si f_notch no es conocida (pasa la señal sin modificar)
 *
 * Referencias:
 *   - Bristow-Johnson, "Cookbook formulae for audio EQ biquad filter coefficients"
 *   - Elgendi 2013: interferencia dicrota en detección de picos PPG
 */

export interface AdaptiveNotchState {
  /** Coeficiente numerador b0, b1, b2 */
  b: [number, number, number];
  /** Coeficiente denominador a0, a1, a2 (a0 normalizado = 1) */
  a: [number, number, number];
  /** Historial de entrada x[n-1], x[n-2] */
  x: [number, number];
  /** Historial de salida y[n-1], y[n-2] */
  y: [number, number];
  /** Frecuencia de notch actual en Hz (para detectar cambios) */
  currentNotchHz: number;
  /** Frecuencia de muestreo */
  fs: number;
}

/**
 * Crea estado inicial del filtro notch adaptativo.
 * @param fs     Frecuencia de muestreo en Hz
 * @param Q      Factor de calidad (≥ 10 recomendado para notch estrecho)
 */
export function createAdaptiveNotchState(fs: number, Q = 18): AdaptiveNotchState {
  const state: AdaptiveNotchState = {
    b: [1, 0, 1],
    a: [1, 0, 0],
    x: [0, 0],
    y: [0, 0],
    currentNotchHz: 0,
    fs,
  };
  // Almacenar Q en closure con un campo auxiliar (TypeScript no tiene campos privados en interfaces)
  // Lo resolvemos almacenando Q en un campo auxiliar no tipado
  (state as unknown as Record<string, number>)._Q = Q;
  return state;
}

/**
 * Ajusta la frecuencia de notch. Recalcula coeficientes si cambia > 2%.
 * @param state      Estado del filtro
 * @param notchHz    Nueva frecuencia de notch en Hz (0 = desactivado)
 */
export function setNotchFrequency(state: AdaptiveNotchState, notchHz: number): void {
  if (notchHz <= 0 || notchHz >= state.fs / 2) {
    // Frecuencia inválida o fuera de rango → filtro pass-through
    state.b = [1, 0, 0];
    state.a = [1, 0, 0];
    state.currentNotchHz = 0;
    return;
  }

  // Histeresis: recalcular solo si cambió > 2%
  if (
    state.currentNotchHz > 0 &&
    Math.abs(notchHz - state.currentNotchHz) / state.currentNotchHz < 0.02
  ) {
    return;
  }

  const Q = (state as unknown as Record<string, number>)['_Q'] ?? 18;
  const w0 = 2 * Math.PI * notchHz / state.fs;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);

  // RBJ notch coefficients (normalizado por a0 = 1 + alpha)
  const a0 = 1 + alpha;
  state.b = [1 / a0, -2 * cosW0 / a0, 1 / a0];
  state.a = [1, -2 * cosW0 / a0, (1 - alpha) / a0];
  state.currentNotchHz = notchHz;
}

/**
 * Filtra una muestra con el notch actual.
 * Si el notch no está configurado (f=0), pasa la señal sin modificar.
 */
export function applyAdaptiveNotch(state: AdaptiveNotchState, input: number): number {
  if (!isFinite(input)) return 0;

  // Sin notch configurado → pass-through
  if (state.currentNotchHz <= 0) return input;

  const [b0, b1, b2] = state.b;
  const [, a1, a2] = state.a;

  const y0 =
    b0! * input +
    b1! * state.x[0] +
    b2! * state.x[1] -
    a1! * state.y[0] -
    a2! * state.y[1];

  // Anti-overflow
  const yOut = isFinite(y0) && Math.abs(y0) < 1e10 ? y0 : 0;

  // Actualizar historial
  state.x[1] = state.x[0];
  state.x[0] = input;
  state.y[1] = state.y[0];
  state.y[0] = yOut;

  return yOut;
}

/** Reinicia el historial del filtro (nueva sesión). */
export function resetAdaptiveNotch(state: AdaptiveNotchState): void {
  state.x = [0, 0];
  state.y = [0, 0];
}

/**
 * Actualiza el notch basado en BPM conocido.
 * El segundo armónico de la muesca dicrota ≈ 2 × f_HR.
 * @param state   Estado del notch
 * @param bpm     BPM estimado actual (0 = desactivar notch)
 */
export function updateNotchFromBpm(state: AdaptiveNotchState, bpm: number): void {
  if (bpm <= 0) {
    setNotchFrequency(state, 0);
    return;
  }
  const fHr = bpm / 60;
  // El segundo armónico del pulso (donde aparece la muesca dicrota en espectro)
  const fNotch = fHr * 2;
  setNotchFrequency(state, fNotch);
}
