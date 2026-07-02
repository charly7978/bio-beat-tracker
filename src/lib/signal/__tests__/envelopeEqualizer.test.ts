import { describe, it, expect } from 'vitest';
import {
  EnvelopeEqualizer,
  type EnvelopeEqualizerConfig,
} from '../envelopeEqualizer';

const cfg = (over: Partial<EnvelopeEqualizerConfig> = {}): EnvelopeEqualizerConfig => ({
  attack: 0.025,
  release: 0.025,
  slowAlpha: 0.005,
  floorFrac: 0.35,
  maxGain: 4,
  mix: 1.0,
  ...over,
});

/** Tren de latidos gaussianos con modulación respiratoria de amplitud. */
function beatTrain(nBeats: number, period = 25, width = 3): { sig: number[]; centers: number[]; amps: number[] } {
  const sig: number[] = [];
  const centers: number[] = [];
  const amps: number[] = [];
  const total = nBeats * period;
  for (let k = 0; k < nBeats; k++) {
    centers.push(k * period + Math.floor(period / 2));
    amps.push(1 + 0.7 * Math.sin((2 * Math.PI * k) / 6)); // ~6 latidos por ciclo resp.
  }
  for (let i = 0; i < total; i++) {
    let v = 0;
    for (let k = 0; k < nBeats; k++) {
      const d = i - centers[k];
      v += amps[k] * Math.exp(-(d * d) / (2 * width * width));
    }
    sig.push(v);
  }
  return { sig, centers, amps };
}

function cv(values: number[]): number {
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
  return Math.sqrt(v) / Math.max(1e-9, Math.abs(m));
}

/** Índice del máximo en una ventana ±half alrededor de `center`. */
function localArgmax(x: number[], center: number, half: number): number {
  let best = center;
  let bestV = -Infinity;
  for (let i = Math.max(0, center - half); i <= Math.min(x.length - 1, center + half); i++) {
    if (x[i] > bestV) { bestV = x[i]; best = i; }
  }
  return best;
}

describe('EnvelopeEqualizer', () => {
  it('comprime el rango dinámico: aplana la modulación de amplitud entre latidos', () => {
    const { sig, centers } = beatTrain(24);
    const eq = new EnvelopeEqualizer(cfg());
    const out = sig.map((v) => eq.process(v));

    // Amplitud por latido (pico) antes y después, saltando warm-up inicial.
    const skip = 6;
    const inPeaks = centers.slice(skip).map((c) => sig[c]);
    const outPeaks = centers.slice(skip).map((c) => out[c]);

    // La dispersión relativa de las alturas de latido debe bajar de forma real
    // (≥20%) con un attack suave que preserva el timing del pico.
    expect(cv(outPeaks)).toBeLessThan(cv(inPeaks) * 0.8);
  });

  it('preserva la UBICACIÓN del pico de cada latido (invariante clave para detección)', () => {
    const { sig, centers } = beatTrain(24);
    const eq = new EnvelopeEqualizer(cfg());
    const out = sig.map((v) => eq.process(v));

    // Para latidos del medio (tras warm-up), el índice del máximo no debe correrse
    // más de 1 muestra: aunque la amplitud se reescala, Elgendi sigue viendo el
    // pico en el mismo lugar.
    const argmaxIn = (c: number) => localArgmax(sig, c, 8);
    const argmaxOut = (c: number) => localArgmax(out, c, 8);
    for (let k = 8; k < 20; k++) {
      const c = centers[k];
      expect(Math.abs(argmaxOut(c) - argmaxIn(c))).toBeLessThanOrEqual(1);
    }
  });

  it('mix=0 es passthrough exacto', () => {
    const eq = new EnvelopeEqualizer(cfg({ mix: 0 }));
    const inp = [0.2, -1.3, 5, -2, 0.01, 3.3];
    for (const v of inp) {
      expect(eq.process(v)).toBe(v);
    }
  });

  it('preserva el signo de la muestra', () => {
    const { sig } = beatTrain(12);
    const eq = new EnvelopeEqualizer(cfg());
    for (const v of sig) {
      const o = eq.process(v);
      if (v > 0) expect(o).toBeGreaterThanOrEqual(0);
      if (v < 0) expect(o).toBeLessThanOrEqual(0);
    }
  });

  it('acota la ganancia (no infla ruido pequeño más allá de maxGain)', () => {
    const eq = new EnvelopeEqualizer(cfg({ maxGain: 4 }));
    // Ruido chico sostenido: la salida no debe superar maxGain × entrada.
    let maxRatio = 0;
    for (let i = 0; i < 200; i++) {
      const v = 0.05 * Math.sin(i);
      const o = eq.process(v);
      if (Math.abs(v) > 1e-6) maxRatio = Math.max(maxRatio, Math.abs(o / v));
    }
    expect(maxRatio).toBeLessThanOrEqual(4 + 1e-6);
  });

  it('seguridad: NaN/Inf → 0 finito y reset limpia estado', () => {
    const eq = new EnvelopeEqualizer(cfg());
    expect(eq.process(NaN)).toBe(0);
    expect(eq.process(Infinity)).toBe(0);
    eq.process(5);
    eq.reset();
    // Tras reset, la primera muestra re-inicializa la envolvente (sin arrastre).
    const first = eq.process(1);
    expect(Number.isFinite(first)).toBe(true);
  });
});
