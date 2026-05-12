interface PPGDataPoint {
  time: number;
  value: number;
  isArrhythmia: boolean;
}

/**
 * Ring buffer real O(1) por push.
 * No usa shift(), evita GC churn y latencia en hot path.
 * Internamente mantiene un buffer pre-asignado con cabeza y cola.
 */
export class CircularBuffer {
  private buffer: (PPGDataPoint | null)[];
  private readonly capacity: number;
  private head = 0;
  private size = 0;

  constructor(size: number) {
    this.capacity = size;
    this.buffer = new Array<PPGDataPoint | null>(size).fill(null);
  }

  push(point: PPGDataPoint): void {
    const idx = (this.head + this.size) % this.capacity;
    if (this.size === this.capacity) {
      this.buffer[this.head] = point;
      this.head = (this.head + 1) % this.capacity;
    } else {
      this.buffer[idx] = point;
      this.size++;
    }
  }

  /**
   * Devuelve los puntos en orden cronológico.
   * Asigna un Array nuevo solo si es necesario (cuando hay wrap-around).
   */
  getPoints(): readonly PPGDataPoint[] {
    if (this.size === 0) return [];
    if (this.head === 0) {
      return this.buffer.slice(0, this.size) as PPGDataPoint[];
    }
    const out: PPGDataPoint[] = new Array(this.size);
    for (let i = 0; i < this.size; i++) {
      out[i] = this.buffer[(this.head + i) % this.capacity] as PPGDataPoint;
    }
    return out;
  }

  getPointsCount(): number {
    return this.size;
  }

  /**
   * Marca retroactivamente como arritmia todos los puntos
   * desde hace `durationMs` milisegundos hasta el presente.
   * Itera al revés desde la cola sin crear copia.
   */
  markArrhythmiaBack(durationMs: number): void {
    if (this.size === 0) return;
    const cutoff = Date.now() - durationMs;
    for (let i = this.size - 1; i >= 0; i--) {
      const idx = (this.head + i) % this.capacity;
      const pt = this.buffer[idx];
      if (!pt || pt.time < cutoff) break;
      pt.isArrhythmia = true;
    }
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.buffer.fill(null);
  }
}

export type { PPGDataPoint };
