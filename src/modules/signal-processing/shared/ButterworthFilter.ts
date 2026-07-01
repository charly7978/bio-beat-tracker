export class ButterworthFilter {
  private b: number[][];
  private a: number[][];
  private state: { x: number[]; y: number[] }[];
  private initialized = false;

  constructor(
    private order: 2 | 4,
    private type: 'highpass' | 'lowpass',
    private fc: number,
    private fs: number
  ) {
    const stages = order / 2;
    this.b = Array.from({ length: stages }, () => [0, 0, 0]);
    this.a = Array.from({ length: stages }, () => [1, 0, 0]);
    this.state = Array.from({ length: stages }, () => ({ x: [0, 0, 0], y: [0, 0, 0] }));
    this.computeCoefficients();
  }

  private computeCoefficients(): void {
    const wc = Math.tan(Math.PI * this.fc / this.fs);
    const stages = this.order / 2;

    let d: number[];
    if (this.order === 2) {
      d = [Math.sqrt(2)];
    } else {
      d = [2 * Math.cos(Math.PI / 8), 2 * Math.cos(3 * Math.PI / 8)];
    }

    for (let i = 0; i < stages; i++) {
      const norm = 1 / (1 + d[i] * wc + wc * wc);
      if (this.type === 'highpass') {
        this.b[i][0] = norm;
        this.b[i][1] = -2 * norm;
        this.b[i][2] = norm;
      } else {
        this.b[i][0] = wc * wc * norm;
        this.b[i][1] = 2 * wc * wc * norm;
        this.b[i][2] = wc * wc * norm;
      }
      this.a[i][0] = 1;
      this.a[i][1] = 2 * (wc * wc - 1) * norm;
      this.a[i][2] = (1 - d[i] * wc + wc * wc) * norm;
    }
    this.initialized = true;
  }

  filter(value: number): number {
    if (!this.initialized || !Number.isFinite(value)) return 0;
    let out = value;
    const stages = this.order / 2;
    for (let i = 0; i < stages; i++) {
      const b = this.b[i];
      const a = this.a[i];
      const state = this.state[i];

      state.x[2] = state.x[1];
      state.x[1] = state.x[0];
      state.x[0] = out;

      state.y[2] = state.y[1];
      state.y[1] = state.y[0];

      state.y[0] =
        b[0] * state.x[0] +
        b[1] * state.x[1] +
        b[2] * state.x[2] -
        a[1] * state.y[1] -
        a[2] * state.y[2];

      if (!Number.isFinite(state.y[0]) || Math.abs(state.y[0]) > 1e10) {
        state.y[0] = 0;
      }
      out = state.y[0];
    }
    return out;
  }

  reset(): void {
    const stages = this.order / 2;
    for (let i = 0; i < stages; i++) {
      this.state[i] = { x: [0, 0, 0], y: [0, 0, 0] };
    }
  }
}

export class ButterworthBandpass {
  private hpf: ButterworthFilter;
  private lpf: ButterworthFilter;

  constructor(order: 2 | 4, lowCut: number, highCut: number, fs: number) {
    this.hpf = new ButterworthFilter(order, 'highpass', lowCut, fs);
    this.lpf = new ButterworthFilter(order, 'lowpass', highCut, fs);
  }

  filter(value: number): number {
    return this.lpf.filter(this.hpf.filter(value));
  }

  reset(): void {
    this.hpf.reset();
    this.lpf.reset();
  }
}
