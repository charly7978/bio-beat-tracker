import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

/**
 * ESTABILIZACIÓN POR CONVERGENCIA (criterio REAL, no por tiempo).
 *
 * Decide cuándo la medición es CONFIABLE para revelar la onda y los resultados.
 * NO usa un warm-up fijo (eso es un timer arbitrario que se siente simulado): usa
 * el criterio que usa un equipo médico real → esperar a que la LECTURA DE HR se
 * asiente (deje de moverse / converja) Y la calidad se sostenga. El tiempo lo dicta
 * la SEÑAL: limpia → converge en pocos segundos; pobre → nunca converge → no revela
 * basura. Robusto a arritmia: usa el BPM SUAVIZADO (la frecuencia media se asienta
 * aunque el ritmo sea irregular), no la regularidad RR.
 */

export type StabilizationStage = 'SEARCHING' | 'STABILIZING' | 'READY';

export interface StabilizationSample {
  hasContact: boolean;
  /** BPM suavizado actual (0 si aún no hay estimación). */
  bpm: number;
  /** SQI 0..100. */
  sqi: number;
  /** PI AC/DC. */
  perfusionIndex: number;
  /** Periodicidad de la señal (autocorrelación) 0..1. */
  periodicity: number;
  /** Movimiento (IMU + señal) 0..~2. */
  motionScore: number;
  nowMs: number;
  /** Veredicto opcional del Cerebro LLM */
  brainVerdict?: import('../ml/SignalBrain').SignalVerdict;
  brainConfidence?: number;
}

export interface StabilizationState {
  bpmTimes: number[];
  bpmVals: number[];
  qualityStreak: number;
  stabilized: boolean;
  progress: number;
  contactStartMs?: number;
}

export interface StabilizationResult {
  stage: StabilizationStage;
  /** 0..1 — refleja el PEOR criterio (eslabón débil): honesto, se estanca si algo no avanza. */
  progress: number;
  /** Latch: una vez estable, no se des-revela por un blip transitorio. */
  stabilized: boolean;
  /** Qué criterio está frenando (diagnóstico). */
  reason: string;
}

export function createStabilizationState(): StabilizationState {
  return { bpmTimes: [], bpmVals: [], qualityStreak: 0, stabilized: false, progress: 0 };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function updateStabilization(
  state: StabilizationState,
  s: StabilizationSample,
): StabilizationResult {
  const C = VITAL_THRESHOLDS.STABILIZATION;
  const HR = VITAL_THRESHOLDS.HR;

  if (!s.hasContact) {
    state.bpmTimes.length = 0;
    state.bpmVals.length = 0;
    state.qualityStreak = 0;
    state.stabilized = false;
    state.contactStartMs = undefined;
    state.progress = Math.max(0, state.progress - C.PROGRESS_FALL * 2);
    return { stage: 'SEARCHING', progress: state.progress, stabilized: false, reason: 'NO_CONTACT' };
  }

  if (state.contactStartMs === undefined) {
    state.contactStartMs = s.nowMs;
  }

  const contactDuration = s.nowMs - state.contactStartMs;
  // Factor de relajación: 0.0 a los 5 segundos de contacto continuo, escalando hasta 1.0 a los 10 segundos
  const relaxFactor = clamp01((contactDuration - 5000) / 5000);

  // 1) Acumula BPM válido (suavizado) en la ventana deslizante.
  if (s.bpm >= HR.MIN && s.bpm <= HR.MAX) {
    state.bpmTimes.push(s.nowMs);
    state.bpmVals.push(s.bpm);
    const cutoff = s.nowMs - C.WINDOW_MS;
    let drop = 0;
    while (drop < state.bpmTimes.length && state.bpmTimes[drop]! < cutoff) drop++;
    if (drop > 0) {
      state.bpmTimes.splice(0, drop);
      state.bpmVals.splice(0, drop);
    }
  }

  // 2) Calidad instantánea sostenida (dwell) con umbrales adaptativos por relajación.
  const minSqi = C.MIN_SQI - relaxFactor * 14;                  // de 32 a 18
  const minPi = C.MIN_PI - relaxFactor * 0.0006;                // de 0.0010 a 0.0004
  const minPeriodicity = C.MIN_PERIODICITY - relaxFactor * 0.14;// de 0.30 a 0.16
  const qualityDwellFrames = Math.round(C.QUALITY_DWELL_FRAMES - relaxFactor * 15); // de 30 a 15 frames

  // Toleramos mayor movimiento si la calidad de señal (sqi) es alta,
  // o si se activa la relajación adaptativa por tiempo.
  const motionTolerance = s.sqi >= 50 ? 0.9 : s.sqi >= 30 ? 0.4 : 0;
  const maxMotion = C.MAX_MOTION + relaxFactor * 0.9 + motionTolerance;

  const qualityOk =
    s.sqi >= minSqi &&
    s.perfusionIndex >= minPi &&
    s.periodicity >= minPeriodicity &&
    s.motionScore <= maxMotion;
  state.qualityStreak = qualityOk
    ? Math.min(state.qualityStreak + 1, qualityDwellFrames)
    : Math.max(0, state.qualityStreak - 2);

  // 3) Cálculo del Índice de Estabilidad de Contacto (0..1)
  const sMotion = clamp01(1 - s.motionScore / Math.max(0.01, C.MAX_MOTION));
  const sSqi = clamp01(s.sqi / 80);
  const sPi = clamp01(s.perfusionIndex / 0.005);
  const sPeriodicity = clamp01(s.periodicity / 0.75);
  const fStability = sMotion * (sSqi * 0.4 + sPi * 0.3 + sPeriodicity * 0.3);

  // 4) Umbrales dinámicos adaptativos basados en fStability
  let minWindowMs = C.MIN_WINDOW_MS;
  let minSamples = C.MIN_SAMPLES;
  let bpmSpreadMax = C.BPM_SPREAD_MAX;
  let progressRise = C.PROGRESS_RISE;
  let progressFall = C.PROGRESS_FALL;

  if (fStability > 0.65) {
    const scale = (fStability - 0.65) / 0.35; // 0..1
    minWindowMs = Math.round(C.MIN_WINDOW_MS - 1200 * scale); // hasta 1800ms
    minSamples = Math.round(C.MIN_SAMPLES - 20 * scale); // hasta 20 muestras
    bpmSpreadMax = Math.round(C.BPM_SPREAD_MAX + 4 * scale); // hasta 10 bpm para tolerar HRV saludable
    progressRise = C.PROGRESS_RISE + 0.03 * scale; // sube más rápido (hasta 0.08)
    progressFall = C.PROGRESS_FALL - 0.01 * scale; // más resistente a caídas (hasta 0.02)
  } else if (fStability < 0.25) {
    progressFall = C.PROGRESS_FALL * 2.0; // cae rápido si se pierde estabilidad
  }

  // Relajamos también minSamples y minWindowMs si la calidad se estanca tras 5 segundos
  if (relaxFactor > 0) {
    minSamples = Math.round(minSamples - relaxFactor * 12);
    minWindowMs = Math.round(minWindowMs - relaxFactor * 600);
    // Aseguramos límites lógicos mínimos
    minSamples = Math.max(15, minSamples);
    minWindowMs = Math.max(1500, minWindowMs);
  }

  // 5) Convergencia del BPM en la ventana (la lectura "dejó de moverse").
  const n = state.bpmVals.length;
  const span = n > 0 ? s.nowMs - state.bpmTimes[0]! : 0;
  let bmin = Infinity;
  let bmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = state.bpmVals[i]!;
    if (v < bmin) bmin = v;
    if (v > bmax) bmax = v;
  }
  const spread = n > 0 ? bmax - bmin : Infinity;

  // Criterio de convergencia matemático básico
  const converged =
    n >= minSamples && span >= minWindowMs && spread <= bpmSpreadMax;

  // Criterio de Calidad Sostenida
  const qualitySustained = state.qualityStreak >= qualityDwellFrames;

  // SUPERVISIÓN POR IA (Cerebro Llama 3.2)
  // La estabilización ya no es un timer; es un veredicto de veracidad clínica.
  let brainAllow = true;
  let brainPenalty = 0;
  let brainReason = '';

  if (s.brainVerdict === 'NOISE_ARTIFACT') {
    brainAllow = false;
    brainReason = 'IA: ARTEFACTO DETECTADO';
    brainPenalty = 0.05; // Retroceso físico de la barra
  } else if (s.brainVerdict === 'FAKE_SIGNAL') {
    brainAllow = false;
    brainReason = 'IA: SEÑAL NO HUMANA';
    brainPenalty = 0.15; // Penalización severa
  } else if (s.brainVerdict === 'UNCERTAIN') {
    brainAllow = false;
    brainReason = 'IA: ANALIZANDO VERACIDAD...';
    brainPenalty = 0.01;
  }

  if (converged && qualitySustained && brainAllow) {
    state.stabilized = true;
  } else {
    // Si la IA detecta fraude o ruido, impedimos el Latch de estabilidad
    state.stabilized = false;
  }

  // 6) Progreso Honesto (No Monótono)
  let target: number;
  let reason: string;
  if (state.stabilized) {
    target = 1;
    reason = 'READY';
  } else {
    const pSpan = clamp01(span / minWindowMs);
    const pSamples = clamp01(n / minSamples);
    const pConv = n >= 4 ? clamp01(1 - (spread - bpmSpreadMax) / (bpmSpreadMax * 2)) : 0;
    const pQual = clamp01(state.qualityStreak / qualityDwellFrames);

    // El objetivo se reduce por la penalización de la IA
    target = Math.max(0, Math.min(pSpan, pSamples, pConv, pQual) - brainPenalty);

    reason = brainReason || (
      pQual <= pConv && pQual <= pSpan && pQual <= pSamples
        ? 'WAIT_QUALITY'
        : pConv <= pSpan && pConv <= pSamples
          ? 'WAIT_CONVERGENCE'
          : 'WAIT_BEATS'
    );
  }

  // Suavizado del progreso (sube algo más rápido de lo que baja).
  state.progress =
    target > state.progress
      ? Math.min(target, state.progress + progressRise)
      : Math.max(target, state.progress - progressFall);

  return {
    stage: state.stabilized ? 'READY' : 'STABILIZING',
    progress: state.progress,
    stabilized: state.stabilized,
    reason,
  };
}
