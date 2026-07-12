/**
 * Generadores deterministas de señal para los tests del motor CVSI.
 * (Viven en __tests__, excluidos del guardrail anti-simulación.)
 */

/** Ruido pseudo-aleatorio determinista (LCG) en [-0.5, 0.5]. */
export function makeNoise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/**
 * Forma de onda de un pulso PPG en función de la fase [0,1): subida sistólica
 * rápida + muesca dícrota + decaimiento diastólico (asimétrica, skew positiva).
 */
export function ppgPulse(phase: number): number {
  const systolic = Math.exp(-Math.pow((phase - 0.15) / 0.09, 2));
  const dicrotic = 0.35 * Math.exp(-Math.pow((phase - 0.45) / 0.12, 2));
  return systolic + dicrotic;
}

/** Genera una ventana de PPG realista a `bpm` con ruido controlado. */
export function generatePpg(
  bpm: number,
  fs: number,
  n: number,
  noiseAmp: number,
  seed = 12345,
): number[] {
  const period = (fs * 60) / bpm;
  const noise = makeNoise(seed);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const phase = (i / period) % 1;
    out[i] = ppgPulse(phase) + noiseAmp * noise();
  }
  return out;
}

/** Señal de un objeto inerte: casi constante con ruido óptico diminuto. */
export function generateFlatObject(n: number, seed = 999): number[] {
  const noise = makeNoise(seed);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 + 0.0015 * noise();
  return out;
}

/** Ruido de banda ancha sin estructura periódica. */
export function generateNoise(n: number, seed = 555): number[] {
  const noise = makeNoise(seed);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = noise();
  return out;
}

/** Serie de RR (ms) regular para un `bpm` dado, con jitter opcional. */
export function regularRr(bpm: number, count: number, jitterMs = 0, seed = 7): number[] {
  const base = 60000 / bpm;
  const noise = makeNoise(seed);
  return Array.from({ length: count }, () => base + jitterMs * noise());
}
