import type { RgbFrame } from './types';

export interface FaceRoiResult {
  avgR: number;
  avgG: number;
  avgB: number;
  roiX: number;
  roiY: number;
  roiW: number;
  roiH: number;
  coverage: number;
  skinPixels: number;
}

export class FaceRoiExtractor {
  private width = 0;
  private height = 0;

  setDimensions(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  extract(imageData: ImageData): FaceRoiResult {
    const w = imageData.width;
    const h = imageData.height;
    const data = imageData.data;

    if (w !== this.width || h !== this.height) {
      this.setDimensions(w, h);
    }

    // Use center third of frame as ROI (most likely to contain face)
    const roiX = Math.floor(w * 0.15);
    const roiY = Math.floor(h * 0.05);
    const roiW = Math.floor(w * 0.7);
    const roiH = Math.floor(h * 0.7);

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let skinCount = 0;
    let totalPixels = 0;

    for (let y = roiY; y < roiY + roiH; y += 2) {
      for (let x = roiX; x < roiX + roiW; x += 2) {
        const idx = (y * w + x) * 4;
        const r = data[idx]!;
        const g = data[idx + 1]!;
        const b = data[idx + 2]!;
        totalPixels++;

        // Skin color heuristic (RGB rules)
        if (this.isSkinColor(r, g, b)) {
          sumR += r;
          sumG += g;
          sumB += b;
          skinCount++;
        }
      }
    }

    const coverage = totalPixels > 0 ? skinCount / totalPixels : 0;
    const avgR = skinCount > 0 ? sumR / skinCount : 0;
    const avgG = skinCount > 0 ? sumG / skinCount : 0;
    const avgB = skinCount > 0 ? sumB / skinCount : 0;

    return { avgR, avgG, avgB, roiX, roiY, roiW, roiH, coverage, skinPixels: skinCount };
  }

  private isSkinColor(r: number, g: number, b: number): boolean {
    if (r <= 20 || g <= 15 || b <= 10) return false;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const diff = max - min;

    if (diff < 10) return false;

    // Normalized RGB skin heuristics
    const normR = r / (r + g + b + 1);
    const normG = g / (r + g + b + 1);
    const normB = b / (r + g + b + 1);

    const rOverG = r / (g + 1);
    const rOverB = r / (b + 1);

    return (
      normR > 0.33 &&
      normR < 0.65 &&
      normG > 0.20 &&
      normG < 0.42 &&
      normB > 0.10 &&
      normB < 0.30 &&
      rOverG > 1.1 &&
      rOverG < 2.5 &&
      rOverB > 1.5
    );
  }

  static frameToRgb(imageData: ImageData): RgbFrame {
    const data = imageData.data;
    const n = data.length / 4;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < n; i++) {
      r += data[i * 4]!;
      g += data[i * 4 + 1]!;
      b += data[i * 4 + 2]!;
    }
    return {
      r: r / n,
      g: g / n,
      b: b / n,
      timestamp: performance.now(),
    };
  }
}
