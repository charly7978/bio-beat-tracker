/**
 * ENVELOPE EQUALIZER — compresión de rango dinámico para el canal HR.
 * ==================================================================
 *
 * PROBLEMA
 * --------
 * Con modulación respiratoria de amplitud, en una misma ventana conviven
 * latidos fuertes y débiles. El detector Elgendi descarta picos por debajo de
 * una fracción de la prominencia mediana → los latidos débiles reales se
 * pierden. Bajar ese umbral metería ruido (falsos positivos).
 *
 * SOLUCIÓN (invariante a escala)
 * ------------------------------
 * Se sigue la amplitud del pulso con dos envolventes: una RÁPIDA `env`
 * (amplitud del latido actual: sube rápido, baja lento) y una LENTA `slow`
 * (amplitud típica de largo plazo, más lenta que el ciclo respiratorio). La
 * ganancia = `slow / env`: donde el latido es más fuerte que el promedio se
 * atenúa, donde es más débil se refuerza → las alturas de latido se igualan y
 * la modulación respiratoria se aplana. Como la ganancia es un COCIENTE de
 * envolventes, es INVARIANTE A ESCALA (multiplicar la entrada por k no cambia
 * la ganancia): no hay `target` absoluto que se pueda desajustar y saturar.
 *
 * En la escala de un latido (~0.7 s) las envolventes casi no cambian → la
 * MORFOLOGÍA se preserva; en la escala respiratoria (~4 s) `env` varía y `slow`
 * no → la modulación se cancela. La ganancia se acota (`maxGain`) y `env` tiene
 * un piso relativo (`floorFrac·slow`) para no amplificar ruido entre latidos.
 *
 * PURO y stateful (sin estado global, sin `Date.now`). No decide picos ni toca
 * detección: solo reescala amplitud. Con `mix=0` es passthrough exacto.
 */

export interface EnvelopeEqualizerConfig {
  /** EMA de subida de la envolvente rápida cuando |x| supera la actual. */
  attack: number;
  /** EMA de bajada (más lenta) entre latidos: sostiene la amplitud del latido. */
  release: number;
  /** EMA de la envolvente lenta (amplitud típica); << ritmo respiratorio. */
  slowAlpha: number;
  /** Piso de la envolvente rápida como fracción de la lenta (evita inflar ruido). */
  floorFrac: number;
  /** Ganancia máxima (acota el refuerzo de latidos débiles / ruido). */
  maxGain: number;
  /** Mezcla 0..1: 0 = señal cruda, 1 = totalmente ecualizada. */
  mix: number;
}

export class EnvelopeEqualizer {
  private env = 0;
  private slow = 0;
  private initialized = false;

  constructor(private readonly cfg: EnvelopeEqualizerConfig) {}

  /** Reescala una muestra comprimiendo la modulación de amplitud lenta. */
  process(x: number): number {
    if (!Number.isFinite(x)) return 0;
    const cfg = this.cfg;
    const ax = Math.abs(x);

    if (!this.initialized) {
      this.env = ax;
      this.slow = ax;
      this.initialized = true;
    } else {
      const coef = ax > this.env ? cfg.attack : cfg.release;
      this.env += coef * (ax - this.env);
      this.slow += cfg.slowAlpha * (this.env - this.slow);
    }

    const floor = cfg.floorFrac * this.slow;
    const eff = this.env > floor ? this.env : floor;
    let gain = eff > 1e-9 ? this.slow / eff : 1;
    if (!Number.isFinite(gain) || gain < 0) gain = 0;
    if (gain > cfg.maxGain) gain = cfg.maxGain;

    const eq = x * gain;
    // Mezcla lineal: mix=0 → passthrough exacto; mix=1 → totalmente ecualizado.
    const out = cfg.mix * eq + (1 - cfg.mix) * x;
    return Number.isFinite(out) ? out : 0;
  }

  reset(): void {
    this.env = 0;
    this.slow = 0;
    this.initialized = false;
  }
}
