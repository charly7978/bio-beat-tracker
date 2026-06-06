/**
 * Deterministic FastICA implementation for 3-channel (Red, Green, Blue) signal separation.
 * Highly optimized for real-time PPG/SpO2 processing.
 */

/**
 * Analytical inversion of a 3x3 matrix.
 * Returns null if the matrix is singular.
 */
export function invert3x3(m: number[][] | Float64Array[]): number[][] | null {
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

  if (Math.abs(det) < 1e-12 || !isFinite(det)) return null;

  const invDet = 1.0 / det;
  const res = Array.from({ length: 3 }, () => new Array(3).fill(0));

  res[0][0] = (m[1][1] * m[2][2] - m[2][1] * m[1][2]) * invDet;
  res[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet;
  res[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet;
  res[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet;
  res[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet;
  res[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invDet;
  res[2][0] = (m[1][0] * m[2][1] - m[2][0] * m[1][1]) * invDet;
  res[2][1] = (m[2][0] * m[0][1] - m[0][0] * m[2][1]) * invDet;
  res[2][2] = (m[0][0] * m[1][1] - m[1][0] * m[0][1]) * invDet;

  // Verify all elements are finite
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (!isFinite(res[i][j])) return null;
    }
  }

  return res;
}

/**
 * Jacobi eigenvalue algorithm for symmetric 3x3 matrix.
 * Computes eigenvalues and eigenvectors V such that A = V * D * V^T.
 */
export function jacobiEigenvalue3x3(A: number[][] | Float64Array[]): { V: number[][]; d: number[] } | null {
  const n = 3;
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1.0 : 0.0)));
  const d = [A[0][0], A[1][1], A[2][2]];
  const a = [
    [A[0][0], A[0][1], A[0][2]],
    [A[1][0], A[1][1], A[1][2]],
    [A[2][0], A[2][1], A[2][2]],
  ];

  const maxSweeps = 50;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let sumOff = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        sumOff += Math.abs(a[i][j]);
      }
    }
    if (sumOff < 1e-15) {
      return { V, d };
    }

    const thresh = sweep < 3 ? (0.2 * sumOff) / (n * n) : 0.0;

    for (let ip = 0; ip < n - 1; ip++) {
      for (let iq = ip + 1; iq < n; iq++) {
        const g = 100.0 * Math.abs(a[ip][iq]);
        if (sweep > 3 && g <= 1e-15) {
          a[ip][iq] = 0.0;
        } else if (Math.abs(a[ip][iq]) > thresh) {
          let h = d[iq] - d[ip];
          let t;
          if (g <= 1e-15) {
            t = a[ip][iq] / h;
          } else {
            const theta = (0.5 * h) / a[ip][iq];
            t = 1.0 / (Math.abs(theta) + Math.sqrt(1.0 + theta * theta));
            if (theta < 0.0) t = -t;
          }
          const c = 1.0 / Math.sqrt(1.0 + t * t);
          const s = t * c;
          const tau = s / (1.0 + c);
          h = t * a[ip][iq];
          d[ip] -= h;
          d[iq] += h;
          a[ip][iq] = 0.0;

          for (let j = 0; j < ip; j++) {
            const g1 = a[j][ip];
            const h1 = a[j][iq];
            a[j][ip] = g1 - s * (h1 + g1 * tau);
            a[j][iq] = h1 + s * (g1 - h1 * tau);
          }
          for (let j = ip + 1; j < iq; j++) {
            const g1 = a[ip][j];
            const h1 = a[j][iq];
            a[ip][j] = g1 - s * (h1 + g1 * tau);
            a[j][iq] = h1 + s * (g1 - h1 * tau);
          }
          for (let j = iq + 1; j < n; j++) {
            const g1 = a[ip][j];
            const h1 = a[iq][j];
            a[ip][j] = g1 - s * (h1 + g1 * tau);
            a[iq][j] = h1 + s * (g1 - h1 * tau);
          }
          for (let j = 0; j < n; j++) {
            const g1 = V[j][ip];
            const h1 = V[j][iq];
            V[j][ip] = g1 - s * (h1 + g1 * tau);
            V[j][iq] = h1 + s * (g1 - h1 * tau);
          }
        }
      }
    }
  }
  return { V, d };
}

/**
 * FastICA algorithm for 3 channels.
 * Separates X (3 x N) into independent components.
 * Returns the 3x3 mixing matrix A (columns represent channels' mixing coefficients for each source),
 * and the separated independent component waveforms S (3 x N).
 */
export function fastICA(
  X: number[][],
  maxIterations = 30,
  tolerance = 1e-6
): { A: number[][]; S: number[][] } | null {
  const channels = X.length;
  if (channels !== 3) return null;
  const N = X[0].length;
  if (N < 10) return null;

  // 1. Centering: Subtract mean from each channel
  const mean = new Float64Array(channels);
  const centeredX = X.map((row, c) => {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += row[i];
    const avg = sum / N;
    mean[c] = avg;
    return row.map(val => val - avg);
  });

  // 2. Covariance matrix (3x3)
  const cov = Array.from({ length: channels }, () => new Float64Array(channels));
  for (let i = 0; i < channels; i++) {
    for (let j = 0; j < channels; j++) {
      let sum = 0;
      for (let k = 0; k < N; k++) {
        sum += centeredX[i][k] * centeredX[j][k];
      }
      cov[i][j] = sum / N;
    }
  }

  // 3. Eigenvalue decomposition for whitening
  const eigen = jacobiEigenvalue3x3(cov);
  if (!eigen) return null;

  const { V: E, d: D } = eigen;

  // 4. Whitening matrix V_white = E * D^(-1/2) * E^T
  const whitenMat = Array.from({ length: 3 }, () => new Float64Array(3));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        if (D[k] > 1e-12) {
          sum += E[i][k] * (1.0 / Math.sqrt(D[k])) * E[j][k];
        }
      }
      whitenMat[i][j] = sum;
    }
  }

  // Whitened signals Z = whitenMat * centeredX
  const Z = Array.from({ length: 3 }, () => new Float64Array(N));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < N; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += whitenMat[i][k] * centeredX[k][j];
      }
      Z[i][j] = sum;
    }
  }

  // 5. Fixed-point iteration (FastICA)
  // Initialize W as 3x3 identity matrix for deterministic convergence behavior.
  const W = Array.from({ length: 3 }, () => new Float64Array(3));
  for (let i = 0; i < 3; i++) W[i][i] = 1.0;

  for (let c = 0; c < 3; c++) {
    const w = new Float64Array(3);
    w[c] = 1.0; // Seed identity vector

    for (let iter = 0; iter < maxIterations; iter++) {
      const wPrev = new Float64Array(w);
      const wtz = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        wtz[i] = w[0] * Z[0][i] + w[1] * Z[1][i] + w[2] * Z[2][i];
      }

      // g(u) = tanh(u), g'(u) = 1 - tanh^2(u)
      const wNew = new Float64Array(3);
      let gSum = 0;
      for (let i = 0; i < N; i++) {
        const u = wtz[i];
        const tanhU = Math.tanh(u);
        const g = tanhU;
        const gp = 1.0 - tanhU * tanhU;
        gSum += gp;
        wNew[0] += Z[0][i] * g;
        wNew[1] += Z[1][i] * g;
        wNew[2] += Z[2][i] * g;
      }

      wNew[0] = wNew[0] / N - (gSum / N) * w[0];
      wNew[1] = wNew[1] / N - (gSum / N) * w[1];
      wNew[2] = wNew[2] / N - (gSum / N) * w[2];

      // Gram-Schmidt orthogonalization against previous columns of W
      for (let prevC = 0; prevC < c; prevC++) {
        const dot = wNew[0] * W[prevC][0] + wNew[1] * W[prevC][1] + wNew[2] * W[prevC][2];
        wNew[0] -= dot * W[prevC][0];
        wNew[1] -= dot * W[prevC][1];
        wNew[2] -= dot * W[prevC][2];
      }

      // Normalize
      const norm = Math.sqrt(wNew[0] * wNew[0] + wNew[1] * wNew[1] + wNew[2] * wNew[2]);
      if (norm > 1e-12) {
        w[0] = wNew[0] / norm;
        w[1] = wNew[1] / norm;
        w[2] = wNew[2] / norm;
      }

      // Check convergence: |w^T wPrev| ≈ 1
      const cosAngle = Math.abs(w[0] * wPrev[0] + w[1] * wPrev[1] + w[2] * wPrev[2]);
      if (Math.abs(cosAngle - 1.0) < tolerance) {
        break;
      }
    }

    W[c] = w;
  }

  // Demixing matrix B = W * whitenMat
  const B = Array.from({ length: 3 }, () => new Float64Array(3));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += W[i][k] * whitenMat[k][j];
      }
      B[i][j] = sum;
    }
  }

  // Mixing matrix A = B^(-1)
  const A = invert3x3(B);
  if (!A) return null;

  // Reconstruct source waveforms S = B * centeredX
  const S = Array.from({ length: 3 }, () => new Array<number>(N));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < N; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += B[i][k] * centeredX[k][j];
      }
      S[i][j] = sum;
    }
  }

  return { A, S };
}
