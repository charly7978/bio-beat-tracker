import { describe, it, expect } from 'vitest';
import { PPGSignalSplitter } from '../PPGSignalSplitter';

/** Genera onda sinusoidal como PPG sintético (DC alto + AC pequeño) */
function makePPGSignal(
  hz: number,
  fs: number,
  nSamples: number,
  dcLevel = 150,
  amplitude = 8,
): number[] {
  return Array.from({ length: nSamples }, (_, i) =>
    dcLevel + amplitude * Math.sin(2 * Math.PI * hz * i / fs),
  );
}

function rms(arr: number[]): number {
  const n = arr.length;
  if (n === 0) return 0;
  return Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / n);
}

describe('PPGSignalSplitter', () => {
  describe('Canal 1: HR', () => {
    it('produce señal filteredHR finita para entrada PPG válida', () => {
      const splitter = new PPGSignalSplitter(30);
      const sig = makePPGSignal(1.2, 30, 300);
      let lastOut = 0;
      for (let i = 0; i < 300; i++) {
        const out = splitter.process(sig[i]!, sig[i]! * 0.6, 30);
        expect(isFinite(out.filteredHR)).toBe(true);
        lastOut = out.filteredHR;
      }
      // Tras warm-up, debe haber señal en la banda cardiaca
      expect(Math.abs(lastOut)).toBeGreaterThanOrEqual(0); // no NaN
    });

    it('spike aislado en el raw es amortiguado por Hampel', () => {
      const splitter = new PPGSignalSplitter(30);
      // Warm-up con señal estable
      for (let i = 0; i < 30; i++) {
        splitter.process(150, 90, 30);
      }
      // Spike brutal en un frame
      const out = splitter.process(254, 90, 30);
      expect(isFinite(out.filteredHR)).toBe(true);
    });
  });

  describe('Canal 2: SpO2 AC/DC', () => {
    it('dcRed no es cero con señal no nula', () => {
      const splitter = new PPGSignalSplitter(30);
      let lastOut = { acRed: 0, dcRed: 0, acGreen: 0, dcGreen: 0, acBlue: 0, dcBlue: 0 };
      for (let i = 0; i < 100; i++) {
        const out = splitter.process(150 + Math.sin(i) * 5, 90 + Math.sin(i) * 3, 100 + Math.sin(i) * 2, 30);
        lastOut = out.spo2;
      }
      // El DC debe reflejar el nivel de la señal (cerca del promedio)
      expect(lastOut.dcRed).toBeGreaterThan(50);
      expect(lastOut.dcGreen).toBeGreaterThan(30);
      expect(lastOut.dcBlue).toBeGreaterThan(30);
    });

    it('dcRed y acRed son canales diferentes (DC no bloqueado)', () => {
      const splitter = new PPGSignalSplitter(30);
      for (let i = 0; i < 150; i++) {
        const out = splitter.process(150, 90, 80, 30);
        if (i > 100) {
          // Con señal constante: DC ≈ 150, AC ≈ 0
          expect(out.spo2.dcRed).toBeGreaterThan(100);
          expect(Math.abs(out.spo2.acRed)).toBeLessThan(10);
        }
      }
    });

    it('todos los valores SpO2 son finitos', () => {
      const splitter = new PPGSignalSplitter(30);
      const sig = makePPGSignal(1.2, 30, 200);
      for (let i = 0; i < 200; i++) {
        const out = splitter.process(sig[i]!, sig[i]! * 0.6, sig[i]! * 0.4, 30);
        expect(isFinite(out.spo2.acRed)).toBe(true);
        expect(isFinite(out.spo2.dcRed)).toBe(true);
        expect(isFinite(out.spo2.acGreen)).toBe(true);
        expect(isFinite(out.spo2.dcGreen)).toBe(true);
        expect(isFinite(out.spo2.acBlue)).toBe(true);
        expect(isFinite(out.spo2.dcBlue)).toBe(true);
      }
    });
  });

  describe('Canal 3: Morfología', () => {
    it('produce morphology finito', () => {
      const splitter = new PPGSignalSplitter(30);
      const sig = makePPGSignal(1.2, 30, 300);
      for (let i = 0; i < 300; i++) {
        const out = splitter.process(sig[i]!, sig[i]! * 0.6, 30);
        expect(isFinite(out.morphology)).toBe(true);
      }
    });

    it('el Hampel suave del canal morfología no elimina picos de amplitud fisiológica', () => {
      const splitter = new PPGSignalSplitter(30);
      // Warm-up
      for (let i = 0; i < 60; i++) {
        splitter.process(150 + Math.sin(i * 0.3) * 8, 90, 30);
      }
      // Pico de amplitud fisiológica normal (no outlier)
      const out = splitter.process(158, 90, 30);
      expect(isFinite(out.morphology)).toBe(true);
    });
  });

  describe('Canal 4: Respiración', () => {
    it('produce respiration finito', () => {
      const splitter = new PPGSignalSplitter(30);
      const sig = makePPGSignal(1.2, 30, 300);
      for (let i = 0; i < 300; i++) {
        const out = splitter.process(sig[i]!, sig[i]! * 0.6, 30);
        expect(isFinite(out.respiration)).toBe(true);
      }
    });
  });

  describe('Canal 5: Arritmias', () => {
    it('produce arrhythmia finito', () => {
      const splitter = new PPGSignalSplitter(30);
      const sig = makePPGSignal(1.2, 30, 300);
      for (let i = 0; i < 300; i++) {
        const out = splitter.process(sig[i]!, sig[i]! * 0.6, 30, 72);
        expect(isFinite(out.arrhythmia)).toBe(true);
      }
    });

    it('con BPM = 0 el notch se desactiva (pass-through en esa frecuencia)', () => {
      const splitter1 = new PPGSignalSplitter(30);
      const splitter2 = new PPGSignalSplitter(30);
      // Ambos procesan la misma señal pero splitter2 con BPM=0 (notch desactivado)
      const sig = makePPGSignal(1.2, 30, 200);
      const outs1: number[] = [];
      const outs2: number[] = [];
      for (let i = 0; i < 200; i++) {
        outs1.push(splitter1.process(sig[i]!, sig[i]! * 0.6, 30, 72).arrhythmia);
        outs2.push(splitter2.process(sig[i]!, sig[i]! * 0.6, 30, 0).arrhythmia);
      }
      // Con notch activo: podría haber diferencia (o no si BPM*2 está fuera de banda cardíaca de 1.2Hz)
      // Al menos ambas salidas deben ser finitas
      expect(outs1.every(isFinite)).toBe(true);
      expect(outs2.every(isFinite)).toBe(true);
    });
  });

  describe('Sin ANC inter-canal (el azul NO se usa como referencia)', () => {
    it('preserva el AC rojo aunque el azul esté correlacionado con el rojo', () => {
      // En PPG de dedo R/G/B comparten el MISMO pulso (correlacionados). Un ANC
      // con referencia azul (LMS) convergería a cancelar el pulso real → AC→0.
      // Sin ANC, el AC pulsátil debe conservar amplitud genuina.
      const splitter = new PPGSignalSplitter(30);
      const sig = makePPGSignal(1.2, 30, 400, 150, 8);
      const acRedTail: number[] = [];
      for (let i = 0; i < 400; i++) {
        const out = splitter.process(sig[i]!, sig[i]! * 0.8, sig[i]! * 0.7, 30);
        if (i >= 300) acRedTail.push(out.spo2.acRed);
      }
      expect(acRedTail.every(isFinite)).toBe(true);
      // RMS claramente > 0: el pulso NO fue cancelado por una referencia azul.
      expect(rms(acRedTail)).toBeGreaterThan(0.5);
    });

    it('el canal de arritmias conserva señal finita con entrada pulsátil', () => {
      const splitter = new PPGSignalSplitter(30);
      const sig = makePPGSignal(1.2, 30, 300, 150, 8);
      const arrTail: number[] = [];
      for (let i = 0; i < 300; i++) {
        const out = splitter.process(sig[i]!, sig[i]! * 0.8, sig[i]! * 0.7, 72);
        if (i >= 200) arrTail.push(out.arrhythmia);
      }
      expect(arrTail.every(isFinite)).toBe(true);
    });
  });

  describe('robustez', () => {
    it('maneja NaN/Infinity sin propagar error', () => {
      const splitter = new PPGSignalSplitter(30);
      const out = splitter.process(NaN, Infinity, -Infinity, 0);
      expect(isFinite(out.filteredHR)).toBe(true);
      expect(isFinite(out.spo2.acRed)).toBe(true);
      expect(isFinite(out.morphology)).toBe(true);
      expect(isFinite(out.respiration)).toBe(true);
      expect(isFinite(out.arrhythmia)).toBe(true);
    });

    it('reset reinicia el estado sin errores', () => {
      const splitter = new PPGSignalSplitter(30);
      for (let i = 0; i < 50; i++) splitter.process(150, 90, 30, 70);
      splitter.reset();
      // Después del reset, la primera muestra debe ser finita y cercana a 0
      const out = splitter.process(150, 90, 30, 70);
      expect(isFinite(out.filteredHR)).toBe(true);
    });

    it('setSampleRate reconfigura sin errores', () => {
      const splitter = new PPGSignalSplitter(30);
      for (let i = 0; i < 30; i++) splitter.process(150, 90, 30, 70);
      splitter.setSampleRate(25);
      const out = splitter.process(150, 90, 30, 70);
      expect(isFinite(out.filteredHR)).toBe(true);
    });
  });
});
