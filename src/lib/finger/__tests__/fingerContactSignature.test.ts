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
});
