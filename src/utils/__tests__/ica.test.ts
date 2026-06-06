import { describe, expect, it } from 'vitest';
import { invert3x3, jacobiEigenvalue3x3, fastICA } from '../ica';

describe('ICA Mathematics', () => {
  describe('invert3x3', () => {
    it('inverts a simple diagonal matrix correctly', () => {
      const M = [
        [2, 0, 0],
        [0, 5, 0],
        [0, 0, 10],
      ];
      const inv = invert3x3(M);
      expect(inv).toBeDefined();
      expect(inv![0][0]).toBeCloseTo(0.5);
      expect(inv![1][1]).toBeCloseTo(0.2);
      expect(inv![2][2]).toBeCloseTo(0.1);
    });

    it('returns null for singular matrix', () => {
      const M = [
        [1, 2, 3],
        [1, 2, 3],
        [0, 0, 0],
      ];
      const inv = invert3x3(M);
      expect(inv).toBeNull();
    });
  });

  describe('jacobiEigenvalue3x3', () => {
    it('decomposes a symmetric matrix correctly', () => {
      // Symmetric matrix
      const A = [
        [4, 1, 2],
        [1, 3, 0],
        [2, 0, 5],
      ];
      const res = jacobiEigenvalue3x3(A);
      expect(res).toBeDefined();
      const { V, d } = res!;
      
      // Eigenvalues should be close to actual values
      // Check that V * D * V^T recovers A
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          let sum = 0;
          for (let k = 0; k < 3; k++) {
            sum += V[i][k] * d[k] * V[j][k];
          }
          expect(sum).toBeCloseTo(A[i][j], 5);
        }
      }
    });
  });

  describe('fastICA', () => {
    it('separates mixed independent signals', () => {
      const N = 100;
      const t = Array.from({ length: N }, (_, i) => i);
      
      // 3 independent source signals: sine wave, square wave-ish, noise
      const s0 = t.map(v => Math.sin(2 * Math.PI * 0.05 * v));
      const s1 = t.map(v => (Math.sin(2 * Math.PI * 0.1 * v) > 0 ? 1 : -1));
      const s2 = t.map(v => Math.sin(v * v * 0.01));

      // Mixing matrix
      const A = [
        [0.6, 0.2, 0.2],
        [0.1, 0.8, 0.1],
        [0.3, 0.3, 0.4],
      ];

      // Mixed signals
      const X = Array.from({ length: 3 }, (_, c) => {
        return Array.from({ length: N }, (_, i) => {
          return A[c][0] * s0[i] + A[c][1] * s1[i] + A[c][2] * s2[i];
        });
      });

      const res = fastICA(X);
      expect(res).toBeDefined();
      expect(res!.A).toBeDefined();
      expect(res!.S).toBeDefined();

      // Mixing matrix dimensions
      expect(res!.A.length).toBe(3);
      expect(res!.A[0].length).toBe(3);

      // Reconstructed sources dimensions
      expect(res!.S.length).toBe(3);
      expect(res!.S[0].length).toBe(N);
    });

    it('returns null if input signal has insufficient length', () => {
      const X = [[1, 2], [3, 4], [5, 6]];
      const res = fastICA(X);
      expect(res).toBeNull();
    });
  });
});
