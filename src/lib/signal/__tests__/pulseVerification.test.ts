import { describe, it, expect } from 'vitest';
import {
  createPulseVerifier,
  pushPulseSample,
  verifyPulse,
  resetPulseVerifier,
  harmonicConcentration,
  beatTemplateCorrelation,
} from '../pulseVerification';
import { skewness } from '@/utils/stats';
import { bandLimitedDominantFreq } from '@/modules/signal-processing/shared/dsp';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

/**
 * El verificador CONSUME la evidencia espectral que el procesador calcula por
 * ventana. En test la derivamos de las mismas muestras acumuladas, igual que
 * hace el pipeline real — sin recalcular dentro del módulo bajo prueba.
 */
function evidenceFor(st: ReturnType<typeof createPulseVerifier>, perfusionIndex: number) {
  const dom = bandLimitedDominantFreq(st.samples, FS, P.MIN_HZ, P.MAX_HZ);
  return {
    perfusionIndex,
    dominantHz: dom.freqHz,
    harmonicConcentration: harmonicConcentration(st.samples, FS, dom.freqHz),
    skewness: skewness(st.samples),
  };
}

const FS = 30;
const P = VITAL_THRESHOLDS.PULSE_VERIFICATION;

/**
 * PPG sintético fisiológicamente plausible: subida sistólica rápida, bajada
 * diastólica lenta y muesca dícrota → skewness positiva y armónicos reales.
 */
function ppgWave(phase: number): number {
  const p = phase % 1;
  const systolic = Math.exp(-Math.pow((p - 0.18) / 0.10, 2));
  const dicrotic = 0.32 * Math.exp(-Math.pow((p - 0.42) / 0.11, 2));
  return systolic + dicrotic;
}

/** Alimenta el verificador con una señal generada, marcando picos reales. */
function feedSignal(
  state: ReturnType<typeof createPulseVerifier>,
  seconds: number,
  sample: (tSec: number) => { value: number; isPeak: boolean },
) {
  const n = Math.round(seconds * FS);
  for (let i = 0; i < n; i++) {
    const tSec = i / FS;
    const s = sample(tSec);
    pushPulseSample(state, s.value, tSec * 1000, s.isPeak);
  }
}

function feedPpg(state: ReturnType<typeof createPulseVerifier>, seconds: number, bpm: number) {
  const hz = bpm / 60;
  let lastBeat = -1;
  feedSignal(state, seconds, (tSec) => {
    const phase = tSec * hz;
    const beatIndex = Math.floor(phase);
    // El pico sistólico cae en fase ≈0.18 del ciclo.
    const peakT = (beatIndex + 0.18) / hz;
    const isPeak = beatIndex > lastBeat && tSec >= peakT;
    if (isPeak) lastBeat = beatIndex;
    return { value: ppgWave(phase), isPeak };
  });
}

// PRNG determinista: los tests no pueden depender de Math.random.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('pulseVerification — el pulso REAL es el criterio, no el color', () => {
  describe('rechazo de escenas sin dedo (el fallo denunciado)', () => {
    it('RUIDO BLANCO con perfusión alta NO confirma pulso', () => {
      const st = createPulseVerifier();
      const rnd = makeRng(12345);
      // Picos falsos a intervalos aleatorios, como los produciría un detector
      // sobre ruido: hay "latidos", pero sin forma de onda repetible.
      let next = 0.3;
      feedSignal(st, 12, (tSec) => {
        const isPeak = tSec >= next;
        if (isPeak) next = tSec + 0.4 + rnd() * 0.6;
        return { value: rnd() * 2 - 1, isPeak };
      });
      const v = verifyPulse(st, evidenceFor(st, 0.02)); // PI alto a propósito
      expect(v.confirmed).toBe(false);
    });

    it('SEÑAL PLANA (pared/techo, sin pulsatilidad) NO confirma pulso', () => {
      const st = createPulseVerifier();
      const rnd = makeRng(999);
      feedSignal(st, 12, () => ({ value: rnd() * 0.001, isPeak: false }));
      const v = verifyPulse(st, evidenceFor(st, 0.00002));
      expect(v.confirmed).toBe(false);
      expect(v.reason).toBe('NO_PERFUSION');
    });

    it('PERFUSIÓN a nivel de RUIDO se rechaza aunque la onda sea perfecta', () => {
      const st = createPulseVerifier();
      feedPpg(st, 12, 72);
      // 0,0036 % — exactamente el piso efectivo que tenía la app antes.
      const v = verifyPulse(st, evidenceFor(st, 0.000036));
      expect(v.confirmed).toBe(false);
      expect(v.reason).toBe('NO_PERFUSION');
    });

    it('OSCILACIÓN NO CARDÍACA (parpadeo lento de exposición) NO confirma', () => {
      const st = createPulseVerifier();
      let next = 0;
      feedSignal(st, 14, (tSec) => {
        const isPeak = tSec >= next;
        if (isPeak) next = tSec + 4; // 15 bpm: fuera de banda cardíaca
        return { value: Math.sin(2 * Math.PI * 0.25 * tSec), isPeak };
      });
      const v = verifyPulse(st, evidenceFor(st, 0.01));
      expect(v.confirmed).toBe(false);
    });
  });

  describe('aceptación de pulso fisiológico real', () => {
    it('PPG sintético con morfología real SÍ confirma pulso', () => {
      const st = createPulseVerifier();
      feedPpg(st, 14, 72);
      let v = verifyPulse(st, evidenceFor(st, 0.008));
      // La histéresis exige evidencia sostenida: varias evaluaciones.
      for (let i = 0; i < P.THROTTLE_FRAMES * P.CONFIRM_EVALUATIONS + 2; i++) {
        v = verifyPulse(st, evidenceFor(st, 0.008));
      }
      expect(v.confirmed).toBe(true);
      expect(v.reason).toBe('PULSE_VERIFIED');
      expect(v.evidence.dominantBpm).toBeGreaterThan(60);
      expect(v.evidence.dominantBpm).toBeLessThan(85);
    });

    it('confirma a distintas frecuencias fisiológicas (50 y 110 bpm)', () => {
      for (const bpm of [50, 110]) {
        const st = createPulseVerifier();
        feedPpg(st, 14, bpm);
        let v = verifyPulse(st, evidenceFor(st, 0.008));
        for (let i = 0; i < P.THROTTLE_FRAMES * P.CONFIRM_EVALUATIONS + 2; i++) {
          v = verifyPulse(st, evidenceFor(st, 0.008));
        }
        expect(v.confirmed, `bpm=${bpm}`).toBe(true);
        expect(Math.abs(v.evidence.dominantBpm - bpm)).toBeLessThan(bpm * 0.15);
      }
    });
  });

  describe('primitivas', () => {
    it('la concentración armónica separa onda cardíaca de ruido', () => {
      const n = 180;
      const clean: number[] = [];
      const noise: number[] = [];
      const rnd = makeRng(7);
      for (let i = 0; i < n; i++) {
        clean.push(ppgWave((i / FS) * 1.2));
        noise.push(rnd() * 2 - 1);
      }
      const hcClean = harmonicConcentration(clean, FS, 1.2);
      const hcNoise = harmonicConcentration(noise, FS, 1.2);
      expect(hcClean).toBeGreaterThan(hcNoise);
      expect(hcClean).toBeGreaterThan(P.MIN_HARMONIC_CONCENTRATION);
    });

    it('la plantilla de latido correlaciona alto con latidos iguales', () => {
      const beat = Array.from({ length: 32 }, (_, i) => ppgWave(i / 32));
      expect(beatTemplateCorrelation([beat, beat, beat, beat])).toBeGreaterThan(0.99);
    });

    it('la plantilla NO correlaciona con latidos de forma aleatoria', () => {
      const rnd = makeRng(4242);
      const beats = Array.from({ length: 6 }, () =>
        Array.from({ length: 32 }, () => rnd() * 2 - 1),
      );
      expect(beatTemplateCorrelation(beats)).toBeLessThan(P.MIN_TEMPLATE_CORRELATION);
    });
  });

  it('reset deja el verificador limpio', () => {
    const st = createPulseVerifier();
    feedPpg(st, 10, 72);
    verifyPulse(st, evidenceFor(st, 0.008));
    resetPulseVerifier(st);
    expect(st.samples.length).toBe(0);
    expect(st.confirmed).toBe(false);
  });
});
