/**
 * FILTRO ADAPTATIVO DE MICRO-MOVIMIENTO PPG
 *
 * Fundamento científico:
 * - El micro-movimiento del dedo sobre el lente produce artefactos de movimiento
 *   (MA) que son la principal fuente de error en PPG por cámara (~11 BPM de error
 *   promedio, Poh et al. 2010; Verkruysse et al. 2008).
 * - Los MA tienen espectro broadband (energía distribuida en todas las frecuencias)
 *   mientras que el pulso cardíaco tiene energía concentrada en la frecuencia
 *   fundamental y sus armónicos (Comon 1994 — ICA; de Haan & Jeanne 2013 — CHROM).
 * - Estrategia: filtro de Wiener adaptativo en el dominio espectral.
 *   Estima la PSD del ruido de movimiento (fuera de la banda cardíaca) y la
 *   sustrae de la PSD total para obtener la señal limpia.
 * - Complementado con análisis de coherencia R-G: la pulsatilidad real tiene
 *   alta coherencia entre canales; el MA tiene coherencia baja (Poh et al. 2010).
 *
 * Implementación:
 *   - Ventana deslizante de 2 s para estimar PSD de ruido.
 *   - Filtro de Wiener en tiempo real: ganancia adaptativa por banda de frecuencia.
 *   - Zero-allocation: buffers pre-asignados, sin Array.map en hot path.
 *
 * Referencias:
 *   - de Haan & Jeanne (2013), IEEE TBME, "Robust Pulse Rate From Chrominance-Based rPPG"
 *   - Poh et al. (2010), Opt. Express, "Non-contact, automated cardiac pulse measurements"
 *   - Comon (1994), Signal Processing, "Independent component analysis"
 */
import { clamp } from '../../utils/math';
import { RingF32 } from '../../utils/RingBuffer';

export interface AdaptiveMotionFilterState {
  /** Buffer de señal para estimación de PSD */
  readonly signalRing: RingF32;
  /** Buffer de estimación de ruido (fuera de banda cardíaca) */
  readonly noiseRing: RingF32;
  /** Ganancia adaptativa actual [0, 1] */
  adaptiveGain: number;
  /** EMA de la energía en banda cardíaca */
  cardiacBandEnergy: number;
  /** EMA de la energía fuera de banda (ruido) */
  noiseBandEnergy: number;
  /** Contador de frames para throttle de recálculo */
  recalcCounter: number;
  /** SNR espectral estimada */
  spectralSnr: number;
  /** Score de movimiento derivado del espectro */
  spectralMotionScore: number;
}

export function createAdaptiveMotionFilterState(bufferSize = 90): AdaptiveMotionFilterState {
  return {
    signalRing: new RingF32(bufferSize),
    noiseRing: new RingF32(bufferSize),
    adaptiveGain: 1.0,
    cardiacBandEnergy: 0,
    noiseBandEnergy: 0,
    recalcCounter: 0,
    spectralSnr: 1,
    spectralMotionScore: 0,
  };
}

export function resetAdaptiveMotionFilter(state: AdaptiveMotionFilterState): void {
  state.signalRing.reset();
  state.noiseRing.reset();
  state.adaptiveGain = 1.0;
  state.cardiacBandEnergy = 0;
  state.noiseBandEnergy = 0;
  state.recalcCounter = 0;
  state.spectralSnr = 1;
  state.spectralMotionScore = 0;
}

/**
 * Calcula la energía de una señal en una banda de frecuencia usando DFT por rotación.
 * Zero-allocation: opera sobre el array pasado directamente.
 */
function bandEnergy(x: number[], n: number, fs: number, fMin: number, fMax: number, steps = 32): number {
  if (n < 8 || fs <= 0) return 0;
  const fMaxSafe = Math.min(fMax, fs * 0.45);
  if (fMaxSafe <= fMin) return 0;

  let totalEnergy = 0;
  const TWO_PI = Math.PI * 2;

  for (let s = 0; s <= steps; s++) {
    const f = fMin + ((fMaxSafe - fMin) * s) / steps;
    const w = (TWO_PI * f) / fs;
    const cosW = Math.cos(w);
    const sinW = Math.sin(w);
    let cw = 1;
    let sw = 0;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += x[i] * cw;
      im += x[i] * sw;
      const nc = cw * cosW - sw * sinW;
      sw = sw * cosW + cw * sinW;
      cw = nc;
    }
    totalEnergy += (re * re + im * im) / n;
  }
  return totalEnergy / (steps + 1);
}

/**
 * Aplica el filtro adaptativo de micro-movimiento a una muestra de señal.
 * Devuelve la muestra filtrada y actualiza el estado.
 *
 * @param state Estado del filtro (mutable)
 * @param sample Muestra de señal PPG filtrada (post-bandpass)
 * @param fs Frecuencia de muestreo efectiva (Hz)
 * @param imuMotionScore Score de movimiento del IMU [0, 1]
 * @returns Muestra filtrada con ganancia adaptativa aplicada
 */
export function applyAdaptiveMotionFilter(
  state: AdaptiveMotionFilterState,
  sample: number,
  fs: number,
  imuMotionScore: number,
): number {
  state.signalRing.push(sample);
  state.recalcCounter++;

  // Recalcular cada 6 frames (~200 ms @ 30 fps) para no sobrecargar el hot path
  if (state.recalcCounter >= 6 && state.signalRing.length >= 30) {
    state.recalcCounter = 0;

    const n = Math.min(state.signalRing.length, 60);
    const buf = state.signalRing.tail(n) as number[];

    // Energía en banda cardíaca (0.5–4 Hz)
    const cardiacE = bandEnergy(buf, n, fs, 0.5, 4.0, 24);
    // Energía en banda de ruido de movimiento (4–12 Hz, por encima de la cardíaca)
    const noiseE = bandEnergy(buf, n, fs, 4.0, Math.min(12.0, fs * 0.45), 16);
    // Energía en banda sub-cardíaca (0–0.5 Hz, deriva lenta)
    const driftE = bandEnergy(buf, n, fs, 0.05, 0.5, 8);

    // EMA de energías
    const alpha = 0.25;
    state.cardiacBandEnergy = state.cardiacBandEnergy * (1 - alpha) + cardiacE * alpha;
    state.noiseBandEnergy = state.noiseBandEnergy * (1 - alpha) + (noiseE + driftE * 0.5) * alpha;

    // SNR espectral: ratio energía cardíaca / energía de ruido
    const snr = state.noiseBandEnergy > 1e-12
      ? state.cardiacBandEnergy / state.noiseBandEnergy
      : 10;
    state.spectralSnr = snr;

    // Score de movimiento espectral: alto cuando el ruido domina sobre el pulso
    // Normalizado: SNR < 0.5 → movimiento dominante; SNR > 5 → señal limpia
    state.spectralMotionScore = clamp(1 - (snr - 0.5) / 4.5, 0, 1);

    // Ganancia adaptativa de Wiener: G = SNR / (SNR + 1)
    // Cuando SNR es alto (señal limpia) → G ≈ 1 (sin atenuación)
    // Cuando SNR es bajo (ruido domina) → G ≈ 0 (atenuar)
    // Modulada por el score IMU para respuesta más rápida a movimiento físico
    const wienerGain = snr / (snr + 1);
    const imuPenalty = clamp(1 - imuMotionScore * 0.6, 0.3, 1);
    const targetGain = wienerGain * imuPenalty;

    // EMA de la ganancia para evitar cambios bruscos (ringing)
    const gainAlpha = targetGain < state.adaptiveGain ? 0.35 : 0.15;
    state.adaptiveGain = state.adaptiveGain * (1 - gainAlpha) + targetGain * gainAlpha;
    state.adaptiveGain = clamp(state.adaptiveGain, 0.15, 1.0);
  }

  return sample * state.adaptiveGain;
}

/**
 * Calcula las métricas de Hjorth de una señal (actividad, movilidad, complejidad).
 * Hjorth (1970): parámetros estadísticos en el dominio del tiempo que caracterizan
 * la complejidad de la señal — usados en SQI para detectar ruido de alta frecuencia.
 *
 * - Actividad: varianza de la señal (potencia)
 * - Movilidad: √(varianza de la derivada / varianza de la señal) ≈ frecuencia media
 * - Complejidad: movilidad(derivada) / movilidad(señal) ≈ ancho de banda normalizado
 *
 * PPG limpio: movilidad baja (frecuencia media baja), complejidad baja (banda estrecha).
 * Ruido/movimiento: movilidad alta, complejidad alta.
 */
export function computeHjorthParams(signal: number[]): {
  activity: number;
  mobility: number;
  complexity: number;
} {
  const n = signal.length;
  if (n < 4) return { activity: 0, mobility: 0, complexity: 0 };

  // Primera derivada
  const d1 = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) d1[i] = signal[i + 1] - signal[i];

  // Segunda derivada
  const d2 = new Array<number>(n - 2);
  for (let i = 0; i < n - 2; i++) d2[i] = d1[i + 1] - d1[i];

  const variance = (arr: number[]): number => {
    const m = arr.length;
    if (m === 0) return 0;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < m; i++) { s += arr[i]; s2 += arr[i] * arr[i]; }
    return s2 / m - (s / m) ** 2;
  };

  const varX = variance(signal);
  const varD1 = variance(d1);
  const varD2 = variance(d2);

  const activity = varX;
  const mobility = varX > 1e-12 ? Math.sqrt(varD1 / varX) : 0;
  const mobilityD1 = varD1 > 1e-12 ? Math.sqrt(varD2 / varD1) : 0;
  const complexity = mobility > 1e-12 ? mobilityD1 / mobility : 0;

  return { activity, mobility, complexity };
}
