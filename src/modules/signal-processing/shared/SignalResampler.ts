export interface ResampledSample {
  time: number;
  r: number;
  g: number;
  b: number;
  coverage: number;
  fingerScore: number;
  fingerTileCount: number;
  centroidMotion: number;
}

export class SignalResampler {
  private rawHistory: ResampledSample[] = [];
  private nextTargetTime: number | null = null;
  private targetInterval: number; // in ms

  constructor(
    private targetFs: number = 30,
    private interpolationType: 'linear' | 'cubic' = 'cubic',
    private maxHistoryLength: number = 30
  ) {
    this.targetInterval = 1000 / targetFs;
  }

  push(
    time: number,
    r: number,
    g: number,
    b: number,
    coverage: number,
    fingerScore: number,
    fingerTileCount: number,
    centroidMotion: number
  ): void {
    if (this.rawHistory.length > 0 && time <= this.rawHistory[this.rawHistory.length - 1].time) {
      // Ignore duplicates or older frames
      return;
    }
    this.rawHistory.push({
      time,
      r,
      g,
      b,
      coverage,
      fingerScore,
      fingerTileCount,
      centroidMotion,
    });

    if (this.rawHistory.length > this.maxHistoryLength) {
      this.rawHistory.shift();
    }
  }

  getPendingSamples(): ResampledSample[] {
    if (this.rawHistory.length < 2) return [];

    const firstTime = this.rawHistory[0].time;
    const lastTime = this.rawHistory[this.rawHistory.length - 1].time;

    if (this.nextTargetTime === null) {
      // Align target timeline to the first frame
      this.nextTargetTime = firstTime;
    }

    const pending: ResampledSample[] = [];

    // Safety guard to avoid infinite loop
    if (this.targetInterval <= 0) return [];

    while (this.nextTargetTime <= lastTime) {
      if (this.nextTargetTime >= firstTime) {
        const sample = this.interpolateAt(this.nextTargetTime);
        pending.push(sample);
      }
      this.nextTargetTime += this.targetInterval;
    }

    return pending;
  }

  private interpolateAt(t: number): ResampledSample {
    const n = this.rawHistory.length;

    // Safety fallbacks
    if (t <= this.rawHistory[0].time) {
      return { ...this.rawHistory[0], time: t };
    }
    if (t >= this.rawHistory[n - 1].time) {
      return { ...this.rawHistory[n - 1], time: t };
    }

    // Find the interval [i, i+1] that contains t
    let i = 0;
    while (i < n - 2 && this.rawHistory[i + 1].time < t) {
      i++;
    }

    const s0 = this.rawHistory[i];
    const s1 = this.rawHistory[i + 1];
    const dt = s1.time - s0.time;
    const u = dt > 0 ? (t - s0.time) / dt : 0;

    // Linear interpolation for metadata
    const coverage = s0.coverage + u * (s1.coverage - s0.coverage);
    const fingerScore = s0.fingerScore + u * (s1.fingerScore - s0.fingerScore);
    const fingerTileCount = Math.round(s0.fingerTileCount + u * (s1.fingerTileCount - s0.fingerTileCount));
    const centroidMotion = s0.centroidMotion + u * (s1.centroidMotion - s0.centroidMotion);

    // Interpolation for RGB values (cubic spline or linear)
    let r: number;
    let g: number;
    let b: number;

    if (this.interpolationType === 'cubic' && n >= 4) {
      const x = this.rawHistory.map((s) => s.time);
      r = this.solveSpline(x, this.rawHistory.map((s) => s.r), t);
      g = this.solveSpline(x, this.rawHistory.map((s) => s.g), t);
      b = this.solveSpline(x, this.rawHistory.map((s) => s.b), t);
    } else {
      r = s0.r + u * (s1.r - s0.r);
      g = s0.g + u * (s1.g - s0.g);
      b = s0.b + u * (s1.b - s0.b);
    }

    return {
      time: t,
      r,
      g,
      b,
      coverage,
      fingerScore,
      fingerTileCount,
      centroidMotion,
    };
  }

  private solveSpline(x: number[], y: number[], t: number): number {
    const n = x.length;
    const a = [...y];
    const b = new Array(n - 1).fill(0);
    const c = new Array(n).fill(0);
    const d = new Array(n - 1).fill(0);

    const h = new Array(n - 1);
    for (let j = 0; j < n - 1; j++) {
      h[j] = x[j + 1] - x[j];
    }

    const alpha = new Array(n - 1).fill(0);
    for (let j = 1; j < n - 1; j++) {
      alpha[j] = (3 / h[j]) * (a[j + 1] - a[j]) - (3 / h[j - 1]) * (a[j] - a[j - 1]);
    }

    const l = new Array(n).fill(0);
    const mu = new Array(n).fill(0);
    const z = new Array(n).fill(0);
    l[0] = 1;
    mu[0] = 0;
    z[0] = 0;

    for (let j = 1; j < n - 1; j++) {
      l[j] = 2 * (x[j + 1] - x[j - 1]) - h[j - 1] * mu[j - 1];
      mu[j] = h[j] / l[j];
      z[j] = (alpha[j] - h[j - 1] * z[j - 1]) / l[j];
    }

    l[n - 1] = 1;
    z[n - 1] = 0;
    c[n - 1] = 0;

    for (let j = n - 2; j >= 0; j--) {
      c[j] = z[j] - mu[j] * c[j + 1];
      b[j] = (a[j + 1] - a[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3;
      d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
    }

    // Binary search to find segment
    let low = 0;
    let high = n - 2;
    let idx = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (t >= x[mid] && t <= x[mid + 1]) {
        idx = mid;
        break;
      } else if (t < x[mid]) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const dx = t - x[idx];
    return a[idx] + b[idx] * dx + c[idx] * dx * dx + d[idx] * dx * dx * dx;
  }

  reset(): void {
    this.rawHistory = [];
    this.nextTargetTime = null;
  }
}
