/**
 * Validador de posicionamiento del dedo en tiempo real.
 *
 * Detecta qué tan perfectamente centrado está el dedo dentro del ROI,
 * y proporciona métricas para guiar al usuario a la posición exacta.
 */

export interface FingerCenteringMetrics {
  /** 0–1: qué tan centrado está el dedo (0=nada, 1=perfectamente centrado) */
  centeringScore: number;
  /** 0–1: confianza de la medición */
  confidence: number;
  /** Sugerencia de corrección si no está centrado */
  correctionHint?: 'move_left' | 'move_right' | 'move_up' | 'move_down' | 'move_closer' | null;
  /** Distancia del dedo al centro (0=centro, >0=fuera de centro) */
  distanceFromCenter: number;
  /** Si el dedo está dentro del rango aceptable para lectura */
  isWithinAcceptableRange: boolean;
}

export interface CoverageSpatialData {
  /** Ratio de cobertura total */
  coverageRatio: number;
  /** Mapa de cobertura por sector (5x5 grid) */
  sectorCoverage?: number[][];
  /** Centro de masa del área cubierta */
  centroidX?: number;
  centroidY?: number;
  /** Varianza de la distribución (qué tan concentrada está) */
  distributionVariance?: number;
}

/**
 * Calcula métricas de centrado basadas en la distribución espacial de cobertura.
 * Si los datos de sector no están disponibles, usa el coverageRatio como fallback.
 */
export function calculateFingerCenteringMetrics(
  data: CoverageSpatialData,
  minCoverageFactor: number = 0.15,
): FingerCenteringMetrics {
  const { coverageRatio = 0 } = data;

  // Sin cobertura: score 0, fuera de rango
  if (coverageRatio < 0.02) {
    return {
      centeringScore: 0,
      confidence: 0.95,
      correctionHint: null,
      distanceFromCenter: Infinity,
      isWithinAcceptableRange: false,
    };
  }

  // Con grid de sectores (5x5): calcula centrado y distribución
  if (data.sectorCoverage && data.sectorCoverage.length === 5) {
    return computeCenteringFromSectors(
      data.sectorCoverage,
      coverageRatio,
      minCoverageFactor,
    );
  }

  // Fallback: sin datos de sector, usar solo coverageRatio
  // Score = qué tan alta sea la cobertura (más cobertura = mejor centrado/presión)
  const baseScore = Math.min(1, coverageRatio / (minCoverageFactor * 1.5));
  const acceptableMinCoverage = minCoverageFactor * 0.8;

  return {
    centeringScore: baseScore,
    confidence: Math.min(0.5, coverageRatio), // Baja confianza sin datos espaciales
    correctionHint: null,
    distanceFromCenter: 1 - baseScore,
    isWithinAcceptableRange: coverageRatio >= acceptableMinCoverage,
  };
}

/**
 * Calcula métricas usando un grid 5x5 de sectores de cobertura.
 */
function computeCenteringFromSectors(
  sectors: number[][],
  totalCoverage: number,
  minCoverageFactor: number,
): FingerCenteringMetrics {
  const centerIdx = 2; // Centro del grid 5x5
  const centerCoverage = sectors[centerIdx][centerIdx] || 0;

  // Score de centrado: qué tanto del dedo está en el centro vs los bordes
  // Compara cobertura central con promedio de sectores
  const sectorValues = sectors.flat();
  const sectorMean = sectorValues.reduce((a, b) => a + b, 0) / sectorValues.length;

  // Si el centro tiene mucha más cobertura que los bordes, está bien centrado
  const centerAdvantage = centerCoverage / Math.max(sectorMean, 0.001);
  const centeringScore = Math.min(1, Math.max(0, (centerAdvantage - 0.8) / 2));

  // Calcula la varianza espacial (cuán concentrada está la cobertura)
  const variance = sectorValues.reduce((sum, val) => {
    return sum + Math.pow(val - sectorMean, 2);
  }, 0) / sectorValues.length;

  // Distancia del centro (calculada desde la varianza y cobertura)
  // Mayor varianza = más disperso = más lejos del centro
  const normalizedVariance = Math.sqrt(variance) / Math.max(sectorMean, 0.001);
  const distanceFromCenter = Math.min(1, normalizedVariance * 0.5);

  // Hint de corrección
  const correctionHint = computeCorrectionHint(sectors);

  // Rango aceptable: 70%+ de cobertura mínima
  const acceptableMinCoverage = minCoverageFactor * 0.7;
  const isWithinAcceptableRange = totalCoverage >= acceptableMinCoverage;

  return {
    centeringScore: Math.min(1, centeringScore * 1.2), // Boost ligeramente para mejor feedback
    confidence: Math.min(0.95, 0.7 + totalCoverage * 0.3),
    correctionHint,
    distanceFromCenter,
    isWithinAcceptableRange,
  };
}

/**
 * Genera un hint de corrección basado en dónde está concentrada la cobertura
 */
function computeCorrectionHint(sectors: number[][]): FingerCenteringMetrics['correctionHint'] {
  // Suma de cobertura por dirección
  const topSum = sectors[0].reduce((a, b) => a + b, 0) +
                 sectors[1].reduce((a, b) => a + b, 0);
  const bottomSum = sectors[3].reduce((a, b) => a + b, 0) +
                    sectors[4].reduce((a, b) => a + b, 0);
  const leftSum = sectors[0][0] + sectors[1][0] + sectors[2][0] + sectors[3][0] + sectors[4][0];
  const rightSum = sectors[0][4] + sectors[1][4] + sectors[2][4] + sectors[3][4] + sectors[4][4];

  // Detecta desequilibrio vertical
  if (topSum > bottomSum * 1.3) return 'move_down';
  if (bottomSum > topSum * 1.3) return 'move_up';

  // Detecta desequilibrio horizontal
  if (leftSum > rightSum * 1.3) return 'move_right';
  if (rightSum > leftSum * 1.3) return 'move_left';

  return null;
}

/**
 * Determina el nivel de guía basado en métricas de centrado.
 * Más restrictivo que el método anterior de solo contactState.
 */
export function computeFingerGuideLevelFromCentering(
  contactState: string | undefined,
  centeringMetrics: FingerCenteringMetrics,
  acquisitionStage?: string,
  quality?: number,
): 'none' | 'searching' | 'adjusting' | 'perfect' | 'ready' {
  // Sin contacto
  if (contactState !== 'STABLE_CONTACT') {
    return contactState === 'UNSTABLE_CONTACT' ? 'adjusting' : 'searching';
  }

  // Contacto estable pero no bien centrado
  if (centeringMetrics.centeringScore < 0.75) {
    return 'adjusting';
  }

  // Contacto estable Y bien centrado
  if (acquisitionStage === 'READY' && (quality ?? 0) >= 55) {
    return 'ready';
  }

  // Contacto estable y centrado, pero no completamente ready
  return 'perfect';
}
