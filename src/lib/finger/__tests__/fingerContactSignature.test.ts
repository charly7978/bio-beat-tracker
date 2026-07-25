import { describe, it, expect } from 'vitest';
import { hasFingerHemoglobinSignature } from '../fingerContactSignature';

describe('hasFingerHemoglobinSignature', () => {
  it('rechaza flash sin dedo (RGB altos equilibrados)', () => {
    expect(
      hasFingerHemoglobinSignature({
        red: 200,
        green: 170,
        blue: 155,
        coverage: 0.2,
        fingerScore: 0.3,
      }),
    ).toBe(false);
  });

  it('acepta firma hemoglobina con cobertura', () => {
    expect(
      hasFingerHemoglobinSignature({
        red: 200,
        green: 90,
        blue: 70,
        coverage: 0.12,
        fingerScore: 0.25,
      }),
    ).toBe(true);
  });

  it('acepta dedo PÁLIDO / de poca presión bajo flash fuerte (R/B moderado)', () => {
    // R/B = 1.35 y escena luminosa (total 271): la regla de brillo previa exigía
    // R/B >= 1.38 y lo rechazaba, aunque la dominancia de rojo (22) es real.
    expect(
      hasFingerHemoglobinSignature({
        red: 105,
        green: 88,
        blue: 78,
        coverage: 0.14,
        fingerScore: 0.22,
      }),
    ).toBe(true);
  });

  it('sigue rechazando escena clara SIN separación de rojo (pared/papel con flash)', () => {
    expect(
      hasFingerHemoglobinSignature({
        red: 190,
        green: 168,
        blue: 160,
        coverage: 0.3,
        fingerScore: 0.4,
      }),
    ).toBe(false);
  });

  it('sigue rechazando cobertura insuficiente aunque el color sea de dedo', () => {
    expect(
      hasFingerHemoglobinSignature({
        red: 200,
        green: 90,
        blue: 70,
        coverage: 0.01,
        fingerScore: 0.02,
      }),
    ).toBe(false);
  });
});
