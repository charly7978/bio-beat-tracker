import { describe, expect, it } from 'vitest';
import {
  computeWaveformScale,
  decimateMinMaxPreserve,
  type WaveformPoint,
} from '../ppgWaveformPath';

describe('computeWaveformScale', () => {
  it('centra la señal y devuelve halfSpan positivo', () => {
    const values = [10, 12, 11, 13, 10.5, 12.5];
    const { center, halfSpan } = computeWaveformScale(values, 1.2);
    expect(center).toBeCloseTo(11.5, 1);
    expect(halfSpan).toBeGreaterThan(0);
  });
});

describe('decimateMinMaxPreserve', () => {
  it('conserva picos en buckets', () => {
    const pts: WaveformPoint[] = [];
    for (let t = 0; t < 100; t++) {
      const v = Math.sin(t * 0.3) * 10;
      pts.push({ time: t, value: v, isArr: false });
    }
    const out = decimateMinMaxPreserve(pts, 20);
    expect(out.length).toBeLessThan(pts.length);
    expect(out.length).toBeGreaterThanOrEqual(20);
    const maxIn = Math.max(...pts.map((p) => p.value));
    const maxOut = Math.max(...out.map((p) => p.value));
    expect(maxOut).toBeGreaterThan(maxIn * 0.85);
  });
});
