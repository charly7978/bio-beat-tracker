export class MovingAverageDetrending {
  private buffer: number[] = [];
  private sum = 0;

  constructor(private windowSize: number = 30) {}

  filter(value: number): number {
    if (!Number.isFinite(value)) return 0;
    this.buffer.push(value);
    this.sum += value;
    if (this.buffer.length > this.windowSize) {
      this.sum -= this.buffer.shift()!;
    }
    const mean = this.sum / this.buffer.length;
    return value - mean;
  }

  reset(): void {
    this.buffer = [];
    this.sum = 0;
  }
}
