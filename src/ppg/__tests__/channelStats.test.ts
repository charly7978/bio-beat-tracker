import { describe, it, expect } from 'vitest';
import { computeChannelAcDc } from '../channelStats';
import type { RoiSample } from '../roiSampler';

function window(n: number, f: (i: number) => [number, number, number]): RoiSample[] {
  return Array.from({ length: n }, (_, i) => {
    const [red, green, blue] = f(i);
    return { red, green, blue, timestampMs: i * 33 };
  });
}

describe('computeChannelAcDc (insumo de SpO2)', () => {
  it('separa AC y DC por canal', () => {
    const w = window(200, (i) => [150 + 3 * Math.sin(i / 5), 60 + 1 * Math.sin(i / 5), 50]);
    const c = computeChannelAcDc(w);
    expect(c.dcRed).toBeCloseTo(150, 0);
    expect(c.dcGreen).toBeCloseTo(60, 0);
    expect(c.acRed).toBeGreaterThan(c.acGreen);
    // Canal sin pulsatilidad → AC nulo, no ruido.
    expect(c.acBlue).toBeCloseTo(0, 6);
    expect(c.dcBlue).toBeCloseTo(50, 6);
  });

  it('un único cuadro atípico NO fabrica AC (rango robusto p95−p05)', () => {
    const w = window(200, () => [150, 60, 50]);
    w[100] = { ...w[100]!, red: 255 };
    expect(computeChannelAcDc(w).acRed).toBeCloseTo(0, 6);
  });

  it('sin muestras suficientes devuelve ceros, no valores inventados', () => {
    const c = computeChannelAcDc(window(3, () => [150, 60, 50]));
    expect(c).toEqual({ acRed: 0, dcRed: 0, acGreen: 0, dcGreen: 0, acBlue: 0, dcBlue: 0 });
  });
});
