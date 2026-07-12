/**
 * REGIME BELIEF ENGINE — inferencia de estado por switching state-space.
 *
 * El sistema cardiovascular se modela como una variable latente DISCRETA (el
 * régimen) que evoluciona en el tiempo (transiciones tipo HMM) y emite la
 * evidencia observada con cierta verosimilitud. En cada ventana se corre un paso
 * de PROPAGACIÓN DE CREENCIAS (forward algorithm): la creencia previa se propaga
 * por la matriz de transición y se pondera por la verosimilitud de emisión de la
 * evidencia actual. El resultado es una DISTRIBUCIÓN de probabilidad sobre los
 * regímenes — nunca un sí/no.
 *
 * "No hay señal" (NO_PERFUSION) es un régimen más: gana la creencia cuando la
 * evidencia no es explicable como pulso de tejido vivo. Así el bloqueo por
 * "forma de dedo" se reemplaza por una inferencia sobre si existe un latido real.
 *
 * Refs.: BeliefPPG (propagación de creencias sobre HR, PMLR 2023); Switching
 * Linear Dynamical Systems para seguimiento de estado fisiológico (UCI, sepsis).
 */
import { clamp } from '../../utils/math';
import { smoothstep, smoothstepDown, plateau, softAnd } from './scoring';
import { CARDIOVASCULAR_REGIMES } from './types';
import type { CardiovascularRegime, RegimeBelief, RegimeEvidence } from './types';

const K = CARDIOVASCULAR_REGIMES.length;

/**
 * Piso de verosimilitud de emisión. Acota el cociente de verosimilitud por
 * frame (~20×) para que la creencia tenga INERCIA temporal: un frame aislado de
 * ruido no vuelca la creencia, pero el ruido sostenido sí converge. Sin piso, un
 * único cociente extremo (10000×) rompería la propagación de creencias.
 */
const EMISSION_FLOOR = 0.05;

/**
 * Matriz de transición "pegajosa" (sticky): el régimen tiende a persistir
 * (auto-transición alta) y cambia con baja probabilidad. Esto da inercia
 * temporal: un artefacto de un frame no vuelca la creencia.
 */
function buildTransitionMatrix(): Map<CardiovascularRegime, RegimeBelief> {
  const SELF = 0.94;
  const OFF = (1 - SELF) / (K - 1);
  const A = new Map<CardiovascularRegime, RegimeBelief>();
  for (const from of CARDIOVASCULAR_REGIMES) {
    const row = {} as RegimeBelief;
    for (const to of CARDIOVASCULAR_REGIMES) row[to] = from === to ? SELF : OFF;
    A.set(from, row);
  }
  return A;
}

/**
 * Modelo de emisión: mapea el vector de evidencia a la verosimilitud de cada
 * régimen mediante funciones suaves (no umbrales). Pura y testeable.
 */
export function computeEmissions(ev: RegimeEvidence): RegimeBelief {
  // --- Presencia de pulso: núcleo siempre disponible + corroboración óptica. ---
  const corePulse = softAnd(
    smoothstep(0.2, 0.55, ev.explainedVariance),
    smoothstep(0.25, 0.6, ev.morphologyLikelihood),
    smoothstep(0.12, 0.4, ev.periodicity),
  );
  const perfusionPresence = smoothstep(0.0006, 0.006, ev.perfusionIndex);
  const corroboration = 0.5 + 0.5 * Math.max(ev.bvpCoherence, perfusionPresence);
  const pulsePresence = clamp(corePulse * corroboration, 0, 1);

  // --- Ritmo (dado que hay pulso). ---
  const regularity = smoothstepDown(0.08, 0.22, ev.rrCv);
  const irregular = smoothstep(0.16, 0.42, ev.rrCv);
  const inSinusRate = plateau(52, 98, 9, ev.bpm);
  const tachyRate = smoothstep(98, 112, ev.bpm);
  const bradyRate = ev.bpm > 0 ? smoothstepDown(50, 58, ev.bpm) : 0;

  // --- Movimiento: hay energía pulsátil pero morfología degradada + IMU alto. ---
  const motionCorrupted = softAnd(
    smoothstep(0.45, 0.75, ev.motionScore),
    0.3 + 0.7 * smoothstep(0.05, 0.35, ev.explainedVariance),
    smoothstepDown(0.55, 0.85, ev.morphologyLikelihood),
  );

  const emissions = {
    NO_PERFUSION: clamp(Math.pow(1 - pulsePresence, 1.5), EMISSION_FLOOR, 1),
    SINUS_NORMAL: clamp(pulsePresence * regularity * inSinusRate * (1 - ev.ectopyScore), EMISSION_FLOOR, 1),
    TACHYCARDIA: clamp(pulsePresence * regularity * tachyRate, EMISSION_FLOOR, 1),
    BRADYCARDIA: clamp(pulsePresence * regularity * bradyRate, EMISSION_FLOOR, 1),
    IRREGULAR: clamp(pulsePresence * irregular * (1 - ev.ectopyScore), EMISSION_FLOOR, 1),
    ECTOPIC: clamp(pulsePresence * ev.ectopyScore, EMISSION_FLOOR, 1),
    MOTION: clamp(motionCorrupted, EMISSION_FLOOR, 1),
  } as RegimeBelief;

  return emissions;
}

export class RegimeBeliefEngine {
  private readonly transition = buildTransitionMatrix();
  private belief: RegimeBelief;

  constructor() {
    this.belief = this.initialBelief();
  }

  reset(): void {
    this.belief = this.initialBelief();
  }

  /** Prior inicial: sin evidencia, asumimos que no hay perfusión (nada apoyado). */
  private initialBelief(): RegimeBelief {
    const b = {} as RegimeBelief;
    for (const r of CARDIOVASCULAR_REGIMES) b[r] = r === 'NO_PERFUSION' ? 0.7 : 0.3 / (K - 1);
    return b;
  }

  /** Un paso de propagación de creencias con la evidencia actual. */
  update(ev: RegimeEvidence): RegimeBelief {
    const emissions = computeEmissions(ev);

    // Predicción: propagar la creencia previa por la matriz de transición.
    const predicted = {} as RegimeBelief;
    for (const to of CARDIOVASCULAR_REGIMES) {
      let acc = 0;
      for (const from of CARDIOVASCULAR_REGIMES) {
        acc += this.belief[from] * this.transition.get(from)![to];
      }
      predicted[to] = acc;
    }

    // Actualización: ponderar por la verosimilitud de emisión y normalizar.
    let total = 0;
    const posterior = {} as RegimeBelief;
    for (const r of CARDIOVASCULAR_REGIMES) {
      posterior[r] = predicted[r] * emissions[r];
      total += posterior[r];
    }
    if (total < 1e-12) {
      this.belief = this.initialBelief();
      return this.belief;
    }
    for (const r of CARDIOVASCULAR_REGIMES) posterior[r] /= total;
    this.belief = posterior;
    return posterior;
  }

  getBelief(): RegimeBelief {
    return this.belief;
  }
}

/** Régimen más probable de una distribución de creencia. */
export function argmaxRegime(belief: RegimeBelief): CardiovascularRegime {
  let best: CardiovascularRegime = 'NO_PERFUSION';
  let bestP = -Infinity;
  for (const r of CARDIOVASCULAR_REGIMES) {
    if (belief[r] > bestP) {
      bestP = belief[r];
      best = r;
    }
  }
  return best;
}

/** Entropía normalizada de la creencia (0 = certeza, 1 = máxima ambigüedad). */
export function beliefEntropy(belief: RegimeBelief): number {
  let h = 0;
  for (const r of CARDIOVASCULAR_REGIMES) {
    const p = belief[r];
    if (p > 1e-9) h -= p * Math.log(p);
  }
  return clamp(h / Math.log(K), 0, 1);
}
