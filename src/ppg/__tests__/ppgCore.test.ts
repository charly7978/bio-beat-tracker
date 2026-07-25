import { describe, it, expect } from 'vitest';
import { designBandpass, designLowpass3, filtfilt } from '../butterworth';
import { findPeaksElgendi, movingAverage, ELGENDI_DEFAULTS } from '../elgendi';

const FS = 30;

/** PPG sintético: subida sistólica rápida + muesca dícrota, como el real. */
function ppgWave(phase: number): number {
  const p = phase - Math.floor(phase);
  const systolic = Math.exp(-Math.pow((p - 0.18) / 0.09, 2));
  const dicrotic = 0.3 * Math.exp(-Math.pow((p - 0.45) / 0.11, 2));
  return systolic + dicrotic;
}

function makePpg(seconds: number, bpm: number, fs = FS): number[] {
  const hz = bpm / 60;
  const n = Math.round(seconds * fs);
  return Array.from({ length: n }, (_, i) => ppgWave((i / fs) * hz));
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('butterworth (fase cero, 0.5–8 Hz como exige Elgendi)', () => {
  it('deja pasar la banda cardíaca (1.2 Hz = 72 bpm)', () => {
    const n = 300;
    const x = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 1.2 * (i / FS)));
    const y = filtfilt(x, designBandpass(0.5, 8, FS));
    const ampIn = amplitude(x.slice(60, -60));
    const ampOut = amplitude(y.slice(60, -60));
    expect(ampOut / ampIn).toBeGreaterThan(0.7);
  });

  it('elimina la DERIVA de línea base (0.05 Hz), que es lo que arruina el umbral', () => {
    const n = 600;
    const x = Array.from({ length: n }, (_, i) => 10 * Math.sin(2 * Math.PI * 0.05 * (i / FS)));
    const y = filtfilt(x, designBandpass(0.5, 8, FS));
    expect(amplitude(y.slice(100, -100))).toBeLessThan(amplitude(x) * 0.1);
  });

  it('NO desfasa: el pico de entrada y el de salida coinciden (fase cero)', () => {
    const n = 300;
    const x = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 1.2 * (i / FS)));
    const y = filtfilt(x, designBandpass(0.5, 8, FS));
    const mid = x.slice(120, 180);
    const midY = y.slice(120, 180);
    expect(argmax(midY)).toBe(argmax(mid));
  });

  it('el pasa-bajos atenúa por encima del corte', () => {
    const n = 400;
    const fast = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 12 * (i / FS)));
    const y = filtfilt(fast, designLowpass3(8, FS));
    expect(amplitude(y.slice(80, -80))).toBeLessThan(amplitude(fast) * 0.7);
  });
});

describe('elgendi — movingAverage', () => {
  it('una señal constante conserva su valor', () => {
    const out = movingAverage(new Array(50).fill(5), 11);
    for (const v of out) expect(v).toBeCloseTo(5, 6);
  });

  it('suaviza un impulso repartiéndolo en la ventana', () => {
    const x = new Array(41).fill(0);
    x[20] = 11;
    const out = movingAverage(x, 11);
    expect(out[20]).toBeCloseTo(1, 6);
    expect(out[0]).toBe(0);
  });
});

describe('elgendi — detección de picos sistólicos', () => {
  it('encuentra un latido por ciclo a 72 bpm', () => {
    const raw = makePpg(12, 72);
    const clean = filtfilt(raw, designBandpass(0.5, 8, FS));
    const peaks = findPeaksElgendi(clean, FS);
    // 12 s a 72 bpm ≈ 14,4 latidos; se toleran bordes de ventana.
    expect(peaks.length).toBeGreaterThanOrEqual(12);
    expect(peaks.length).toBeLessThanOrEqual(16);
  });

  it('el RR medido corresponde al BPM sintetizado (50, 72 y 110 bpm)', () => {
    for (const bpm of [50, 72, 110]) {
      const clean = filtfilt(makePpg(16, bpm), designBandpass(0.5, 8, FS));
      const peaks = findPeaksElgendi(clean, FS);
      expect(peaks.length, `bpm=${bpm}`).toBeGreaterThan(4);
      const rr: number[] = [];
      for (let i = 1; i < peaks.length; i++) rr.push(((peaks[i]! - peaks[i - 1]!) / FS) * 1000);
      const measured = 60000 / median(rr);
      expect(Math.abs(measured - bpm), `bpm=${bpm} medido=${measured}`).toBeLessThan(bpm * 0.1);
    }
  });

  it('respeta el refractario: nunca dos picos a menos de minDelay', () => {
    const clean = filtfilt(makePpg(16, 110), designBandpass(0.5, 8, FS));
    const peaks = findPeaksElgendi(clean, FS);
    const minGap = ELGENDI_DEFAULTS.minDelaySec * FS;
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i]! - peaks[i - 1]!).toBeGreaterThanOrEqual(minGap);
    }
  });

  it('tolera ARRITMIA: no asume ritmo regular', () => {
    // Latidos con RR alternante (bigeminismo simulado): 0.7 s y 1.1 s.
    const fs = FS;
    const signal: number[] = [];
    const expected: number[] = [];
    let t = 0;
    let toggle = false;
    while (t < 16) {
      const rr = toggle ? 0.7 : 1.1;
      toggle = !toggle;
      const beatSamples = Math.round(rr * fs);
      for (let i = 0; i < beatSamples; i++) signal.push(ppgWave(i / beatSamples));
      expected.push(Math.round(t * fs));
      t += rr;
    }
    const clean = filtfilt(signal, designBandpass(0.5, 8, fs));
    const peaks = findPeaksElgendi(clean, fs);
    // Debe encontrar aproximadamente un pico por latido pese al RR irregular.
    expect(peaks.length).toBeGreaterThanOrEqual(expected.length - 3);
  });

  it('RUIDO BLANCO no produce un ritmo cardíaco plausible y sostenido', () => {
    const rnd = makeRng(1234);
    const noise = Array.from({ length: 16 * FS }, () => rnd() * 2 - 1);
    const clean = filtfilt(noise, designBandpass(0.5, 8, FS));
    const peaks = findPeaksElgendi(clean, FS);
    const rr: number[] = [];
    for (let i = 1; i < peaks.length; i++) rr.push(((peaks[i]! - peaks[i - 1]!) / FS) * 1000);
    if (rr.length >= 4) {
      // La marca de un ritmo real es un RR CONSISTENTE. Sobre ruido el
      // coeficiente de variación del RR es alto aunque salgan "picos".
      const m = median(rr);
      const cv = Math.sqrt(rr.reduce((a, d) => a + (d - m) ** 2, 0) / rr.length) / m;
      expect(cv).toBeGreaterThan(0.12);
    }
  });

  it('señal PLANA no produce ningún pico', () => {
    const flat = new Array(16 * FS).fill(0);
    expect(findPeaksElgendi(flat, FS)).toEqual([]);
  });
});

function amplitude(x: number[]): number {
  return Math.max(...x) - Math.min(...x);
}

function argmax(x: number[]): number {
  let bi = 0;
  for (let i = 1; i < x.length; i++) if (x[i]! > x[bi]!) bi = i;
  return bi;
}

function median(x: number[]): number {
  const s = [...x].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
