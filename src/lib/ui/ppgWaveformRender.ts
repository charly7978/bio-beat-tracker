/**
 * Geometría de trazado PPG para monitor clínico: spline Catmull–Rom uniforme
 * que **pasa por los nudos reales** (solo interpola entre muestras conocidas;
 * no inventa frecuencias ni sustituye el pipeline DSP).
 *
 * Referencia: Catmull & Rom (1974), spline C1 continuo entre puntos discretos.
 */

export interface WaveformPoint2D {
  x: number;
  y: number;
}

function catmull1D(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** Muestras por tramo; se escala con longitud en pantalla para curvas suaves en X amplio. */
function segmentSteps(p1: WaveformPoint2D, p2: WaveformPoint2D, baseSteps: number): number {
  const dx = Math.abs(p2.x - p1.x);
  const dy = Math.abs(p2.y - p1.y);
  const dist = Math.hypot(dx, dy);
  return Math.min(48, Math.max(baseSteps, Math.round(dist / 5)));
}

/**
 * Densifica una polilínea con Catmull–Rom entre nudos consecutivos.
 * Los extremos usan duplicado del borde (tangente natural).
 */
export function densifyCatmullRom2D(
  knots: readonly WaveformPoint2D[],
  baseStepsPerSegment = 6,
): WaveformPoint2D[] {
  const n = knots.length;
  if (n < 2) return knots.slice();
  const get = (i: number) => knots[Math.max(0, Math.min(n - 1, i))];
  const out: WaveformPoint2D[] = [];

  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const steps = segmentSteps(p1, p2, baseStepsPerSegment);
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      if (i > 0 && s === 0) continue;
      out.push({
        x: catmull1D(p0.x, p1.x, p2.x, p3.x, t),
        y: catmull1D(p0.y, p1.y, p2.y, p3.y, t),
      });
    }
  }
  out.push({ x: knots[n - 1].x, y: knots[n - 1].y });
  return out;
}

/** Derivada aproximada en nudos (segunda columna = eje temporal de índice). */
export function knotDerivativesY(knots: readonly WaveformPoint2D[]): number[] {
  const n = knots.length;
  const d: number[] = new Array(n);
  if (n === 0) return d;
  if (n === 1) {
    d[0] = 0;
    return d;
  }
  d[0] = knots[1].y - knots[0].y;
  for (let i = 1; i < n - 1; i++) {
    d[i] = (knots[i + 1].y - knots[i - 1].y) * 0.5;
  }
  d[n - 1] = knots[n - 1].y - knots[n - 2].y;
  return d;
}

/**
 * Grosor de trazo 0.9–1.55 px según pendiente (subida sistólica PPG = |dy| grande en coords pantalla).
 */
export function strokeWidthFromScreenDy(dy: number): number {
  const m = Math.min(24, Math.abs(dy));
  return 0.9 + (m / 24) * 0.65;
}
