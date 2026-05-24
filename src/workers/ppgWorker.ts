let offscreen: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === 'init') {
    offscreen = new OffscreenCanvas(msg.width, msg.height);
    ctx = offscreen.getContext('2d', { willReadFrequently: true, alpha: false });
    self.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'frame' && ctx && offscreen) {
    const { buffer, width, height, timestamp, roiX, roiY, roiW, roiH } = msg;

    const clamped = new Uint8ClampedArray(buffer);
    const imageData = new ImageData(clamped, width, height);
    ctx.putImageData(imageData, 0, 0);

    const roi = extractROI(imageData, roiX, roiY, roiW, roiH);

    self.postMessage(
      {
        type: 'result',
        timestamp,
        rawRed: roi.rawRed,
        rawGreen: roi.rawGreen,
        rawBlue: roi.rawBlue,
        coverageRatio: roi.coverageRatio,
        fingerScore: roi.fingerScore,
        fingerTileCount: roi.fingerTileCount,
      },
    );
  }
};

interface RoiResult {
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  coverageRatio: number;
  fingerScore: number;
  fingerTileCount: number;
}

function extractROI(imageData: ImageData, roiX: number, roiY: number, roiW: number, roiH: number): RoiResult {
  const data = imageData.data;
  const w = imageData.width;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  let fingerCount = 0;
  let fingerScoreSum = 0;

  for (let y = roiY; y < roiY + roiH; y += 3) {
    for (let x = roiX; x < roiX + roiW; x += 3) {
      const idx = (y * w + x) * 4;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;

      sumR += r;
      sumG += g;
      sumB += b;
      count++;

      if (r > 60 && r / (g + 1) > 1.1 && r / (b + 1) > 1.3) {
        fingerCount++;
        fingerScoreSum += Math.min(1, (r - g) / (r + g + 1));
      }
    }
  }

  const rawRed = count > 0 ? sumR / count : 0;
  const rawGreen = count > 0 ? sumG / count : 0;
  const rawBlue = count > 0 ? sumB / count : 0;
  const coverageRatio = count > 0 ? fingerCount / count : 0;
  const fingerScore = fingerCount > 0 ? fingerScoreSum / fingerCount : 0;

  return { rawRed, rawGreen, rawBlue, coverageRatio, fingerScore, fingerTileCount: fingerCount };
}
