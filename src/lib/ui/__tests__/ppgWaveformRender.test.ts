import { describe, expect, it } from 'vitest';
import { densifyCatmullRom2D, knotDerivativesY, strokeWidthFromScreenDy } from '../ppgWaveformRender';

describe('ppgWaveformRender', () => {
  it('densifyCatmullRom2D conserva extremos y suaviza entre nudos', () => {
    const knots = [
      { x: 0, y: 100 },
      { x: 50, y: 50 },
      { x: 100, y: 100 },
    ];
    const d = densifyCatmullRom2D(knots, 8);
    expect(d.length).toBeGreaterThan(knots.length);
    expect(d[0].x).toBeCloseTo(0, 5);
    expect(d[0].y).toBeCloseTo(100, 5);
    expect(d[d.length - 1].x).toBeCloseTo(100, 5);
    expect(d[d.length - 1].y).toBeCloseTo(100, 5);
  });

  it('knotDerivativesY tiene la misma longitud que los nudos', () => {
    const knots = [
      { x: 0, y: 10 },
      { x: 1, y: 20 },
      { x: 2, y: 5 },
    ];
    expect(knotDerivativesY(knots)).toHaveLength(3);
  });

  it('strokeWidthFromScreenDy acota el grosor', () => {
    expect(strokeWidthFromScreenDy(0)).toBeCloseTo(0.9, 5);
    expect(strokeWidthFromScreenDy(999)).toBeLessThanOrEqual(1.55);
  });
});
