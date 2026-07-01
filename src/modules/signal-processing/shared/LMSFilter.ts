/**
 * Normalized Least Mean Squares (NLMS) adaptive filter.
 * Used for real-time motion artifact and pressure drift cancellation by
 * modeling the correlation between the reference noise channel (Red AC)
 * and the primary contaminated channel (Green AC).
 */
export class LMSFilter {
  private weights: Float32Array;
  private xBuffer: Float32Array;

  /**
   * @param order Number of filter coefficients (taps). Higher orders track complex noise but add delay.
   * @param mu Adaptation step size (learning rate).
   * @param eps Regularization parameter to prevent division by zero.
   */
  constructor(
    private readonly order: number = 12,
    private readonly mu: number = 0.05,
    private readonly eps: number = 1e-4
  ) {
    this.weights = new Float32Array(order);
    this.xBuffer = new Float32Array(order);
  }

  /**
   * Process a single time step of the adaptive filter.
   * @param x The reference noise input (e.g. Red channel AC value).
   * @param d The desired corrupted signal input (e.g. Green channel AC value).
   * @returns The error signal e[n] = d[n] - y[n] (the clean, motion-compensated signal).
   */
  filter(x: number, d: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(d)) {
      return 0;
    }

    // 1. Shift the reference signal history buffer
    for (let i = this.order - 1; i > 0; i--) {
      this.xBuffer[i] = this.xBuffer[i - 1];
    }
    this.xBuffer[0] = x;

    // 2. Compute filter output y[n] = sum(w_i * x_{n-i}) and squared norm of input vector
    let y = 0;
    let norm = 0;
    for (let i = 0; i < this.order; i++) {
      const xi = this.xBuffer[i];
      y += this.weights[i] * xi;
      norm += xi * xi;
    }

    // 3. Error calculation: e[n] = d[n] - y[n] (the clean signal)
    const e = d - y;

    // 4. Update filter weights using NLMS formula: w_i = w_i + (mu / (||x||^2 + eps)) * e * x_i
    const step = this.mu / (norm + this.eps);
    const correction = step * e;

    for (let i = 0; i < this.order; i++) {
      this.weights[i] += correction * this.xBuffer[i];

      // Weight clipping to protect against feedback divergence
      if (this.weights[i] > 2.0) this.weights[i] = 2.0;
      else if (this.weights[i] < -2.0) this.weights[i] = -2.0;
    }

    return e;
  }

  reset(): void {
    this.weights.fill(0);
    this.xBuffer.fill(0);
  }
}
