/**
 * Ring buffer numérico de tamaño fijo basado en Float32Array.
 *
 * Diseñado como reemplazo directo de `number[]` con uso `push` + `shift`
 * en buffers de DSP. Elimina el O(n) por frame de `Array.shift()` y la
 * fragmentación de heap.
 *
 * Semántica:
 *  - `push(v)` siempre agrega; al exceder `size`, sobrescribe el más viejo.
 *  - `length` reporta cuántos slots reales hay (≤ size).
 *  - `tail(n)` devuelve un `number[]` con los últimos n en orden cronológico
 *    (oldest → newest), igual a lo que devolvía `arr.slice(-n)`.
 *  - `copyTailInto(out, n)` escribe sin alocar (para hot-path de stats).
 */
export class RingF32 {
  private readonly buf: Float32Array;
  private head = 0;     // próximo índice de escritura
  private filled = 0;   // muestras válidas (≤ size)

  constructor(public readonly size: number) {
    this.buf = new Float32Array(size);
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.size;
    if (this.filled < this.size) this.filled++;
  }

  get length(): number {
    return this.filled;
  }

  /** Devuelve un nuevo array con los últimos `n` valores (oldest→newest). */
  tail(n: number): number[] {
    const k = Math.min(n, this.filled);
    const out = new Array<number>(k);
    let idx = (this.head - k + this.size) % this.size;
    for (let i = 0; i < k; i++) {
      out[i] = this.buf[idx];
      idx = idx + 1;
      if (idx === this.size) idx = 0;
    }
    return out;
  }

  /**
   * Copia los últimos `n` valores en `out` sin alocar.
   * Devuelve la cantidad realmente escrita.
   */
  copyTailInto(out: Float32Array | number[], n: number): number {
    const cap = (out as { length: number }).length;
    const k = Math.min(n, this.filled, cap);
    let idx = (this.head - k + this.size) % this.size;
    for (let i = 0; i < k; i++) {
      out[i] = this.buf[idx];
      idx = idx + 1;
      if (idx === this.size) idx = 0;
    }
    return k;
  }

  /** Último valor escrito (o 0 si está vacío). */
  last(): number {
    if (this.filled === 0) return 0;
    const idx = (this.head - 1 + this.size) % this.size;
    return this.buf[idx];
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
    // No es necesario limpiar `buf`: las lecturas se gating con `filled`.
  }
}
