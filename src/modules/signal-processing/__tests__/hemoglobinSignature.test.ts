import { describe, it, expect } from 'vitest';
import { evaluateHemoglobinSignature } from '../hemoglobinSignature';

/**
 * Generador determinista de ruido (LCG). Sin Math.random para que los tests
 * sean reproducibles: un fallo tiene que poder reproducirse exactamente.
 */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000; // [0,1)
  };
}

/** Ruido gaussiano aproximado por suma de uniformes (Irwin–Hall centrado). */
function gauss(rng: () => number): number {
  return rng() + rng() + rng() + rng() + rng() + rng() - 3;
}

const FS = 30;
const N = 150; // 5 s

/**
 * ESCENARIO PARED: variación puramente de intensidad.
 * Parpadeo del LED, deriva de exposición y ruido del sensor escalan los tres
 * canales en la MISMA proporción relativa. Es lo que ocurre apuntando a una
 * pared, una mesa o el aire.
 */
function wallScene(opts: { dcR: number; dcG: number; dcB: number; flicker: number; noise: number; seed: number }) {
  const rng = makeRng(opts.seed);
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / FS;
    // Un único factor multiplicativo común a los tres canales.
    const gain = 1 + opts.flicker * Math.sin(2 * Math.PI * 1.2 * t);
    red.push(opts.dcR * gain + opts.noise * gauss(rng));
    green.push(opts.dcG * gain + opts.noise * gauss(rng));
    blue.push(opts.dcB * gain + opts.noise * gauss(rng));
  }
  return { red, green, blue };
}

/**
 * ESCENARIO TEJIDO PERFUNDIDO: variación cromática.
 * La hemoglobina absorbe con fuerza cerca de 500–600 nm, así que la
 * pulsatilidad RELATIVA del verde es bastante mayor que la del rojo, y el azul
 * queda en el medio-bajo. Esa desigualdad entre canales es la firma.
 */
function perfusedScene(opts: {
  dcR: number; dcG: number; dcB: number;
  acR: number; acG: number; acB: number;
  bpm: number; noise: number; seed: number;
}) {
  const rng = makeRng(opts.seed);
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const f = opts.bpm / 60;
  for (let i = 0; i < N; i++) {
    const t = i / FS;
    // Onda con subida sistólica marcada (fundamental + armónico).
    const pulse = Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t);
    red.push(opts.dcR * (1 + opts.acR * pulse) + opts.noise * gauss(rng));
    green.push(opts.dcG * (1 + opts.acG * pulse) + opts.noise * gauss(rng));
    blue.push(opts.dcB * (1 + opts.acB * pulse) + opts.noise * gauss(rng));
  }
  return { red, green, blue };
}

describe('evaluateHemoglobinSignature', () => {
  describe('LA PRUEBA DE LA PARED — el criterio que define si esto sirve', () => {
    it('rechaza parpadeo de intensidad sobre una superficie clara', () => {
      const { red, green, blue } = wallScene({
        dcR: 180, dcG: 175, dcB: 170, flicker: 0.02, noise: 0.3, seed: 1,
      });
      const r = evaluateHemoglobinSignature(red, green, blue, FS);

      expect(r.reason).toBe('OK');
      expect(r.chromaticAngleDeg).toBeLessThan(10);
      expect(r.logLikelihoodRatio).toBeLessThan(0);
    });

    it('rechaza una pared rosada — el color del objeto no lo salva', () => {
      // Una pared color piel tiene el MISMO DC que un dedo. Lo que la delata no
      // es el color, es que su variación es acromática.
      const { red, green, blue } = wallScene({
        dcR: 200, dcG: 120, dcB: 110, flicker: 0.03, noise: 0.4, seed: 2,
      });
      const r = evaluateHemoglobinSignature(red, green, blue, FS);

      expect(r.reason).toBe('OK');
      expect(r.logLikelihoodRatio).toBeLessThan(0);
    });

    it('rechaza deriva lenta de exposición (control automático de la cámara)', () => {
      const red: number[] = [];
      const green: number[] = [];
      const blue: number[] = [];
      for (let i = 0; i < N; i++) {
        const gain = 1 + 0.05 * (i / N); // rampa multiplicativa común
        red.push(190 * gain);
        green.push(150 * gain);
        blue.push(140 * gain);
      }
      const r = evaluateHemoglobinSignature(red, green, blue, FS);

      expect(r.chromaticAngleDeg).toBeLessThan(5);
      expect(r.logLikelihoodRatio).toBeLessThan(0);
    });

    it('rechaza pared con ruido de sensor ALTO — el caso que rompía la v1', () => {
      // Regresión. El ruido del sensor es ADITIVO: con canales de DC distinto
      // (200/120/110) un mismo ruido absoluto da pulsatilidad RELATIVA distinta
      // por canal (σ/μ difiere porque μ difiere), lo que imita cromaticidad.
      // La primera versión daba aquí LLR = +2.94: una pared pasando por dedo.
      const { red, green, blue } = wallScene({
        dcR: 200, dcG: 120, dcB: 110, flicker: 0.01, noise: 3.0, seed: 4,
      });
      const r = evaluateHemoglobinSignature(red, green, blue, FS);

      expect(r.logLikelihoodRatio).toBeLessThanOrEqual(0);
    });

    it('rechaza ruido de sensor con DC muy desbalanceado', () => {
      // Peor caso del mismo fenómeno: rojo saturado de luz, azul casi a oscuras.
      const { red, green, blue } = wallScene({
        dcR: 240, dcG: 60, dcB: 25, flicker: 0.005, noise: 2.5, seed: 11,
      });
      const r = evaluateHemoglobinSignature(red, green, blue, FS);

      expect(r.logLikelihoodRatio).toBeLessThanOrEqual(0);
    });

    it('rechaza un escenario sin variación alguna (superficie estática)', () => {
      const flat = new Array(N).fill(200);
      const r = evaluateHemoglobinSignature(flat, [...flat], [...flat], FS);

      expect(r.reason).toBe('BELOW_NOISE_FLOOR');
      expect(r.logLikelihoodRatio).toBe(0); // sin información, no un veredicto
    });
  });

  describe('tejido perfundido', () => {
    it('acepta variación cromática con pulsatilidad dominante en verde', () => {
      const { red, green, blue } = perfusedScene({
        dcR: 200, dcG: 90, dcB: 70,
        acR: 0.01, acG: 0.05, acB: 0.02,
        bpm: 72, noise: 0.2, seed: 3,
      });
      const r = evaluateHemoglobinSignature(red, green, blue, FS);

      expect(r.reason).toBe('OK');
      expect(r.chromaticAngleDeg).toBeGreaterThan(15);
      expect(r.logLikelihoodRatio).toBeGreaterThan(0);
    });

    it('separa tejido de pared por un margen amplio', () => {
      const tissue = evaluateHemoglobinSignature(
        ...(() => {
          const s = perfusedScene({
            dcR: 200, dcG: 90, dcB: 70,
            acR: 0.01, acG: 0.05, acB: 0.02,
            bpm: 68, noise: 0.2, seed: 4,
          });
          return [s.red, s.green, s.blue, FS] as const;
        })(),
      );
      const wall = evaluateHemoglobinSignature(
        ...(() => {
          const s = wallScene({ dcR: 200, dcG: 90, dcB: 70, flicker: 0.03, noise: 0.2, seed: 4 });
          return [s.red, s.green, s.blue, FS] as const;
        })(),
      );

      // Mismo DC, mismo ruido, misma semilla: lo ÚNICO que cambia es si la
      // variación es cromática o acromática.
      expect(tissue.logLikelihoodRatio).toBeGreaterThan(0);
      expect(wall.logLikelihoodRatio).toBeLessThan(0);
      expect(tissue.logLikelihoodRatio - wall.logLikelihoodRatio).toBeGreaterThan(5);
    });

    it('sigue aceptando perfusión débil si es genuinamente cromática', () => {
      const { red, green, blue } = perfusedScene({
        dcR: 190, dcG: 100, dcB: 80,
        acR: 0.002, acG: 0.012, acB: 0.004,
        bpm: 60, noise: 0.05, seed: 5,
      });
      const r = evaluateHemoglobinSignature(red, green, blue, FS);

      expect(r.reason).toBe('OK');
      expect(r.logLikelihoodRatio).toBeGreaterThan(0);
    });
  });

  describe('se niega a opinar cuando la entrada no lo permite', () => {
    it('invalida si un canal está recortado', () => {
      const { red, green, blue } = perfusedScene({
        dcR: 254, dcG: 90, dcB: 70,
        acR: 0.01, acG: 0.05, acB: 0.02,
        bpm: 72, noise: 0.1, seed: 6,
      });
      const r = evaluateHemoglobinSignature(red, green, blue, FS);

      expect(r.reason).toBe('CHANNEL_CLIPPED');
      expect(r.logLikelihoodRatio).toBe(0);
    });

    it('invalida con ventana demasiado corta', () => {
      const r = evaluateHemoglobinSignature([1, 2, 3], [1, 2, 3], [1, 2, 3], FS);
      expect(r.reason).toBe('INSUFFICIENT_SAMPLES');
      expect(r.logLikelihoodRatio).toBe(0);
    });

    it('invalida con longitudes de canal distintas', () => {
      const a = new Array(N).fill(100);
      const r = evaluateHemoglobinSignature(a, a.slice(0, N - 1), a, FS);
      expect(r.reason).toBe('INSUFFICIENT_SAMPLES');
    });

    it('invalida con valores no finitos', () => {
      const a = new Array(N).fill(100);
      const bad = [...a];
      bad[10] = NaN;
      const r = evaluateHemoglobinSignature(bad, a, a, FS);
      expect(r.reason).toBe('INVALID_INPUT');
      expect(r.logLikelihoodRatio).toBe(0);
    });

    it('invalida si un canal tiene media cero o negativa', () => {
      const a = new Array(N).fill(100);
      const zero = new Array(N).fill(0);
      const r = evaluateHemoglobinSignature(a, zero, a, FS);
      expect(r.reason).toBe('INVALID_INPUT');
    });
  });

  describe('propiedades del estimador', () => {
    it('la incertidumbre angular se estrecha al alargar la ventana', () => {
      const short = evaluateHemoglobinSignature(
        ...(() => {
          const s = perfusedScene({
            dcR: 200, dcG: 90, dcB: 70, acR: 0.01, acG: 0.05, acB: 0.02,
            bpm: 72, noise: 0.2, seed: 7,
          });
          return [s.red.slice(0, 40), s.green.slice(0, 40), s.blue.slice(0, 40), FS] as const;
        })(),
      );
      const long = evaluateHemoglobinSignature(
        ...(() => {
          const s = perfusedScene({
            dcR: 200, dcG: 90, dcB: 70, acR: 0.01, acG: 0.05, acB: 0.02,
            bpm: 72, noise: 0.2, seed: 7,
          });
          return [s.red, s.green, s.blue, FS] as const;
        })(),
      );

      expect(long.angularUncertaintyDeg).toBeLessThan(short.angularUncertaintyDeg);
    });

    it('la dirección es unitaria y no negativa', () => {
      const { red, green, blue } = perfusedScene({
        dcR: 200, dcG: 90, dcB: 70, acR: 0.01, acG: 0.05, acB: 0.02,
        bpm: 72, noise: 0.2, seed: 8,
      });
      const r = evaluateHemoglobinSignature(red, green, blue, FS);
      const d = r.direction!;

      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 6);
      expect(Math.min(d[0], d[1], d[2])).toBeGreaterThanOrEqual(0);
    });

    it('el ángulo nunca supera el máximo geométrico (54.74°)', () => {
      // Caso extremo: toda la pulsatilidad en un solo canal.
      const rng = makeRng(9);
      const red: number[] = [];
      const green: number[] = [];
      const blue: number[] = [];
      for (let i = 0; i < N; i++) {
        red.push(150 + 20 * Math.sin(i / 4));
        green.push(100 + 0.01 * gauss(rng));
        blue.push(80 + 0.01 * gauss(rng));
      }
      const r = evaluateHemoglobinSignature(red, green, blue, FS);

      expect(r.chromaticAngleDeg).toBeLessThanOrEqual(54.7356 + 1e-6);
    });

    it('es invariante a la escala global (ganancia de la cámara)', () => {
      const s = perfusedScene({
        dcR: 200, dcG: 90, dcB: 70, acR: 0.01, acG: 0.05, acB: 0.02,
        bpm: 72, noise: 0, seed: 10,
      });
      const base = evaluateHemoglobinSignature(s.red, s.green, s.blue, FS);
      const scaled = evaluateHemoglobinSignature(
        s.red.map(v => v * 0.5),
        s.green.map(v => v * 0.5),
        s.blue.map(v => v * 0.5),
        FS,
      );

      expect(scaled.chromaticAngleDeg).toBeCloseTo(base.chromaticAngleDeg, 9);
    });
  });
});
