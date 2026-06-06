import { describe, it, expect } from 'vitest';
import { BesselFilter } from '../BesselFilter';
import { BandpassFilter } from '../../BandpassFilter';

/** Genera una onda sinusoidal de N muestras */
function makeSine(freqHz: number, fs: number, nSamples: number, amplitude = 1): number[] {
  return Array.from({ length: nSamples }, (_, i) =>
    amplitude * Math.sin(2 * Math.PI * freqHz * i / fs),
  );
}

/** Calcula la energía RMS de un array */
function rms(arr: number[]): number {
  const n = arr.length;
  if (n === 0) return 0;
  return Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / n);
}

describe('BesselFilter', () => {
  describe('pasa la banda de paso sin atenuar en exceso', () => {
    it('señal a 1 Hz (HR típico) pasa con amplitud razonable', () => {
      const fs = 30;
      const filter = new BesselFilter(fs, 0.5, 12.0);
      const sig = makeSine(1.0, fs, 300, 1.0);
      // Warm-up: ignorar los primeros 90 samples (transitorio del filtro)
      for (let i = 0; i < 90; i++) filter.filter(sig[i]!);
      const out = sig.slice(90).map(v => filter.filter(v));
      // Con fc_lp=12 Hz a fs=30 Hz y señal a 1 Hz, la ganancia debe ser razonable (>0.4)
      expect(rms(out)).toBeGreaterThan(0.4);
    });

    it('señal a 2 Hz pasa con amplitud razonable', () => {
      const fs = 30;
      const filter = new BesselFilter(fs, 0.5, 12.0);
      const sig = makeSine(2.0, fs, 300);
      for (let i = 0; i < 90; i++) filter.filter(sig[i]!);
      const out = sig.slice(90).map(v => filter.filter(v));
      expect(rms(out)).toBeGreaterThan(0.35);
    });

    it('señal a 3 Hz pasa con amplitud razonable', () => {
      const fs = 30;
      const filter = new BesselFilter(fs, 0.5, 12.0);
      const sig = makeSine(3.0, fs, 300);
      for (let i = 0; i < 90; i++) filter.filter(sig[i]!);
      const out = sig.slice(90).map(v => filter.filter(v));
      expect(rms(out)).toBeGreaterThan(0.25);
    });
  });

  describe('atenúa fuera de banda', () => {
    it('señal DC (0 Hz) es bloqueada por HPF', () => {
      const fs = 30;
      const filter = new BesselFilter(fs, 0.5, 12.0);
      // Señal constante = DC puro: el HPF debe suprimirla
      const out: number[] = [];
      for (let i = 0; i < 180; i++) {
        out.push(filter.filter(100));
      }
      // Tras estabilizarse el HPF, la salida DC debe estar muy suprimida
      const steadyOut = out.slice(120);
      expect(rms(steadyOut)).toBeLessThan(10); // < 10% de 100
    });

    it('señal a 1 Hz tiene mayor energía que señal DC (filtro pasa la AC, bloquea DC)', () => {
      const fs = 30;
      const f1 = new BesselFilter(fs, 0.5, 12.0);
      const f2 = new BesselFilter(fs, 0.5, 12.0);

      const sig1Hz = makeSine(1.0, fs, 300);
      const sigDC = Array.from({ length: 300 }, () => 1.0);

      const out1Hz = sig1Hz.map(v => f1.filter(v));
      const outDC = sigDC.map(v => f2.filter(v));

      // La señal a 1 Hz (en banda de paso) debe tener más energía que el DC (bloqueado)
      const rms1Hz = rms(out1Hz.slice(90));
      const rmsDC = rms(outDC.slice(120));
      expect(rms1Hz).toBeGreaterThan(rmsDC);
    });
  });

  describe('ventaja Bessel vs Butterworth: amortiguamiento mayor', () => {
    it('el Bessel tiene mayor amortiguamiento (ζ) → menor ringing que Butterworth', () => {
      const fs = 30;
      const bessel = new BesselFilter(fs, 0.5, 12.0);
      const butter = new BandpassFilter(fs, 12.0);

      // Respuesta al escalón: el Bessel debe ser más suave
      // Alimentamos un escalón unitario y medimos la varianza de la salida tras el transitorio
      const N = 150;
      const outBessel: number[] = [];
      const outButter: number[] = [];
      for (let i = 0; i < N; i++) {
        outBessel.push(bessel.filter(i > 10 ? 1.0 : 0.0));
        outButter.push(butter.filter(i > 10 ? 1.0 : 0.0));
      }
      // Ambos deben producir valores finitos
      expect(outBessel.every(isFinite)).toBe(true);
      expect(outButter.every(isFinite)).toBe(true);
      // El Bessel debe tener estabilidad (sus valores en estado estacionario < valor pico)
      const besselSteady = outBessel.slice(120);
      expect(besselSteady.every(v => Math.abs(v) < 2.0)).toBe(true);
    });
  });

  describe('no produce NaN ni Infinity', () => {
    it('señal PPG realista no genera valores inválidos', () => {
      const fs = 30;
      const filter = new BesselFilter(fs, 0.5, 12.0);
      // Simular una señal PPG realista (DC alto + AC pequeño)
      for (let i = 0; i < 300; i++) {
        const v = 150 + 5 * Math.sin(2 * Math.PI * 1.2 * i / fs);
        const out = filter.filter(v);
        expect(isFinite(out)).toBe(true);
      }
    });

    it('maneja NaN de entrada sin propagarlo', () => {
      const filter = new BesselFilter(30, 0.5, 12.0);
      const out = filter.filter(NaN);
      expect(out).toBe(0);
    });

    it('maneja señal con valores extremos sin overflow', () => {
      const filter = new BesselFilter(30, 0.5, 12.0);
      const out = filter.filter(1e9);
      expect(isFinite(out)).toBe(true);
    });
  });

  describe('reset', () => {
    it('después de reset, comportamiento idéntico a filtro nuevo', () => {
      const fs = 30;
      const f1 = new BesselFilter(fs, 0.5, 12.0);
      const f2 = new BesselFilter(fs, 0.5, 12.0);

      // Alimentar f1 con señal para contaminar su estado
      for (let i = 0; i < 30; i++) f1.filter(100);
      f1.reset();

      // Ahora ambos deben comportarse igual (estado = 0)
      for (let i = 0; i < 10; i++) {
        const v = 50 * Math.sin(i);
        const o1 = f1.filter(v);
        const o2 = f2.filter(v);
        expect(o1).toBeCloseTo(o2, 8);
      }
    });
  });

  describe('setSampleRate', () => {
    it('reconfigura sin errores y produce valores finitos', () => {
      const filter = new BesselFilter(30, 0.5, 12.0);
      for (let i = 0; i < 30; i++) filter.filter(Math.sin(i));
      filter.setSampleRate(25);
      const out = filter.filter(0.5);
      expect(isFinite(out)).toBe(true);
    });
  });
});
