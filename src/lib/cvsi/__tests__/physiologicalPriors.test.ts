import { describe, it, expect } from 'vitest';
import { computeBvpCoherence, computeRrCv, computeEctopyScore } from '../physiologicalPriors';
import { regularRr } from './ppgFixtures';

describe('computeBvpCoherence', () => {
  it('alta con pulsatilidad coherente en rojo y verde (tejido vivo)', () => {
    const c = computeBvpCoherence({ acRed: 0.02, dcRed: 1.0, acGreen: 0.024, dcGreen: 1.0 });
    expect(c).toBeGreaterThan(0.7);
  });

  it('baja/nula sin pulsatilidad (objeto plano)', () => {
    const c = computeBvpCoherence({ acRed: 0.00001, dcRed: 1.0, acGreen: 0.00001, dcGreen: 1.0 });
    expect(c).toBeLessThan(0.2);
  });

  it('nula sin canales', () => {
    expect(computeBvpCoherence(undefined)).toBe(0);
  });
});

describe('computeRrCv', () => {
  it('bajo para ritmo regular', () => {
    expect(computeRrCv(regularRr(72, 12, 10))).toBeLessThan(0.08);
  });

  it('alto para ritmo muy irregular', () => {
    const irregular = [600, 1100, 700, 1300, 550, 1200, 900];
    expect(computeRrCv(irregular)).toBeGreaterThan(0.2);
  });
});

describe('computeEctopyScore', () => {
  it('detecta patrón corto-largo (latido prematuro)', () => {
    // Base ~833ms; prematuro 600 seguido de pausa compensatoria 1066 (suma ≈ 2×).
    const rr = [833, 833, 600, 1066, 833, 833, 600, 1066];
    expect(computeEctopyScore(rr)).toBeGreaterThan(0.2);
  });

  it('bajo para ritmo regular', () => {
    expect(computeEctopyScore(regularRr(72, 12, 5))).toBeLessThan(0.15);
  });
});
