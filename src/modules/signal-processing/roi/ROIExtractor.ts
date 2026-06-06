/**
 * ROI EXTRACTOR - Responsabilidad: Extracción de región de interés y procesamiento de tiles
 * 
 * Separa la lógica de extracción de ROI del procesador principal.
 * Maneja:
 * - Cálculo de rectángulo ROI
 * - Muestreo de píxeles con stride adaptativo
 * - Procesamiento de tiles (5x5 grid)
 * - Métricas espaciales de tiles
 */

import { clamp } from '@/utils/math';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { RingF32 } from '@/utils/RingBuffer';

export interface ROIMetrics {
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  coverageRatio: number;
  fingerScore: number;
  fingerTileCount: number;
  roiX: number;
  roiY: number;
  roiH: number;
  roiW: number;
  centroidMotion: number;
}

export interface TileMetrics {
  red: number;
  green: number;
  blue: number;
  total: number;
  redDominance: number;
  rednessRatio: number;
  centerBias: number;
  frameScore: number;
  combinedScore: number;
  valid: boolean;
  isFinger: boolean;
}

export interface TileBuffer {
  red: number;
  green: number;
  blue: number;
  count: number;
}

export interface ROIExtractorConfig {
  pixelStride: number;
  trackedCentroid: { x: number; y: number };
  tileGreenBuffers: RingF32[];
  tileConfidence: number[];
}

export class ROIExtractor {
  private readonly TILE_COLUMNS = 5;
  private readonly TILE_ROWS = 5;
  
  // Buffers reutilizables para evitar GC
  private readonly tileBuffer: TileBuffer[];
  private readonly tileMetrics: TileMetrics[];

  constructor() {
    // Inicializar buffers reutilizables
    this.tileBuffer = Array.from(
      { length: this.TILE_COLUMNS * this.TILE_ROWS },
      () => ({ red: 0, green: 0, blue: 0, count: 0 })
    );
    
    this.tileMetrics = Array.from(
      { length: this.TILE_COLUMNS * this.TILE_ROWS },
      () => ({
        red: 0, green: 0, blue: 0,
        total: 0, redDominance: 0, rednessRatio: 0,
        centerBias: 0, frameScore: 0, combinedScore: 0,
        valid: false, isFinger: false,
      })
    );
  }

  /**
   * Calcula el rectángulo ROI basado en el centroide rastreado
   */
  computeRoiRect(
    width: number,
    height: number,
    trackedCentroid: { x: number; y: number }
  ): { startX: number; startY: number; endX: number; endY: number; roiW: number; roiH: number } {
    const roiSize = Math.min(width, height) * VITAL_THRESHOLDS.FINGER.ROI_SIZE_FRACTION;
    const side = Math.floor(roiSize);
    
    const centerX = Math.floor(width * trackedCentroid.x);
    const centerY = Math.floor(height * trackedCentroid.y);
    
    const startX = clamp(centerX - Math.floor(side / 2), 0, width - side);
    const startY = clamp(centerY - Math.floor(side / 2), 0, height - side);
    
    return { startX, startY, endX: startX + side, endY: startY + side, roiW: side, roiH: side };
  }

  /**
   * Extrae ROI de la imagen y procesa tiles
   */
  extractROI(
    imageData: ImageData,
    config: ROIExtractorConfig
  ): { metrics: ROIMetrics; tileMetrics: TileMetrics[]; fingerCount: number; fingerScoreSum: number } {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    const { startX, startY, endX, endY, roiW, roiH } = this.computeRoiRect(
      width,
      height,
      config.trackedCentroid
    );

    // Reset tile buffer
    const tiles = this.tileBuffer;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      t.red = 0; t.green = 0; t.blue = 0; t.count = 0;
    }

    const roiWidth = Math.max(1, endX - startX);
    const roiHeight = Math.max(1, endY - startY);

    // Sample con stride adaptativo
    const stride = config.pixelStride;
    for (let y = startY; y < endY; y += stride) {
      for (let x = startX; x < endX; x += stride) {
        const i = (y * width + x) * 4;
        const tileX = Math.min(
          this.TILE_COLUMNS - 1,
          Math.floor(((x - startX) / roiWidth) * this.TILE_COLUMNS)
        );
        const tileY = Math.min(
          this.TILE_ROWS - 1,
          Math.floor(((y - startY) / roiHeight) * this.TILE_ROWS)
        );
        const tile = tiles[tileY * this.TILE_COLUMNS + tileX];

        tile.red += data[i];
        tile.green += data[i + 1];
        tile.blue += data[i + 2];
        tile.count++;
      }
    }

    // Procesar tiles
    const result = this.processTiles(tiles, roiWidth, roiHeight, config);
    
    // Calcular métricas agregadas
    const metrics: ROIMetrics = {
      rawRed: result.totalRed / result.totalCount,
      rawGreen: result.totalGreen / result.totalCount,
      rawBlue: result.totalBlue / result.totalCount,
      coverageRatio: result.totalCount / ((roiWidth * roiHeight) / (stride * stride)),
      fingerScore: result.fingerScoreSum / Math.max(1, result.fingerCount),
      fingerTileCount: result.fingerCount,
      roiX: startX,
      roiY: startY,
      roiH: roiH,
      roiW: roiW,
      centroidMotion: 0, // Se calcula externamente
    };

    return {
      metrics,
      tileMetrics: this.tileMetrics,
      fingerCount: result.fingerCount,
      fingerScoreSum: result.fingerScoreSum,
    };
  }

  private processTiles(
    tiles: TileBuffer[],
    roiWidth: number,
    roiHeight: number,
    config: ROIExtractorConfig
  ): {
    totalRed: number;
    totalGreen: number;
    totalBlue: number;
    totalCount: number;
    fingerCount: number;
    fingerScoreSum: number;
  } {
    const F = VITAL_THRESHOLDS.FINGER;
    const metrics = this.tileMetrics;
    const N = tiles.length;
    
    let validCount = 0;
    let fingerCount = 0;
    let fingerScoreSum = 0;
    let sumWeight = 0;
    let sumX = 0;
    let sumY = 0;
    let totalRed = 0;
    let totalGreen = 0;
    let totalBlue = 0;
    let totalCount = 0;

    for (let i = 0; i < N; i++) {
      const t = tiles[i];
      const m = metrics[i];
      
      if (t.count === 0) {
        m.valid = false;
        m.isFinger = false;
        continue;
      }

      const red = t.red / t.count;
      const green = t.green / t.count;
      const blue = t.blue / t.count;

      // Señal temporal de verde por celda
      config.tileGreenBuffers[i]!.push(green);

      const total = red + green + blue;
      const redDominance = red - (green + blue) / 2;
      const rednessRatio = red / Math.max(1, green);
      
      const gridX = i % this.TILE_COLUMNS;
      const gridY = (i / this.TILE_COLUMNS) | 0;
      const normX = this.TILE_COLUMNS <= 1 ? 0 : gridX / (this.TILE_COLUMNS - 1);
      const normY = this.TILE_ROWS <= 1 ? 0 : gridY / (this.TILE_ROWS - 1);
      const dx = normX - 0.5;
      const dy = normY - 0.5;
      const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);
      
      const centerBias = clamp(
        1 - distanceFromCenter * F.ROI_CENTER_BIAS_MULT,
        F.ROI_CENTER_BIAS_MIN,
        1
      );

      const brightnessScore = clamp((total - F.TILE_BRIGHTNESS_OFFSET) / 250, 0, 1);
      const redRatioScore = clamp((rednessRatio - 1.01) / 0.88, 0, 1);
      const domOff = F.TILE_DOMINANCE_SCORE_OFFSET;
      const dominanceScore = clamp((redDominance - domOff) / 32, 0, 1);
      const frameScore = redRatioScore * 0.45 + dominanceScore * 0.4 + brightnessScore * 0.15;

      config.tileConfidence[i] = config.tileConfidence[i] * 0.75 + frameScore * centerBias * 0.25;
      const combinedScore = config.tileConfidence[i] * 0.7 + frameScore * 0.3;

      m.red = red;
      m.green = green;
      m.blue = blue;
      m.total = total;
      m.redDominance = redDominance;
      m.rednessRatio = rednessRatio;
      m.centerBias = centerBias;
      m.frameScore = frameScore;
      m.combinedScore = combinedScore;
      m.valid = true;
      m.isFinger =
        red > F.TILE_MIN_RED &&
        total > F.TILE_MIN_TOTAL &&
        redDominance > F.TILE_MIN_DOMINANCE &&
        rednessRatio > F.TILE_MIN_RG &&
        combinedScore > F.TILE_MIN_COMBINED_SCORE;

      validCount++;
      totalRed += red * t.count;
      totalGreen += green * t.count;
      totalBlue += blue * t.count;
      totalCount += t.count;

      if (m.isFinger) {
        fingerCount++;
        fingerScoreSum += combinedScore;
        sumX += gridX * combinedScore;
        sumY += gridY * combinedScore;
        sumWeight += combinedScore;
      }
    }

    return { totalRed, totalGreen, totalBlue, totalCount, fingerCount, fingerScoreSum };
  }

  /**
   * Actualiza el centroide rastreado basado en los tiles de dedo
   */
  updateTrackedCentroid(
    fingerCount: number,
    fingerScoreSum: number,
    sumX: number,
    sumY: number,
    sumWeight: number
  ): { x: number; y: number } {
    if (fingerCount > 0 && sumWeight > 0) {
      const newCentroidX = sumX / sumWeight;
      const newCentroidY = sumY / sumWeight;
      
      // Suavizar el movimiento del centroide
      const alpha = 0.15;
      return {
        x: this.TILE_COLUMNS <= 1 ? 0.5 : (newCentroidX / (this.TILE_COLUMNS - 1)),
        y: this.TILE_ROWS <= 1 ? 0.5 : (newCentroidY / (this.TILE_ROWS - 1)),
      };
    }
    
    return { x: 0.5, y: 0.5 };
  }
}
