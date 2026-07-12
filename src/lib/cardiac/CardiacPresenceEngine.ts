/**
 * CARDIAC PRESENCE ENGINE — motor de validez cardiorrespiratoria on-device.
 *
 * PRIMER PASO FUNDAMENTAL de la app: NO "detectar la figura de un dedo", sino
 * decidir si la señal óptica contiene un LATIDO CARDÍACO HUMANO GENUINO. Sin
 * pulso real → nada se mide (ni onda, ni BPM, ni SpO₂, ni PA, ni arritmias);
 * con pulso real → todo el pipeline se abre. Reemplaza al gate por firma de
 * color (hemoglobina/rojez), que abría vitales ante cualquier objeto rojo.
 *
 * Es un CLASIFICADOR DE VALIDEZ por FUSIÓN DE EVIDENCIA FISIOLÓGICA — el enfoque
 * validado por la mejor literatura de PPG por smartphone (Elgendi 2016 "Optimal
 * SQI"; Orphanidou 2015 template-matching; MDPI Sensors 2020 SQI; feature-
 * selection SQA 2022; SQA por dominio de frecuencia 2023-2025). Fusiona:
 *   1. Concentración espectral en banda cardíaca (pico estrecho vs. ruido plano)
 *   2. Estructura armónica (fundamental + 2º/3º armónico coherentes)
 *   3. Periodicidad (autocorrelación)
 *   4. Consistencia morfológica latido-a-latido (template matching)
 *   5. Skewness fisiológica (subida sistólica abrupta → asimetría positiva)
 *   6. Índice de perfusión en rango real
 *   7. Baja entropía espectral (energía concentrada, no de banda ancha)
 *   8. Plausibilidad fisiológica de la FC (banda + estabilidad temporal)
 * → confianza probabilística [0..1] con histéresis + dwell temporal: un latido
 * real es PERSISTENTE, así que "presente" exige que la confianza se sostenga
 * varios segundos, no un frame suelto.
 *
 * 100% on-device, offline, sin red, sin costo, privado.
 */
import { clamp } from '@/utils/math';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { bpmFromAutocorr } from '@/modules/signal-processing/shared/dsp';
import { beatTemplateConsistency } from './beatTemplate';

export interface CardiacPresenceSample {
  /** Señal filtrada en banda cardíaca (orden cronológico). */
  signal: number[];
  /** Frecuencia de muestreo real (Hz). */
  fs: number;
  /** Índice de perfusión AC/DC (0..1). */
  perfusionIndex: number;
  /** Skewness de la señal filtrada (ya cacheada por el procesador). */
  skewness: number;
  /** Movimiento efectivo (IMU + micro-movimiento), 0..~2. */
  motion: number;
  /** Frame ópticamente válido (ni saturado ni negro, brillo en rango). */
  opticalValid: boolean;
  /** Timestamp del frame (ms). */
  nowMs: number;
}

export interface CardiacSubScores {
  spectralConcentration: number;
  harmonic: number;
  periodicity: number;
  template: number;
  skewness: number;
  perfusion: number;
  entropy: number;
  bpmPlausibility: number;
}

export interface CardiacPresenceState {
  /** Confianza suavizada [0..1] (histéresis attack/release). */
  confidence: number;
  /** Confianza instantánea del frame [0..1]. */
  rawConfidence: number;
  /** ¿Hay un latido cardíaco humano genuino y sostenido? */
  present: boolean;
  /** BPM estimado por el fundamental espectral (0 si no hay pulso). */
  bpm: number;
  /** Frecuencia fundamental (Hz). */
  freqHz: number;
  subScores: CardiacSubScores;
  aboveEnterFrames: number;
  belowExitFrames: number;
  framesEvaluated: number;
  bpmHistory: number[];
}

const ZERO_SUBSCORES: CardiacSubScores = {
  spectralConcentration: 0,
  harmonic: 0,
  periodicity: 0,
  template: 0,
  skewness: 0,
  perfusion: 0,
  entropy: 0,
  bpmPlausibility: 0,
};

export function createCardiacPresence(): CardiacPresenceState {
  return {
    confidence: 0,
    rawConfidence: 0,
    present: false,
    bpm: 0,
    freqHz: 0,
    subScores: { ...ZERO_SUBSCORES },
    aboveEnterFrames: 0,
    belowExitFrames: 0,
    framesEvaluated: 0,
    bpmHistory: [],
  };
}

export function resetCardiacPresence(state: CardiacPresenceState): void {
  state.confidence = 0;
  state.rawConfidence = 0;
  state.present = false;
  state.bpm = 0;
  state.freqHz = 0;
  state.subScores = { ...ZERO_SUBSCORES };
  state.aboveEnterFrames = 0;
  state.belowExitFrames = 0;
  state.framesEvaluated = 0;
  state.bpmHistory.length = 0;
}

const TWO_PI = Math.PI * 2;

/** Magnitud² de una frecuencia puntual (Goertzel/DFT de un bin) sobre serie ya centrada. */
function binPower(centered: number[], fs: number, f: number): number {
  const n = centered.length;
  if (n < 2 || f <= 0 || f >= fs * 0.5) return 0;
  const w = (TWO_PI * f) / fs;
  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  let cw = 1;
  let sw = 0;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    re += centered[i] * cw;
    im += centered[i] * sw;
    const nextCw = cw * cosW - sw * sinW;
    sw = sw * cosW + cw * sinW;
    cw = nextCw;
  }
  return re * re + im * im;
}

interface BandScan {
  freqHz: number;
  concentration: number;
  entropy: number;
  totalTimePower: number;
  centered: number[];
}

/**
 * Un solo barrido del periodograma sobre la banda cardíaca. Devuelve el
 * fundamental, la concentración espectral normalizada (≈1 onda pura, ≈0 ruido)
 * y la entropía espectral normalizada (0 concentrada, 1 plana/ruido).
 */
function scanBand(
  signal: number[],
  fs: number,
  fMinHz: number,
  fMaxHz: number,
): BandScan {
  const n = signal.length;
  const empty: BandScan = { freqHz: 0, concentration: 0, entropy: 1, totalTimePower: 0, centered: [] };
  const fMax = Math.min(fMaxHz, fs * 0.5 - 1e-6);
  if (n < 8 || fs <= 0 || fMax <= fMinHz) return empty;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += signal[i];
  mean /= n;
  const centered = new Array<number>(n);
  let totalTimePower = 0;
  for (let i = 0; i < n; i++) {
    const c = signal[i] - mean;
    centered[i] = c;
    totalTimePower += c * c;
  }
  if (totalTimePower < 1e-12) return { ...empty, centered };

  const steps = clamp(Math.round((fMax - fMinHz) / 0.01), 48, 512);
  const mags = new Array<number>(steps + 1);
  let bestMag = 0;
  let bestF = 0;
  let sumMag = 0;
  for (let s = 0; s <= steps; s++) {
    const f = fMinHz + ((fMax - fMinHz) * s) / steps;
    const mag = binPower(centered, fs, f);
    mags[s] = mag;
    sumMag += mag;
    if (mag > bestMag) {
      bestMag = mag;
      bestF = f;
    }
  }

  const concentration = clamp((2 * bestMag) / (n * totalTimePower), 0, 1);

  // Entropía de Shannon del espectro de banda, normalizada a [0..1].
  let entropy = 1;
  if (sumMag > 1e-12) {
    let h = 0;
    for (let s = 0; s <= steps; s++) {
      const p = mags[s] / sumMag;
      if (p > 1e-12) h -= p * Math.log(p);
    }
    entropy = clamp(h / Math.log(steps + 1), 0, 1);
  }

  return { freqHz: bestF, concentration, entropy, totalTimePower, centered };
}

function norm(v: number, lo: number, hi: number): number {
  if (hi <= lo) return 0;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

/** Confianza instantánea [0..1] fusionando la evidencia fisiológica del frame. */
export function computeInstantConfidence(
  sample: CardiacPresenceSample,
  state: CardiacPresenceState,
): number {
  const C = VITAL_THRESHOLDS.CARDIAC_PRESENCE;
  const { signal, fs } = sample;

  // Sin frame óptico válido o sin suficiente señal → no puede haber pulso.
  const minSamples = Math.max(24, Math.floor(fs * C.MIN_WINDOW_SEC));
  if (!sample.opticalValid || signal.length < minSamples || fs <= 0) {
    state.subScores = { ...ZERO_SUBSCORES };
    state.freqHz = 0;
    state.bpm = 0;
    return 0;
  }

  const fMin = C.BAND_MIN_HZ;
  const fMax = C.BAND_MAX_HZ;
  const scan = scanBand(signal, fs, fMin, fMax);
  const f0 = scan.freqHz;
  const bpm = f0 * 60;

  // Estructura armónica: energía coherente en 2·f0 y 3·f0 relativa al fundamental.
  let harmonic = 0;
  if (f0 > 0 && scan.centered.length > 0) {
    const p1 = binPower(scan.centered, fs, f0);
    const p2 = binPower(scan.centered, fs, 2 * f0);
    const p3 = binPower(scan.centered, fs, 3 * f0);
    if (p1 > 1e-12) {
      // Fracción de energía armónica sobre el total fundamental+armónicos:
      // el pulso real reparte energía en 2º/3º; el ruido/flicker casi no.
      harmonic = clamp((p2 + p3) / (p1 + p2 + p3), 0, 1);
    }
  }

  const ac = bpmFromAutocorr(signal, fs);
  const periodicity = ac.score;
  const template = beatTemplateConsistency(signal, fs, bpm);

  // Estabilidad de la FC: dispersión del BPM del fundamental en la ventana.
  if (f0 > 0 && scan.concentration > C.SPEC_CONC_LO) {
    state.bpmHistory.push(bpm);
    if (state.bpmHistory.length > C.BPM_HISTORY) state.bpmHistory.shift();
  }
  let bpmStability = 0;
  if (state.bpmHistory.length >= 3) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const b of state.bpmHistory) {
      if (b < mn) mn = b;
      if (b > mx) mx = b;
    }
    bpmStability = 1 - clamp((mx - mn) / C.BPM_SPREAD_MAX, 0, 1);
  }
  const inBand = bpm >= C.MIN_BPM && bpm <= C.MAX_BPM;
  const bpmPlausibility = inBand ? bpmStability : 0;

  const sub: CardiacSubScores = {
    spectralConcentration: norm(scan.concentration, C.SPEC_CONC_LO, C.SPEC_CONC_HI),
    harmonic: norm(harmonic, C.HARMONIC_LO, C.HARMONIC_HI),
    periodicity: norm(periodicity, C.PERIODICITY_LO, C.PERIODICITY_HI),
    template: norm(template, C.TEMPLATE_LO, C.TEMPLATE_HI),
    skewness: norm(sample.skewness, C.SKEW_LO, C.SKEW_HI),
    perfusion: norm(sample.perfusionIndex, C.PI_LO, C.PI_HI),
    entropy: norm(1 - scan.entropy, C.ENTROPY_LO, C.ENTROPY_HI),
    bpmPlausibility,
  };
  state.subScores = sub;
  state.freqHz = f0;
  state.bpm = inBand ? bpm : 0;

  const W = C.WEIGHTS;
  let fused =
    sub.spectralConcentration * W.spectralConcentration +
    sub.harmonic * W.harmonic +
    sub.periodicity * W.periodicity +
    sub.template * W.template +
    sub.skewness * W.skewness +
    sub.perfusion * W.perfusion +
    sub.entropy * W.entropy +
    sub.bpmPlausibility * W.bpmPlausibility;

  // Vetos fisiológicos duros: sin fundamental en banda o sin morfología repetible
  // no puede afirmarse pulso, por muy "brillante" que sea la escena.
  if (!inBand) fused *= 0.25;
  if (template <= 0 && periodicity < C.PERIODICITY_LO) fused *= 0.35;

  // El movimiento degrada (no anula): un latido fuerte sobrevive a temblor leve.
  const motionPenalty = clamp((sample.motion - C.MOTION_TOLERANCE) / C.MOTION_TOLERANCE, 0, 1);
  fused *= 1 - motionPenalty * 0.6;

  return clamp(fused, 0, 1);
}

/**
 * Avanza el motor un frame. Muta y devuelve `state` (hot-path, sin allocs).
 * Aplica histéresis attack/release a la confianza y un latch con dwell temporal
 * para declarar (o retirar) la presencia de pulso de forma firme y sin parpadeo.
 */
export function updateCardiacPresence(
  state: CardiacPresenceState,
  sample: CardiacPresenceSample,
): CardiacPresenceState {
  const C = VITAL_THRESHOLDS.CARDIAC_PRESENCE;

  const instant = computeInstantConfidence(sample, state);
  state.rawConfidence = instant;
  state.framesEvaluated++;

  const alpha = instant >= state.confidence ? C.CONF_ATTACK : C.CONF_RELEASE;
  state.confidence = state.confidence + (instant - state.confidence) * alpha;
  if (state.confidence < 1e-3) state.confidence = 0;

  if (state.confidence >= C.CONF_ENTER) {
    state.aboveEnterFrames = Math.min(state.aboveEnterFrames + 1, C.ENTER_DWELL_FRAMES);
  } else {
    state.aboveEnterFrames = 0;
  }
  if (state.confidence < C.CONF_EXIT) {
    state.belowExitFrames = Math.min(state.belowExitFrames + 1, C.EXIT_DWELL_FRAMES);
  } else {
    state.belowExitFrames = 0;
  }

  if (state.present) {
    if (state.belowExitFrames >= C.EXIT_DWELL_FRAMES) {
      state.present = false;
      state.bpmHistory.length = 0;
    }
  } else if (
    state.aboveEnterFrames >= C.ENTER_DWELL_FRAMES &&
    state.framesEvaluated >= C.WARMUP_FRAMES
  ) {
    state.present = true;
  }

  if (!state.present && state.confidence < C.CONF_EXIT) {
    state.bpm = 0;
    state.freqHz = 0;
  }

  return state;
}
