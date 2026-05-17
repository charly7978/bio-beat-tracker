export interface WaveformPoint {
  time: number;
  value: number;
  isArr: boolean;
}

export interface WaveformScale {
  center: number;
  halfSpan: number;
}

/** Elimina DC y escala por percentiles para resaltar morfología AC (notch, diástole). */
export function computeWaveformScale(values: number[], headroom: number): WaveformScale {
  const n = values.length;
  if (n === 0) return { center: 0, halfSpan: 1 };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const center = sum / n;
  const ac = new Array<number>(n);
  for (let i = 0; i < n; i++) ac[i] = values[i] - center;
  const sorted = ac.slice().sort((a, b) => a - b);
  const pLo = sorted[Math.max(0, Math.floor(n * 0.02))] ?? 0;
  const pHi = sorted[Math.min(n - 1, Math.ceil(n * 0.98))] ?? 0;
  const halfSpan = Math.max((pHi - pLo) * 0.5, 0.35) * headroom;
  return { center, halfSpan };
}

/**
 * Decimación min–max por bucket: conserva picos sistólicos y valles (morfología PPG).
 */
export function decimateMinMaxPreserve(points: WaveformPoint[], maxBuckets: number): WaveformPoint[] {
  if (points.length <= maxBuckets * 2) return points;
  const t0 = points[0].time;
  const t1 = points[points.length - 1].time;
  const span = Math.max(t1 - t0, 1);
  const out: WaveformPoint[] = [];

  for (let b = 0; b < maxBuckets; b++) {
    const startT = t0 + (b / maxBuckets) * span;
    const endT = b === maxBuckets - 1 ? t1 + 1 : t0 + ((b + 1) / maxBuckets) * span;
    let minPt: WaveformPoint | null = null;
    let maxPt: WaveformPoint | null = null;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.time < startT || p.time >= endT) continue;
      if (!minPt || p.value < minPt.value) minPt = p;
      if (!maxPt || p.value > maxPt.value) maxPt = p;
    }

    if (minPt && maxPt) {
      if (minPt.time <= maxPt.time) {
        out.push(minPt, maxPt);
      } else {
        out.push(maxPt, minPt);
      }
    }
  }

  return out.length >= 2 ? out : points;
}

export interface ScreenPoint {
  x: number;
  y: number;
  isArr: boolean;
}

/** Trazo Catmull-Rom → Bézier cúbico (continuidad C¹, sin segmentos triangulares). */
export function strokeCatmullRom(
  ctx: CanvasRenderingContext2D,
  pts: ScreenPoint[],
  close = false,
): void {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
    return;
  }

  const last = pts.length - 1;
  const end = close ? last : last - 1;
  for (let i = 0; i < end; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[Math.min(last, i + 1)];
    const p3 = pts[Math.min(last, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
  if (close) ctx.closePath();
}
