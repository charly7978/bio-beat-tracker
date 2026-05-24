import { clamp } from '../../utils/math';

export interface VisualTransform {
  rScale: number;
  gScale: number;
  bScale: number;
  brightness: number;
  gamma: number;
  contrast: number;
  clampMin: number;
  clampMax: number;
}

export const HR_VISUAL: VisualTransform = {
  rScale: 0.7,
  gScale: 1.5,
  bScale: 0.5,
  brightness: 5,
  gamma: 1.0,
  contrast: 1.0,
  clampMin: 10,
  clampMax: 245,
};

export function transformPixel(
  r: number, g: number, b: number,
  t: VisualTransform
): [number, number, number] {
  let red = r * t.rScale + t.brightness;
  let green = g * t.gScale + t.brightness;
  let blue = b * t.bScale + t.brightness;

  if (t.contrast !== 1.0) {
    const mid = 128;
    red = (red - mid) * t.contrast + mid;
    green = (green - mid) * t.contrast + mid;
    blue = (blue - mid) * t.contrast + mid;
  }

  if (t.gamma !== 1.0) {
    red = Math.pow(Math.max(0, red / 255), t.gamma) * 255;
    green = Math.pow(Math.max(0, green / 255), t.gamma) * 255;
    blue = Math.pow(Math.max(0, blue / 255), t.gamma) * 255;
  }

  return [
    clamp(Math.round(red), t.clampMin, t.clampMax),
    clamp(Math.round(green), t.clampMin, t.clampMax),
    clamp(Math.round(blue), t.clampMin, t.clampMax),
  ];
}
