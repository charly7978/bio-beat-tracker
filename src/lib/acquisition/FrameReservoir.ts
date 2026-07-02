/**
 * FRAME RESERVOIR — buffer elástico de "buenos frames" para colocación robusta.
 * ============================================================================
 *
 * PROBLEMA QUE RESUELVE
 * ---------------------
 * El lente trasero es hipersensible: un microdescuadre del dedo degrada UN
 * frame y, con las compuertas duras clásicas, ese único frame malo tira todo
 * el estado a "sin dedo / señal mala" y frustra al usuario que hizo todo bien.
 *
 * IDEA
 * ----
 * Desacoplar el RITMO DE CAPTURA del RITMO DE CONSUMO. La cámara suelta frames
 * a ~30 fps; el consumidor no lee el frame en vivo, lee con un pequeño retraso
 * elástico (`latencyFrames`) de un reservorio que recuerda los últimos frames
 * junto con su calidad. Cuando el frame que toca emitir está degradado pero
 * está rodeado de frames buenos recientes, se emite el mejor vecino bueno
 * dentro de un límite de antigüedad (`maxStaleMs`) — el descuadre momentáneo
 * se "rellena" con reserva y el consumidor ni se entera. El precio es un delay
 * mínimo al principio (llenar el colchón), aceptable en esa instancia.
 *
 * ALCANCE / SEGURIDAD
 * -------------------
 * Módulo PURO y genérico en `T` (sin estado global, sin `Date.now`: los
 * timestamps se inyectan). NO decide detección de pulso ni toca los valores
 * del DSP: solo administra QUÉ payload y con qué confianza se entrega aguas
 * abajo, y cuánta cobertura buena hay en la ventana. La sustitución de payload
 * es explícita en la emisión (`substituted`) para que el consumidor decida si
 * la usa: repetir una muestra dentro de una serie de pulso puede aplanar la
 * onda, así que el cableado al pipeline de latidos es una decisión aparte.
 */

export interface FrameReservoirConfig {
  /** Slots del anillo (frames recordados). */
  capacity: number;
  /** Retraso de emisión en frames (profundidad del colchón). */
  latencyFrames: number;
  /** Calidad [0..1] mínima para considerar un frame "bueno" (admisible). */
  admitQuality: number;
  /** Antigüedad máxima (ms) de un vecino bueno usado como reemplazo. */
  maxStaleMs: number;
  /** Cuántos slots recientes se promedian para la cobertura buena. */
  coverageWindow: number;
}

export const DEFAULT_FRAME_RESERVOIR_CONFIG: FrameReservoirConfig = {
  capacity: 90, // ~3 s a 30 fps
  latencyFrames: 12, // ~0.4 s de colchón
  admitQuality: 0.55,
  maxStaleMs: 600,
  coverageWindow: 45, // ~1.5 s
};

export interface ReservoirEmission<T> {
  /** Payload entregado (puede ser el del slot o el de un vecino bueno). */
  payload: T;
  /** Timestamp del slot que corresponde emitir (posición temporal real). */
  timestamp: number;
  /** Calidad propia del slot que tocaba emitir. */
  rawQuality: number;
  /** Calidad del payload realmente emitido (== rawQuality si no hubo reemplazo). */
  emittedQuality: number;
  /** Fracción [0..1] de frames buenos en la ventana de cobertura reciente. */
  goodCoverage: number;
  /** El slot que tocaba emitir pasaba el umbral por sí mismo. */
  admitted: boolean;
  /** Se emitió el payload de un vecino bueno en vez del slot degradado. */
  substituted: boolean;
  /** Antigüedad (ms) del payload emitido respecto del timestamp del slot. */
  ageMs: number;
}

/**
 * Buffer elástico con emisión retrasada y relleno por vecino bueno.
 * Anillo preasignado; los payloads se guardan por referencia.
 */
export class FrameReservoir<T> {
  private readonly cap: number;
  private readonly ts: Float64Array;
  private readonly qual: Float64Array;
  private readonly payloads: (T | null)[];
  private head = 0; // próximo índice de escritura
  private filled = 0; // slots válidos escritos (≤ cap)
  private emitted = 0; // slots ya consumidos (monótono, ≤ head total)
  private pushed = 0; // total de push() (monótono)

  constructor(private readonly cfg: FrameReservoirConfig = DEFAULT_FRAME_RESERVOIR_CONFIG) {
    this.cap = Math.max(1, cfg.capacity);
    this.ts = new Float64Array(this.cap);
    this.qual = new Float64Array(this.cap);
    this.payloads = new Array<T | null>(this.cap).fill(null);
  }

  /** Ingresa un frame con su calidad de contacto [0..1] y timestamp (ms). */
  push(payload: T, quality: number, timestamp: number): void {
    this.ts[this.head] = timestamp;
    this.qual[this.head] = quality < 0 ? 0 : quality > 1 ? 1 : quality;
    this.payloads[this.head] = payload;
    this.head = (this.head + 1) % this.cap;
    if (this.filled < this.cap) this.filled++;
    this.pushed++;
  }

  /** ¿Hay suficiente colchón para empezar a emitir con el retraso configurado? */
  get canEmit(): boolean {
    return this.pushed - this.emitted > this.cfg.latencyFrames;
  }

  /** Frames pendientes de emitir (pushed − emitted). */
  get pending(): number {
    return this.pushed - this.emitted;
  }

  /**
   * Consume el frame que corresponde según el retraso elástico. Devuelve `null`
   * mientras el colchón se llena (delay mínimo inicial). En régimen entrega uno
   * por llamada; si el consumidor se atrasa y el backlog supera el retraso,
   * avanza igual (no se estanca).
   */
  consume(): ReservoirEmission<T> | null {
    if (!this.canEmit) return null;

    // Índice absoluto del slot a emitir (el más viejo aún no emitido).
    const emitAbs = this.emitted;
    // Si el buffer ya sobrescribió ese slot (consumidor demasiado lento),
    // saltar al slot más viejo todavía presente.
    const oldestAbs = this.pushed - this.filled;
    const targetAbs = emitAbs < oldestAbs ? oldestAbs : emitAbs;
    const ringIdx = targetAbs % this.cap;

    const slotTs = this.ts[ringIdx];
    const slotQual = this.qual[ringIdx];
    const slotPayload = this.payloads[ringIdx] as T;

    const admitted = slotQual >= this.cfg.admitQuality;

    let payload = slotPayload;
    let emittedQuality = slotQual;
    let substituted = false;
    let ageMs = 0;

    if (!admitted) {
      const best = this.findBestNeighbor(targetAbs, slotTs);
      if (best) {
        payload = best.payload;
        emittedQuality = best.quality;
        substituted = true;
        ageMs = Math.abs(slotTs - best.timestamp);
      }
    }

    const goodCoverage = this.coverageAround(targetAbs);

    this.emitted = targetAbs + 1;

    return {
      payload,
      timestamp: slotTs,
      rawQuality: slotQual,
      emittedQuality,
      goodCoverage,
      admitted,
      substituted,
      ageMs,
    };
  }

  /**
   * Mejor vecino bueno (mayor calidad) dentro de `maxStaleMs` del slot dado,
   * buscando en ambos sentidos sobre los slots presentes. Empate: el más
   * cercano en el tiempo.
   */
  private findBestNeighbor(
    targetAbs: number,
    targetTs: number,
  ): { payload: T; quality: number; timestamp: number } | null {
    const oldestAbs = this.pushed - this.filled;
    const newestAbs = this.pushed - 1;
    let best: { payload: T; quality: number; timestamp: number } | null = null;
    let bestScore = -Infinity;

    for (let abs = oldestAbs; abs <= newestAbs; abs++) {
      if (abs === targetAbs) continue;
      const idx = abs % this.cap;
      const q = this.qual[idx];
      if (q < this.cfg.admitQuality) continue;
      const dt = Math.abs(this.ts[idx] - targetTs);
      if (dt > this.cfg.maxStaleMs) continue;
      // Prioriza calidad; penaliza levemente la distancia temporal como desempate.
      const score = q - dt / (this.cfg.maxStaleMs * 1000);
      if (score > bestScore) {
        bestScore = score;
        best = { payload: this.payloads[idx] as T, quality: q, timestamp: this.ts[idx] };
      }
    }
    return best;
  }

  /** Fracción de frames buenos en los `coverageWindow` slots hasta `targetAbs`. */
  private coverageAround(targetAbs: number): number {
    const oldestAbs = this.pushed - this.filled;
    const startAbs = Math.max(oldestAbs, targetAbs - this.cfg.coverageWindow + 1);
    let good = 0;
    let total = 0;
    for (let abs = startAbs; abs <= targetAbs; abs++) {
      total++;
      if (this.qual[abs % this.cap] >= this.cfg.admitQuality) good++;
    }
    return total === 0 ? 0 : good / total;
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
    this.emitted = 0;
    this.pushed = 0;
    this.payloads.fill(null);
  }
}
