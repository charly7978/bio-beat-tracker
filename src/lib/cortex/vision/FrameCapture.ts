export class FrameCapture {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private lastRgb: string = '';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 224;
    this.canvas.height = 224;
    this.ctx = this.canvas.getContext('2d');
  }

  capture(videoEl: HTMLVideoElement): ImageData | null {
    if (!this.ctx) return null;
    this.ctx.drawImage(videoEl, 0, 0, 224, 224);
    const data = this.ctx.getImageData(0, 0, 224, 224);
    const pixels = data.data;
    let r = 0, g = 0, b = 0, n = pixels.length / 4;
    for (let i = 0; i < pixels.length; i += 4) {
      r += pixels[i];
      g += pixels[i + 1];
      b += pixels[i + 2];
    }
    this.lastRgb = `${(r/n).toFixed(0)}, ${(g/n).toFixed(0)}, ${(b/n).toFixed(0)}`;
    return data;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getRgbSummary(): string {
    return this.lastRgb;
  }
}

export function getCameraVideoElement(): HTMLVideoElement | null {
  return document.querySelector('video');
}
