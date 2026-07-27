/**
 * ACUMULADOR DE EVIDENCIA DE PERFUSIÓN — decisión secuencial de Wald.
 *
 * Toma las verosimilitudes que produce el detector de firma espectral y decide
 * si hay sangre pulsando, PERO sin decidirlo frame a frame: acumula.
 *
 * ── Por qué acumular y no umbralizar ──────────────────────────────────────
 *
 * Un umbral instantáneo tiene dos salidas y decide siempre igual, con lo que
 * o es tan estricto que corta mediciones buenas, o tan laxo que deja pasar una
 * pared. El test secuencial de razón de probabilidad (Wald, 1945) tiene TRES:
 *
 *     Λ ≥ A   →  HAY_PERFUSIÓN
 *     Λ ≤ B   →  SIN_PERFUSIÓN
 *     B < Λ < A →  INDECISO   ← la que hoy falta
 *
 * Eso permite que cinco segundos de evidencia débil pero consistente superen a
 * medio segundo de evidencia fuerte, cosa que ningún umbral instantáneo puede
 * expresar. Y mientras está indeciso NO publica un número: sigue midiendo.
 *
 * ── Los límites no son inventados ─────────────────────────────────────────
 *
 * A y B salen de las tasas de error que uno acepta (Wald):
 *
 *     A = log((1 − β) / α)      α = falso positivo (pared dando lectura)
 *     B = log(β / (1 − α))      β = falso negativo (dedo real rechazado)
 *
 * Se eligen α y β, y los umbrales caen solos. Aquí α es deliberadamente más
 * chico que β: preferimos rechazar un dedo bueno antes que aceptar una pared,
 * que es exactamente la regla del proyecto — mejor "no leer" que "leer mal".
 *
 * ── Olvido ────────────────────────────────────────────────────────────────
 *
 * La evidencia vieja decae con vida media fija: si el dedo se retira, el
 * acumulador cae y la app vuelve a `--` en un par de segundos en vez de quedar
 * congelada mostrando el último valor.
 */

/** Probabilidad tolerada de aceptar una pared como tejido. */
const ALPHA_FALSE_POSITIVE = 0.005;

/** Probabilidad tolerada de rechazar tejido real. Mayor que α a propósito. */
const BETA_FALSE_NEGATIVE = 0.05;

/** Umbral superior de Wald: por encima, se acepta que hay perfusión. */
export const EVIDENCE_UPPER = Math.log(
  (1 - BETA_FALSE_NEGATIVE) / ALPHA_FALSE_POSITIVE,
);

/** Umbral inferior de Wald: por debajo, se acepta que no la hay. */
export const EVIDENCE_LOWER = Math.log(
  BETA_FALSE_NEGATIVE / (1 - ALPHA_FALSE_POSITIVE),
);

/** Vida media del olvido, en segundos. */
const HALF_LIFE_S = 2.0;

/** Tope del acumulador, para que no se sature y tarde en volver. */
const ACCUMULATOR_LIMIT = 3 * EVIDENCE_UPPER;

export type PerfusionState = 'PERFUSED' | 'NOT_PERFUSED' | 'UNDECIDED';

export interface PerfusionVerdict {
  state: PerfusionState;
  /** Evidencia acumulada (log-odds). Positivo = a favor de perfusión. */
  logOdds: number;
  /**
   * Confianza en [0,1], derivada del acumulado por la logística. No es una
   * etiqueta inventada: es la probabilidad posterior implícita.
   */
  confidence: number;
}

export class PerfusionEvidence {
  private logOdds = 0;
  private lastState: PerfusionState = 'UNDECIDED';

  /**
   * Incorpora una nueva observación.
   *
   * @param llr        Log-verosimilitud del detector. 0 = sin información, y
   *                   en ese caso solo se aplica el olvido: la ausencia de
   *                   evidencia no es evidencia de ausencia.
   * @param dtSeconds  Tiempo transcurrido desde la observación anterior.
   */
  update(llr: number, dtSeconds: number): PerfusionVerdict {
    // No se acota dt por arriba a propósito. Un tope haría que, tras un rato
    // con la app en segundo plano, el acumulador conservara el veredicto viejo
    // y al volver siguiera afirmando que hay un dedo que ya no está. El
    // decaimiento exponencial maneja bien un salto grande: tiende a cero solo.
    // Sí se descarta un dt negativo o no finito, que amplificaría en vez de
    // olvidar.
    const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;

    // Olvido exponencial con vida media fija.
    if (dt > 0) {
      this.logOdds *= Math.pow(0.5, dt / HALF_LIFE_S);
    }

    if (Number.isFinite(llr) && llr !== 0) {
      this.logOdds += llr;
    }

    this.logOdds = Math.min(ACCUMULATOR_LIMIT, Math.max(-ACCUMULATOR_LIMIT, this.logOdds));

    // Histéresis natural del SPRT: solo cambia de estado al cruzar un límite;
    // entre ambos conserva el veredicto previo si ya había uno.
    if (this.logOdds >= EVIDENCE_UPPER) {
      this.lastState = 'PERFUSED';
    } else if (this.logOdds <= EVIDENCE_LOWER) {
      this.lastState = 'NOT_PERFUSED';
    }

    const state: PerfusionState =
      this.logOdds >= EVIDENCE_UPPER
        ? 'PERFUSED'
        : this.logOdds <= EVIDENCE_LOWER
          ? 'NOT_PERFUSED'
          : this.lastState === 'PERFUSED' && this.logOdds > 0
            ? 'PERFUSED'
            : 'UNDECIDED';

    return {
      state,
      logOdds: this.logOdds,
      confidence: 1 / (1 + Math.exp(-this.logOdds)),
    };
  }

  /** Veredicto actual sin incorporar observación nueva. */
  peek(): PerfusionVerdict {
    const state: PerfusionState =
      this.logOdds >= EVIDENCE_UPPER
        ? 'PERFUSED'
        : this.logOdds <= EVIDENCE_LOWER
          ? 'NOT_PERFUSED'
          : this.lastState === 'PERFUSED' && this.logOdds > 0
            ? 'PERFUSED'
            : 'UNDECIDED';
    return {
      state,
      logOdds: this.logOdds,
      confidence: 1 / (1 + Math.exp(-this.logOdds)),
    };
  }

  reset(): void {
    this.logOdds = 0;
    this.lastState = 'UNDECIDED';
  }
}
