import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { clamp } from '@/utils/math';
import { detrendLinear, powerAtFrequency } from '@/modules/signal-processing/shared/dsp';

/**
 * VERIFICACIÓN FISIOLÓGICA DEL PULSO — ¿hay un latido REAL en esta señal?
 *
 * Reemplaza a la detección de dedo por color como criterio para publicar signos
 * vitales. El motivo es concreto: los gates de color responden a "qué tan rojo
 * está el píxel", de modo que una pared beige bajo la linterna los satisface, y
 * los gates fisiológicos que venían detrás estaban puestos a nivel de RUIDO
 * (PI ≥ 0,0036 % frente a un dedo real de 0,5–2 %, ~139× por debajo). Resultado:
 * la app producía una medición completa apuntando a cualquier lado.
 *
 * La discriminación correcta no es cromática sino TEMPORAL: el ruido puede tener
 * cualquier color y cualquier amplitud, pero NO puede sostener la morfología
 * repetible de un latido ni concentrar su potencia en una fundamental cardíaca
 * con sus armónicos. Cuatro evidencias independientes, todas de literatura:
 *
 *  1. ÍNDICE DE PERFUSIÓN (AC/DC). Dedo sano: 0,5–2 % (≈1 % típico en piel). La
 *     cámara atenúa respecto de un oxímetro transmisivo, así que el piso se fija
 *     por debajo de ese rango pero MUY por encima del ruido de sensor.
 *  2. CORRELACIÓN CONTRA PLANTILLA DE LATIDO (Orphanidou / template matching):
 *     se promedian los últimos latidos en una plantilla y se correlaciona cada
 *     latido contra ella. Literatura: r ≥ 0,86 = limpio. Es el discriminante más
 *     fuerte — el ruido no repite forma de onda.
 *  3. CONCENTRACIÓN ARMÓNICA: un PPG limpio concentra su potencia en f0, 2·f0 y
 *     3·f0 (el pulso NO es sinusoidal: subida sistólica rápida + muesca dícrota).
 *     El artefacto dispersa la potencia fuera de esas bandas.
 *  4. SKEWNESS (Elgendi 2016, el mejor SQI individual): PPG limpio es positivo;
 *     ruido simétrico ≈0 o negativo. Llega ya calculada desde el procesador.
 *
 * Honestidad (AGENTS §5/§6): este módulo NO estima ni corrige ningún signo vital.
 * Solo responde si la observación física vigente sostiene una medición. Sin pulso
 * verificado no se publica nada — no hay valor retenido ni plausible que mostrar.
 */

export interface PulseEvidence {
  perfusionIndex: number;
  /** Correlación media de los latidos contra su plantilla promediada (0..1). */
  templateCorrelation: number;
  /** Potencia en f0+2f0+3f0 sobre la potencia total de la ventana (0..1). */
  harmonicConcentration: number;
  /** Skewness de la señal filtrada (Elgendi). */
  skewness: number;
  /** Frecuencia cardíaca dominante estimada por espectro (bpm; 0 si no hay). */
  dominantBpm: number;
  /** Latidos usados para la plantilla. */
  beatCount: number;
}

/**
 * Evidencia espectral y estadística que el verificador CONSUME, no recalcula.
 *
 * `PPGSignalProcessor` ya computa skewness y la potencia relativa en banda
 * cardíaca una vez por ventana (bloque throttled de SQI) y las publica en `sqm`.
 * Recalcularlas aquí sería trabajo doble sobre la misma señal: el barrido de
 * frecuencia es lo más caro del pipeline. El verificador solo añade lo que nadie
 * más calcula — la correlación de los latidos contra su plantilla.
 */
export interface PulseSignalInput {
  perfusionIndex: number;
  /** Potencia en f0+armónicos / potencia total (0..1). */
  harmonicConcentration: number;
  /** Fundamental cardíaca detectada (Hz); 0 si no hay. */
  dominantHz: number;
  /** Skewness de la señal filtrada (Elgendi). */
  skewness: number;
}

export interface PulseVerdict {
  /** Hay pulso cardíaco real verificado → se puede publicar. */
  confirmed: boolean;
  /** Confianza fisiológica combinada (0..1). */
  confidence: number;
  /** Criterio que impide confirmar (diagnóstico honesto). */
  reason: string;
  evidence: PulseEvidence;
}

export interface PulseVerifierState {
  samples: number[];
  times: number[];
  peakTimes: number[];
  confirmStreak: number;
  releaseStreak: number;
  confirmed: boolean;
  throttle: number;
  lastVerdict: PulseVerdict;
}

const EMPTY_EVIDENCE: PulseEvidence = {
  perfusionIndex: 0,
  templateCorrelation: 0,
  harmonicConcentration: 0,
  skewness: 0,
  dominantBpm: 0,
  beatCount: 0,
};

export function createPulseVerifier(): PulseVerifierState {
  return {
    samples: [],
    times: [],
    peakTimes: [],
    confirmStreak: 0,
    releaseStreak: 0,
    confirmed: false,
    throttle: 0,
    lastVerdict: {
      confirmed: false,
      confidence: 0,
      reason: 'NO_DATA',
      evidence: EMPTY_EVIDENCE,
    },
  };
}

export function resetPulseVerifier(state: PulseVerifierState): void {
  state.samples.length = 0;
  state.times.length = 0;
  state.peakTimes.length = 0;
  state.confirmStreak = 0;
  state.releaseStreak = 0;
  state.confirmed = false;
  state.throttle = 0;
  state.lastVerdict = {
    confirmed: false,
    confidence: 0,
    reason: 'NO_DATA',
    evidence: EMPTY_EVIDENCE,
  };
}

/** Alimenta una muestra de la señal filtrada y, si lo hubo, el instante del pico. */
export function pushPulseSample(
  state: PulseVerifierState,
  value: number,
  tMs: number,
  isPeak: boolean,
): void {
  const P = VITAL_THRESHOLDS.PULSE_VERIFICATION;
  state.samples.push(value);
  state.times.push(tMs);
  if (state.samples.length > P.WINDOW_SAMPLES) {
    state.samples.shift();
    state.times.shift();
  }
  if (isPeak) {
    state.peakTimes.push(tMs);
    if (state.peakTimes.length > P.MAX_TRACKED_BEATS) state.peakTimes.shift();
  }
  const cutoff = tMs - P.PEAK_HISTORY_MS;
  while (state.peakTimes.length > 0 && state.peakTimes[0]! < cutoff) {
    state.peakTimes.shift();
  }
}

/**
 * Fracción de la potencia total que vive en la fundamental cardíaca y sus dos
 * primeros armónicos. Un PPG real la concentra ahí; el artefacto la dispersa.
 */
export function harmonicConcentration(
  signal: number[],
  fsHz: number,
  f0Hz: number,
): number {
  const n = signal.length;
  if (n < 16 || f0Hz <= 0) return 0;
  const det = detrendLinear(signal);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += det[i]!;
  mean /= n;
  let totalPower = 0;
  const centered = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = det[i]! - mean;
    centered[i] = c;
    totalPower += c * c;
  }
  totalPower /= n;
  if (totalPower < 1e-12) return 0;

  let harmonic = 0;
  for (let k = 1; k <= VITAL_THRESHOLDS.PULSE_VERIFICATION.HARMONICS; k++) {
    const f = f0Hz * k;
    if (f >= fsHz / 2) break;
    harmonic += powerAtFrequency(centered, fsHz, f);
  }
  // El factor 2 recupera la potencia del bin conjugado negativo.
  return clamp((2 * harmonic) / totalPower, 0, 1);
}

/**
 * Correlación media de cada latido contra la plantilla promediada del resto
 * (ensemble averaging + Pearson). Devuelve 0 si no hay latidos suficientes.
 */
export function beatTemplateCorrelation(beats: number[][]): number {
  const m = beats.length;
  if (m < 2) return 0;
  const len = beats[0]!.length;
  if (len < 4) return 0;

  const template = new Array<number>(len).fill(0);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let j = 0; j < m; j++) s += beats[j]![i]!;
    template[i] = s / m;
  }

  let acc = 0;
  for (const b of beats) acc += pearson(b, template);
  return clamp(acc / m, 0, 1);
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 4) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den < 1e-12 ? 0 : num / den;
}

/**
 * Extrae los latidos alineados al pico y remuestreados a longitud fija, para
 * poder promediarlos aunque el RR varíe (arritmia, HRV).
 */
export function extractBeats(
  samples: number[],
  times: number[],
  peakTimes: number[],
  beatLength: number,
): number[][] {
  const beats: number[][] = [];
  if (samples.length < beatLength || peakTimes.length < 2) return beats;

  for (let p = 1; p < peakTimes.length; p++) {
    const t0 = peakTimes[p - 1]!;
    const t1 = peakTimes[p]!;
    const span = t1 - t0;
    if (span <= 0) continue;
    const beat = new Array<number>(beatLength);
    let ok = true;
    for (let i = 0; i < beatLength; i++) {
      const t = t0 + (span * i) / (beatLength - 1);
      const v = sampleAt(samples, times, t);
      if (v === null) {
        ok = false;
        break;
      }
      beat[i] = v;
    }
    if (ok) beats.push(beat);
  }
  return beats;
}

/** Interpolación lineal de la señal en un instante arbitrario. */
function sampleAt(samples: number[], times: number[], t: number): number | null {
  const n = times.length;
  if (n === 0 || t < times[0]! || t > times[n - 1]!) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo]!;
  const t1 = times[hi]!;
  if (t1 === t0) return samples[lo]!;
  const w = (t - t0) / (t1 - t0);
  return samples[lo]! * (1 - w) + samples[hi]! * w;
}

/**
 * Evalúa la evidencia fisiológica acumulada y decide si hay pulso real.
 *
 * Requiere que TODAS las evidencias independientes se sostengan: perfusión por
 * encima del piso fisiológico, morfología de latido repetible, potencia
 * concentrada en la banda cardíaca y skewness no negativa. Es una conjunción a
 * propósito — cada una sola es falsificable por algún artefacto, las cuatro
 * juntas no lo son por ruido óptico.
 */
export function verifyPulse(
  state: PulseVerifierState,
  input: PulseSignalInput,
): PulseVerdict {
  const P = VITAL_THRESHOLDS.PULSE_VERIFICATION;
  const { perfusionIndex } = input;

  state.throttle++;
  if (state.throttle < P.THROTTLE_FRAMES && state.lastVerdict.reason !== 'NO_DATA') {
    return state.lastVerdict;
  }
  state.throttle = 0;

  if (state.samples.length < P.MIN_SAMPLES) {
    return applyVerdict(state, false, 0, 'WAIT_SAMPLES', {
      ...EMPTY_EVIDENCE,
      perfusionIndex,
    });
  }

  const f0 = input.dominantHz;
  const dominantBpm = f0 * 60;
  const hc = input.harmonicConcentration;
  const skew = input.skewness;
  const beats = extractBeats(state.samples, state.times, state.peakTimes, P.BEAT_LENGTH);
  const corr = beats.length >= P.MIN_BEATS_FOR_TEMPLATE
    ? beatTemplateCorrelation(beats)
    : 0;

  const evidence: PulseEvidence = {
    perfusionIndex,
    templateCorrelation: corr,
    harmonicConcentration: hc,
    skewness: skew,
    dominantBpm,
    beatCount: beats.length,
  };

  let reason = 'PULSE_VERIFIED';
  let pass = true;
  if (perfusionIndex < P.MIN_PERFUSION_INDEX) {
    pass = false;
    reason = 'NO_PERFUSION';
  } else if (f0 <= 0 || dominantBpm < VITAL_THRESHOLDS.HR.MIN) {
    pass = false;
    reason = 'NO_CARDIAC_FREQUENCY';
  } else if (hc < P.MIN_HARMONIC_CONCENTRATION) {
    pass = false;
    reason = 'POWER_NOT_CARDIAC';
  } else if (beats.length < P.MIN_BEATS_FOR_TEMPLATE) {
    pass = false;
    reason = 'WAIT_BEATS';
  } else if (corr < P.MIN_TEMPLATE_CORRELATION) {
    pass = false;
    reason = 'BEAT_SHAPE_NOT_REPEATABLE';
  } else if (skew < P.MIN_SKEWNESS) {
    pass = false;
    reason = 'WAVEFORM_NOT_PPG_LIKE';
  }

  const confidence = clamp(
    clamp(perfusionIndex / (P.MIN_PERFUSION_INDEX * P.CONF_PERFUSION_REF_MULT), 0, 1) *
      P.W_PERFUSION +
      clamp(corr / P.CONF_TEMPLATE_REF, 0, 1) * P.W_TEMPLATE +
      clamp(hc / P.CONF_HARMONIC_REF, 0, 1) * P.W_HARMONIC +
      clamp((skew + P.CONF_SKEW_OFFSET) / P.CONF_SKEW_SPAN, 0, 1) * P.W_SKEWNESS,
    0,
    1,
  );

  return applyVerdict(state, pass, confidence, reason, evidence);
}

/**
 * Histéresis del veredicto: confirmar exige evidencia sostenida (no un frame
 * afortunado) y perderla exige que la evidencia falte de forma sostenida (para
 * que un latido mal segmentado no corte una medición en curso).
 */
function applyVerdict(
  state: PulseVerifierState,
  pass: boolean,
  confidence: number,
  reason: string,
  evidence: PulseEvidence,
): PulseVerdict {
  const P = VITAL_THRESHOLDS.PULSE_VERIFICATION;
  if (pass) {
    state.confirmStreak++;
    state.releaseStreak = 0;
    if (state.confirmStreak >= P.CONFIRM_EVALUATIONS) state.confirmed = true;
  } else {
    state.releaseStreak++;
    state.confirmStreak = 0;
    if (state.releaseStreak >= P.RELEASE_EVALUATIONS) state.confirmed = false;
  }

  state.lastVerdict = {
    confirmed: state.confirmed,
    confidence: state.confirmed
      ? confidence
      : Math.min(confidence, P.UNCONFIRMED_CONFIDENCE_CAP),
    reason: state.confirmed ? 'PULSE_VERIFIED' : reason,
    evidence,
  };
  return state.lastVerdict;
}
