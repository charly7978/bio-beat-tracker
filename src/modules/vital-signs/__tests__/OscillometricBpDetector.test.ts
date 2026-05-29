import { describe, expect, it } from 'vitest';
import { analyzeOscillogram, detectPressureRamp } from '../OscillometricBpDetector';
import { isPhysiologicalBp } from '@/lib/vitals/pwaPhysiologicalBpEngine';

function makeRampSamples(length = 120): { dcBaseline: number; pulseAmplitude: number }[] {
  const samples: { dcBaseline: number; pulseAmplitude: number }[] = [];
  for (let i = 0; i < length; i++) {
    const t = i / length;
    // Gaussian-like oscillogram centered at 40% of the ramp
    const amp = Math.exp(-((t - 0.4) ** 2) / (2 * 0.08 ** 2));
    // Rising DC baseline
    const dc = 0.5 + t * 0.4;
    samples.push({ dcBaseline: dc, pulseAmplitude: amp });
  }
  return samples;
}

describe('OscillometricBpDetector', () => {
  it('estima PA desde oscilograma sintético con Gaussian peak', () => {
    const samples = makeRampSamples(150);
    const result = analyzeOscillogram(samples);
    expect(result.confidence).not.toBe('INSUFFICIENT');
    expect(isPhysiologicalBp(result.systolic, result.diastolic)).toBe(true);
    expect(result.diastolic).toBeLessThan(result.systolic);
    expect(result.systolic).toBeGreaterThanOrEqual(70);
    expect(result.systolic).toBeLessThanOrEqual(220);
    expect(result.diastolic).toBeGreaterThanOrEqual(40);
    expect(result.diastolic).toBeLessThanOrEqual(130);
    expect(result.map).toBeGreaterThan(0);
    expect(result.pulsePressure).toBeGreaterThan(0);
  });

  it('retorna INSUFFICIENT con pocas muestras', () => {
    const samples = makeRampSamples(20);
    const result = analyzeOscillogram(samples);
    expect(result.confidence).toBe('INSUFFICIENT');
    expect(result.systolic).toBe(0);
  });

  it('detecta rampa de presión en DC', () => {
    // Ramp: DC increases significantly
    const dcRamp = Array.from({ length: 100 }, (_, i) => 0.3 + (i / 100) * 0.5);
    expect(detectPressureRamp(dcRamp)).toBe(true);
  });

  it('no detecta rampa en señal plana de DC', () => {
    const flat = Array.from({ length: 100 }, () => 0.5);
    expect(detectPressureRamp(flat)).toBe(false);
  });
});
