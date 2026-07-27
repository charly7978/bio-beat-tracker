/**
 * VIGENCIA DE UN SIGNO VITAL — cuánto tiempo un valor sigue significando algo.
 *
 * ── El problema que resuelve ───────────────────────────────────────────────
 *
 * Antes cada vital tenía su propio reloj y su propia memoria: el BPM se
 * resucitaba desde un `lastGood` que se re-guardaba a sí mismo, la presión se
 * conservaba 30 frames por un contador propio, y el oxígeno directamente no
 * se borraba nunca porque solo existía la rama que lo escribe. Tres relojes
 * independientes, tres criterios distintos, ninguno atado a si había sangre.
 *
 * El resultado era que al retirar el dedo la pantalla seguía mostrando tres
 * números — de tres instantes distintos — que además se suavizaban entre sí,
 * de modo que la transición parecía creíble.
 *
 * ── El criterio ───────────────────────────────────────────────────────────
 *
 * Un valor vive exactamente mientras la evidencia de perfusión lo sostenga.
 * No hay un contador de frames aparte ni un tiempo máximo elegido a mano: el
 * reloj es el acumulador secuencial, cuyos límites salen de las tasas de error
 * aceptadas y cuyo olvido es exponencial con vida media fija.
 *
 *   PERFUSED    → el valor es actual
 *   UNDECIDED   → el valor sobrevive, pero declara su antigüedad
 *   NOT_PERFUSED→ el valor no existe
 *
 * Un solo reloj para los tres. Eso no es solo higiene: es lo que permite
 * razonar en términos médicos. La frecuencia, la saturación y la presión están
 * fisiológicamente acopladas — el gasto cardíaco es frecuencia × volumen
 * sistólico, y la presión media es gasto × resistencia — así que solo son
 * comparables entre sí si provienen del MISMO instante. Tres valores de tres
 * instantes distintos no significan nada juntos, por más que cada uno haya
 * sido correcto cuando se midió.
 *
 * ── Lo que NO hace ────────────────────────────────────────────────────────
 *
 * No decide si un valor es fisiológicamente plausible: eso es de quien lo
 * calcula. Aquí solo se responde si el valor todavía describe al paciente.
 */

import type { PerfusionState } from '../signal-processing/perfusionEvidence';

/**
 * Antigüedad máxima que se tolera mientras la evidencia está indecisa.
 *
 * No es un número de comodidad: es el tiempo tras el cual un vital deja de
 * describir al paciente. La frecuencia cardíaca cambia latido a latido y la
 * saturación responde a un evento de desaturación en pocos segundos, así que
 * más allá de esta ventana el valor describe un pasado, no un presente.
 *
 * Coincide a propósito con la vida media del acumulador de evidencia (2 s):
 * pasado ese tiempo sin confirmación, la evidencia que sostenía el valor ya
 * se redujo a la mitad.
 */
const MAX_STALE_MS = 2000;

export interface TimedVital {
  /** Valor medido. 0 significa "no hay valor", nunca "cero fisiológico". */
  value: number;
  /** Instante en que se produjo a partir de evidencia real. */
  measuredAtMs: number;
}

export type VitalFreshness = 'FRESH' | 'STALE' | 'EXPIRED';

export interface VitalVigency {
  freshness: VitalFreshness;
  /** Antigüedad en ms. 0 si no hay valor. */
  ageMs: number;
  /** Si el consumidor puede publicarlo. */
  publishable: boolean;
}

/**
 * Evalúa si un vital medido sigue vigente.
 *
 * @param vital           Valor y momento en que se midió.
 * @param perfusionState  Veredicto ACTUAL del acumulador de evidencia.
 * @param nowMs           Instante actual.
 */
export function evaluateVigency(
  vital: TimedVital | null,
  perfusionState: PerfusionState,
  nowMs: number,
): VitalVigency {
  if (!vital || vital.value <= 0 || vital.measuredAtMs <= 0) {
    return { freshness: 'EXPIRED', ageMs: 0, publishable: false };
  }

  // Evidencia positiva de que no hay sangre: el valor no describe a nadie.
  // No importa cuán reciente sea.
  if (perfusionState === 'NOT_PERFUSED') {
    return { freshness: 'EXPIRED', ageMs: 0, publishable: false };
  }

  const ageMs = Math.max(0, nowMs - vital.measuredAtMs);

  if (perfusionState === 'PERFUSED' && ageMs <= MAX_STALE_MS) {
    return { freshness: 'FRESH', ageMs, publishable: true };
  }

  if (ageMs <= MAX_STALE_MS) {
    // Indeciso pero reciente: sobrevive declarando su antigüedad.
    return { freshness: 'STALE', ageMs, publishable: true };
  }

  return { freshness: 'EXPIRED', ageMs, publishable: false };
}

/**
 * Aplica la vigencia a un conjunto de vitales acoplados.
 *
 * Los tres caducan JUNTOS a propósito. Si la frecuencia expiró, la saturación
 * y la presión que se calcularon a partir de ella dejan de ser interpretables
 * aunque su propio sello de tiempo sea más reciente: heredaron su validez.
 * Publicar dos de tres sería mostrar un cuadro clínico que nunca existió.
 */
export function evaluateCoupledVigency(
  vitals: {
    heartRate: TimedVital | null;
    spo2: TimedVital | null;
    bloodPressure: TimedVital | null;
  },
  perfusionState: PerfusionState,
  nowMs: number,
): {
  heartRate: VitalVigency;
  spo2: VitalVigency;
  bloodPressure: VitalVigency;
  anyPublishable: boolean;
} {
  const hr = evaluateVigency(vitals.heartRate, perfusionState, nowMs);

  // La frecuencia es la que ancla al resto: sin latidos no hay componente
  // pulsátil del que extraer AC/DC, así que ni la saturación ni la presión
  // pueden sostenerse por su cuenta.
  const derivedState: PerfusionState = hr.publishable ? perfusionState : 'NOT_PERFUSED';

  const spo2 = evaluateVigency(vitals.spo2, derivedState, nowMs);
  const bloodPressure = evaluateVigency(vitals.bloodPressure, derivedState, nowMs);

  return {
    heartRate: hr,
    spo2,
    bloodPressure,
    anyPublishable: hr.publishable || spo2.publishable || bloodPressure.publishable,
  };
}
