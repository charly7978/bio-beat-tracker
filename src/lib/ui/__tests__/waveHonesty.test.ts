import { describe, it, expect } from 'vitest';
import { realSignalStrength } from '../waveHonesty';

describe('waveHonesty.realSignalStrength', () => {
  it('objeto inerte (perfusión ≈ ruido) → ~0 (onda plana)', () => {
    expect(realSignalStrength(0.0003, 0.6)).toBeCloseTo(0, 5); // PI bajo el piso
  });

  it('objeto MOVIDO (perfusión por movimiento pero SIN periodicidad) → casi plano', () => {
    // Tiene AC (movimiento) pero no es un ritmo cardíaco → periodicidad ~0.
    expect(realSignalStrength(0.006, 0.02)).toBeLessThan(0.1); // casi plano
  });

  it('dedo real (perfusión + periodicidad altas) → ~1 (onda completa)', () => {
    expect(realSignalStrength(0.006, 0.6)).toBeCloseTo(1, 5);
  });

  it('dedo débil → proporción intermedia (no plana, no llena)', () => {
    const s = realSignalStrength(0.0024, 0.35); // PI a mitad, periodicidad justa
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('crece con la perfusión real', () => {
    expect(realSignalStrength(0.005, 0.6)).toBeGreaterThan(realSignalStrength(0.002, 0.6));
  });
});
