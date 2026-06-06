import { describe, it, expect } from 'vitest';
import { bandLimitedDominantFreq } from '../dsp';

const TWO_PI = Math.PI * 2;

function sine(freqHz: number, fs: number, seconds: number, amp = 1): number[] {
  const n = Math.round(fs * seconds);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(TWO_PI * freqHz * (i / fs));
  return out;
}

describe('bandLimitedDominantFreq', () => {
  it('recupera la frecuencia de una onda pura dentro de la banda', () => {
    const fs = 20;
    const s = sine(0.25, fs, 20); // 0.25 Hz
    const { freqHz, quality } = bandLimitedDominantFreq(s, fs, 0.1, 0.6);
    expect(freqHz).toBeGreaterThan(0.23);
    expect(freqHz).toBeLessThan(0.27);
    expect(quality).toBeGreaterThan(0.8); // onda pura → concentración alta
  });

  it('no confunde el fundamental con un sub-armónico', () => {
    // 0.4 Hz: el periodograma debe elegir 0.4, no 0.2.
    const fs = 20;
    const s = sine(0.4, fs, 20);
    const { freqHz } = bandLimitedDominantFreq(s, fs, 0.1, 0.6);
    expect(freqHz).toBeGreaterThan(0.37);
    expect(freqHz).toBeLessThan(0.43);
  });

  it('señal plana → calidad 0', () => {
    const flat = new Array(200).fill(3.3);
    const { quality } = bandLimitedDominantFreq(flat, 20, 0.1, 0.6);
    expect(quality).toBe(0);
  });

  it('respeta Nyquist (banda por encima de fs/2 se recorta)', () => {
    const fs = 4;
    const s = sine(0.3, fs, 30);
    // Pedimos hasta 5 Hz pero fs/2 = 2 Hz → no debe romperse ni devolver basura.
    const { freqHz } = bandLimitedDominantFreq(s, fs, 0.1, 5);
    expect(freqHz).toBeGreaterThan(0.25);
    expect(freqHz).toBeLessThan(0.35);
  });

  it('entrada demasiado corta → sin estimación', () => {
    const { freqHz, quality } = bandLimitedDominantFreq([1, 2, 3], 20, 0.1, 0.6);
    expect(freqHz).toBe(0);
    expect(quality).toBe(0);
  });
});
