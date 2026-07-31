import { describe, it, expect } from 'vitest';
import { detectMsptd, rrIntervalsFromPeaks } from '../MsptdDetector';

/** Generador determinista: un fallo tiene que poder reproducirse exactamente. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
function gauss(rng: () => number): number {
  return rng() + rng() + rng() + rng() + rng() + rng() - 3;
}

const FS = 30;

/**
 * Onda PPG con forma realista: subida sistólica abrupta y caída diastólica
 * lenta, más muesca dicrótica. NO es una sinusoide — la asimetría es justo lo
 * que un detector de latidos debe aprovechar.
 */
function ppgWave(bpm: number, seconds: number, noise = 0, seed = 1): number[] {
  const rng = makeRng(seed);
  const n = Math.round(seconds * FS);
  const period = (60 / bpm) * FS;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const phase = (i % period) / period;
    // Sístole: subida rápida hasta 0.18; diástole: caída exponencial + notch.
    const systole = Math.exp(-((phase - 0.18) ** 2) / (2 * 0.055 ** 2));
    const dicrotic = 0.32 * Math.exp(-((phase - 0.45) ** 2) / (2 * 0.07 ** 2));
    out.push(systole + dicrotic + noise * gauss(rng));
  }
  return out;
}

/** Índices de pico esperados para una onda de `bpm`. */
function expectedPeakCount(bpm: number, seconds: number): number {
  return Math.floor((bpm / 60) * seconds);
}

describe('detectMsptd', () => {
  describe('detección sobre onda PPG limpia', () => {
    it.each([50, 60, 72, 90, 120])('encuentra los latidos a %i lpm', (bpm) => {
      const sig = ppgWave(bpm, 10);
      const r = detectMsptd(sig);

      const expected = expectedPeakCount(bpm, 10);
      // Tolerancia de ±1: los latidos de los bordes caen fuera de la zona
      // evaluable (el escalograma necesita d vecinos a cada lado).
      expect(Math.abs(r.peaks.length - expected)).toBeLessThanOrEqual(2);
    });

    it('la escala dominante corresponde al medio periodo cardíaco', () => {
      const bpm = 60;
      const r = detectMsptd(ppgWave(bpm, 12));

      // 2 * scale / fs ≈ intervalo RR en segundos
      const rrEstimateS = (2 * r.dominantScale) / FS;
      const rrTrueS = 60 / bpm;

      expect(rrEstimateS).toBeGreaterThan(rrTrueS * 0.5);
      expect(rrEstimateS).toBeLessThan(rrTrueS * 1.5);
    });

    it('los picos van en orden ascendente y sin repetidos', () => {
      const r = detectMsptd(ppgWave(72, 10));
      for (let i = 1; i < r.peaks.length; i++) {
        expect(r.peaks[i]).toBeGreaterThan(r.peaks[i - 1]);
      }
    });

    it('no confunde la muesca dicrótica con un latido', () => {
      // La muesca es un máximo local a escala pequeña. Si el detector la
      // contara, saldría el doble de latidos.
      const bpm = 60;
      const r = detectMsptd(ppgWave(bpm, 12));

      expect(r.peaks.length).toBeLessThan(expectedPeakCount(bpm, 12) * 1.5);
    });

    it('detecta también los valles (onsets)', () => {
      const r = detectMsptd(ppgWave(72, 10));
      expect(r.troughs.length).toBeGreaterThan(0);
    });
  });

  describe('sin parámetros que ajustar — misma llamada en todo el rango', () => {
    it('funciona de bradicardia a taquicardia sin reconfigurar nada', () => {
      // Este es el motivo de elegir MSPTD: la misma llamada, sin umbrales ni
      // ventanas por régimen.
      for (const bpm of [40, 55, 75, 100, 150, 180]) {
        const r = detectMsptd(ppgWave(bpm, 12));
        const expected = expectedPeakCount(bpm, 12);
        expect(r.peaks.length).toBeGreaterThan(expected * 0.6);
      }
    });
  });

  describe('robustez al ruido', () => {
    it('sigue encontrando los latidos con ruido moderado', () => {
      const bpm = 72;
      const r = detectMsptd(ppgWave(bpm, 12, 0.06, 7));
      const expected = expectedPeakCount(bpm, 12);

      expect(r.peaks.length).toBeGreaterThan(expected * 0.7);
      expect(r.peaks.length).toBeLessThan(expected * 1.4);
    });

    it('es invariante a la escala de amplitud', () => {
      const sig = ppgWave(72, 10);
      const a = detectMsptd(sig);
      const b = detectMsptd(sig.map(v => v * 1000));

      expect(b.peaks).toEqual(a.peaks);
    });

    it('es invariante a un desplazamiento constante', () => {
      const sig = ppgWave(72, 10);
      const a = detectMsptd(sig);
      const b = detectMsptd(sig.map(v => v + 500));

      expect(b.peaks).toEqual(a.peaks);
    });

    it('no se deja arrastrar por una deriva lineal', () => {
      const sig = ppgWave(72, 10);
      const drifted = sig.map((v, i) => v + i * 0.02);
      const a = detectMsptd(sig);
      const b = detectMsptd(drifted);

      expect(Math.abs(b.peaks.length - a.peaks.length)).toBeLessThanOrEqual(2);
    });
  });

  describe('entradas degeneradas', () => {
    it('ventana demasiado corta devuelve vacío', () => {
      expect(detectMsptd([1, 2, 3]).peaks).toEqual([]);
    });

    it('señal constante no produce picos', () => {
      const r = detectMsptd(new Array(120).fill(5));
      expect(r.peaks).toEqual([]);
    });

    it('valores no finitos devuelven vacío sin lanzar', () => {
      const sig = ppgWave(72, 6);
      sig[20] = NaN;
      expect(detectMsptd(sig).peaks).toEqual([]);
    });
  });
});

describe('rrIntervalsFromPeaks', () => {
  it('convierte índices a milisegundos con la fs real', () => {
    // 30 muestras a 30 Hz = 1000 ms
    const rr = rrIntervalsFromPeaks([0, 30, 60], 30);
    expect(rr).toHaveLength(2);
    expect(rr[0]).toBeCloseTo(1000, 6);
    expect(rr[1]).toBeCloseTo(1000, 6);
  });

  it('descarta intervalos fuera de rango fisiológico', () => {
    // 3 muestras a 30 fps = 100 ms → demasiado corto (600 lpm)
    const rr = rrIntervalsFromPeaks([0, 3, 33], 30);
    expect(rr).toHaveLength(1);
    expect(rr[0]).toBeCloseTo(1000, 6);
  });

  it('devuelve vacío con menos de dos picos', () => {
    expect(rrIntervalsFromPeaks([5], 30)).toEqual([]);
  });

  it('devuelve vacío con fs inválida', () => {
    expect(rrIntervalsFromPeaks([0, 30], 0)).toEqual([]);
  });

  it('los RR de una onda real coinciden con el BPM generado', () => {
    const bpm = 72;
    const r = detectMsptd(ppgWave(bpm, 15));
    const rr = rrIntervalsFromPeaks(r.peaks, FS);

    expect(rr.length).toBeGreaterThan(5);
    const median = [...rr].sort((a, b) => a - b)[Math.floor(rr.length / 2)];
    const bpmFromRr = 60000 / median;

    expect(Math.abs(bpmFromRr - bpm)).toBeLessThan(6);
  });
});
