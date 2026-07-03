import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { ContactState } from '@/types/signal';

/**
 * ACQUISITION STABILIZER (módulo puro, sin estado global)
 *
 * Convierte las métricas que el pipeline YA calcula por frame en una
 * señal de adquisición firme y sin parpadeo para la UX inicial:
 *   - una confianza suavizada [0..1] con ataque/relajación asimétricos,
 *   - un estado SEARCHING → STABILIZING → READY con histéresis + dwell,
 *   - un progreso monótono [0..1] para la barra de "estabilizando".
 *
 * No recalcula baselines RGB ni outliers: esa responsabilidad vive en
 * PPGSignalProcessor. Aquí solo se fusionan métricas y se aplica memoria
 * temporal, evitando duplicar lógica del procesador.
 */

export type AcquisitionStage = 'SEARCHING' | 'STABILIZING' | 'READY';

/** Métricas instantáneas (ya calculadas por el procesador) para un frame. */
export interface AcquisitionSample {
  fingerDetected: boolean;
  contactState: ContactState;
  /** PI AC/DC (cámara: ~1e-4 .. 1e-2). */
  perfusionIndex: number;
  /** Autocorrelación de la señal filtrada (0..1) — proxy de regularidad de pulso. */
  periodicity: number;
  /** SQI crudo 0..100. */
  sqi: number;
  /** Movimiento IMU/escena (0..~2). */
  motionScore: number;
  /** Cobertura del ROI por tiles "dedo" (0..1). */
  coverageRatio: number;
}

export interface AcquisitionState {
  confidence: number;
  stage: AcquisitionStage;
  progress: number;
  framesInContact: number;
  aboveEnterFrames: number;
  belowExitFrames: number;
}

export function createAcquisitionState(): AcquisitionState {
  return {
    confidence: 0,
    stage: 'SEARCHING',
    progress: 0,
    framesInContact: 0,
    aboveEnterFrames: 0,
    belowExitFrames: 0,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Confianza instantánea fusionando las métricas del frame (sin memoria). */
export function instantAcquisitionConfidence(sample: AcquisitionSample): number {
  const A = VITAL_THRESHOLDS.ACQUISITION;

  const piScore = clamp01(sample.perfusionIndex / A.PI_TARGET);
  const periodicityScore = clamp01(sample.periodicity / A.PERIODICITY_TARGET);
  const sqiScore = clamp01(sample.sqi / A.SQI_TARGET);
  const coverageScore = clamp01(sample.coverageRatio / A.COVERAGE_TARGET);

  const fused =
    piScore * A.W_PI +
    periodicityScore * A.W_PERIODICITY +
    sqiScore * A.W_SQI +
    coverageScore * A.W_COVERAGE;

  // El movimiento degrada la confianza de forma multiplicativa (no la anula).
  const motionPenalty = clamp01((sample.motionScore - A.MOTION_TOLERANCE) / A.MOTION_TOLERANCE);
  return clamp01(fused * (1 - motionPenalty * 0.5));
}

/**
 * Avanza el estado de adquisición un frame. Muta y devuelve `state`
 * (hot path: sin alocaciones). Cuando no hay contacto usable, la
 * confianza y el progreso decaen suavemente hacia SEARCHING.
 */
export function updateAcquisition(state: AcquisitionState, sample: AcquisitionSample): AcquisitionState {
  const A = VITAL_THRESHOLDS.ACQUISITION;
  const usableContact = sample.fingerDetected && sample.contactState !== 'NO_CONTACT';

  if (!usableContact) {
    state.framesInContact = 0;
    state.aboveEnterFrames = 0;
    state.belowExitFrames = Math.min(state.belowExitFrames + 1, A.EXIT_DWELL_FRAMES);
    state.confidence = state.confidence * (1 - A.CONF_RELEASE);
    state.progress = Math.max(0, state.progress - A.PROGRESS_DECAY * 2);
    if (state.confidence < 0.02) state.confidence = 0;
    state.stage = 'SEARCHING';
    return state;
  }

  state.framesInContact++;

  // Confianza suavizada: sube con CONF_ATTACK, baja con CONF_RELEASE (más lento).
  const instant = instantAcquisitionConfidence(sample);
  const alpha = instant >= state.confidence ? A.CONF_ATTACK : A.CONF_RELEASE;
  state.confidence = state.confidence + (instant - state.confidence) * alpha;

  // GATE DE PULSO REAL: sólo se declara READY si hay periodicidad genuina (pulso
  // periódico enganchado). Requisito NECESARIO además de la confianza — sin esto
  // el semáforo se ponía verde por cobertura+PI+SQI sin latido real ("verde falso").
  const hasRealPulse = sample.periodicity >= A.PERIODICITY_READY_FLOOR;

  // Conteo de dwell con histéresis para las transiciones de estado.
  if (state.confidence >= A.CONF_ENTER_READY && hasRealPulse) {
    state.aboveEnterFrames = Math.min(state.aboveEnterFrames + 1, A.READY_DWELL_FRAMES);
  } else {
    state.aboveEnterFrames = 0;
  }
  // Se abandona READY tanto por confianza baja como por pérdida del pulso real.
  if (state.confidence < A.CONF_EXIT_READY || !hasRealPulse) {
    state.belowExitFrames = Math.min(state.belowExitFrames + 1, A.EXIT_DWELL_FRAMES);
  } else {
    state.belowExitFrames = 0;
  }

  const warmedUp = state.framesInContact >= A.WARMUP_FRAMES;

  if (state.stage === 'READY') {
    // Solo se abandona READY tras EXIT_DWELL_FRAMES bajo el umbral de salida.
    if (state.belowExitFrames >= A.EXIT_DWELL_FRAMES) {
      state.stage = 'STABILIZING';
    }
  } else if (warmedUp && state.aboveEnterFrames >= A.READY_DWELL_FRAMES) {
    state.stage = 'READY';
  } else {
    state.stage = 'STABILIZING';
  }

  // Progreso UI: mezcla warm-up temporal y confianza relativa, suavizado y
  // mayormente monótono (sube limitado por frame, no retrocede de golpe).
  if (state.stage === 'READY') {
    state.progress = Math.min(1, state.progress + A.PROGRESS_MAX_RISE);
  } else {
    // El progreso refleja sobre todo la confianza real (se estanca si la señal
    // es pobre), no un temporizador — así la estabilización se siente real.
    const warmTerm = clamp01(state.framesInContact / A.WARMUP_FRAMES);
    const confTerm = clamp01(state.confidence / A.CONF_ENTER_READY);
    const target = clamp01(confTerm * 0.75 + warmTerm * 0.25) * 0.96;
    if (target > state.progress) {
      state.progress = Math.min(target, state.progress + A.PROGRESS_MAX_RISE);
    } else {
      state.progress = Math.max(target, state.progress - A.PROGRESS_DECAY);
    }
  }

  return state;
}

/** Conveniencia: ¿la adquisición está firme para revelar métricas en vivo? */
export function isAcquisitionReady(state: AcquisitionState): boolean {
  return state.stage === 'READY';
}
