import { describe, it, expect } from 'vitest';
import {
  createActiveStabilizer,
  stabilizeSample,
  resetActiveStabilizer,
} from '../activeStabilizer';

function run(samples: number[]): number[] {
  const st = createActiveStabilizer();
  return samples.map((x) => stabilizeSample(st, x));
}

describe('activeStabilizer (acondicionamiento activo)', () => {
  it('PRESERVA el pico sistólico real (no lo recorta) — CRÍTICO', () => {
    // Onda tipo pulso repetida; el pico (30) debe sobrevivir sin recorte fuerte.
    const wave: number[] = [];
    for (let k = 0; k < 4; k++) wave.push(0, 6, 14, 24, 30, 22, 12, 4, -2, 0);
    const out = run(wave);
    // Buscar el máximo de la última mitad (ya estabilizado).
    const tail = out.slice(out.length - 20);
    const peak = Math.max(...tail);
    expect(peak).toBeGreaterThan(24); // pico ~30 preservado (no recortado a la base)
  });

  it('SUAVIZA el ruido chico en zona plana', () => {
    // Señal plana con ruido de ±2 → la salida varía MENOS que la entrada.
    const noisy = [10, 12, 9, 11, 8, 12, 9, 11, 10, 12, 8, 11];
    const out = run(noisy);
    const inRange = Math.max(...noisy) - Math.min(...noisy);
    const outTail = out.slice(4);
    const outRange = Math.max(...outTail) - Math.min(...outTail);
    expect(outRange).toBeLessThan(inRange); // menos jitter
  });

  it('QUITA la deriva lenta de línea base', () => {
    // Deriva LENTA realista (0.1/muestra ≈ 3/s) → la salida queda centrada (~0),
    // muy por debajo del nivel crudo que sube de 50 a ~80.
    const ramp = Array.from({ length: 300 }, (_, i) => 50 + i * 0.1);
    const out = run(ramp);
    const rawLast = ramp[ramp.length - 1]!; // ~80
    expect(Math.abs(out[out.length - 1]!)).toBeLessThan(rawLast * 0.25); // deriva removida
  });

  it('reset limpia el estado', () => {
    const st = createActiveStabilizer();
    stabilizeSample(st, 50);
    stabilizeSample(st, 60);
    resetActiveStabilizer(st);
    expect(st.initialized).toBe(false);
    expect(st.baseline).toBe(0);
  });
});
