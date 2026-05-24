/**
 * MotionArbiter — árbitro multi-sensor para desambiguar señal PPG.
 *
 * Cuando el procesador PPG encuentra una señal ambigua (dos latidos muy
 * cercanos → ¿arritmia o ruido?, caída de SpO₂ → ¿real o movimiento?),
 * consulta a sensores auxiliares para determinar si hubo movimiento.
 *
 * Sensores:
 *   - Cámara frontal: diferencia entre frames (movimiento del entorno)
 *   - Compás/magnetómetro: cambio brusco de orientación
 *   - Acelerómetro: (futuro) aceleración lineal
 */

export interface MotionVerdict {
  /** true = hubo movimiento = la ambigüedad es artefacto */
  motionDetected: boolean;
  /** Qué sensor detectó el movimiento */
  source: 'front_camera' | 'compass' | 'accelerometer' | 'none';
  /** Score de confianza del veredicto (0-1) */
  confidence: number;
}

export interface FrontCameraMotionReport {
  /** Diferencia media entre frames consecutivos (0-255) */
  meanDiff: number;
  /** Proporción de píxeles que cambiaron (0-1) */
  changeRatio: number;
}

export interface CompassMotionReport {
  /** Ángulo de orientación actual en grados (0-360) */
  heading: number;
  /** Cambio desde la última lectura en grados */
  deltaDegrees: number;
  /** Timestamp de la lectura */
  timestamp: number;
}

export interface AccelerometerMotionReport {
  /** Aceleración en eje X (m/s²) */
  x: number;
  /** Aceleración en eje Y (m/s²) */
  y: number;
  /** Aceleración en eje Z (m/s²) */
  z: number;
  /** Magnitud total = sqrt(x² + y² + z²) */
  magnitude: number;
}

/** Umbrales configurables para el árbitro */
export const ARBITER_THRESHOLDS = {
  /** Diferencia media de píxeles entre frames frontales para considerar movimiento */
  FRONT_CAM_DIFF_THRESHOLD: 8,
  /** Proporción de píxeles cambiados para considerar movimiento */
  FRONT_CAM_CHANGE_RATIO_THRESHOLD: 0.05,
  /** Cambio de orientación en grados para considerar movimiento */
  COMPASS_DELTA_THRESHOLD: 5,
  /** Intervalo de tiempo (ms) para considerar el cambio como "repentino" */
  COMPASS_WINDOW_MS: 200,
  /** Magnitud de aceleración para considerar movimiento (gravedad = 9.8) */
  ACCEL_MAGNITUDE_THRESHOLD: 12,
};

/**
 * Evalúa el reporte de cámara frontal y decide si hubo movimiento.
 */
export function evaluateFrontCamera(report: FrontCameraMotionReport | null): MotionVerdict {
  if (!report) return { motionDetected: false, source: 'none', confidence: 0 };

  const { meanDiff, changeRatio } = report;
  const diffTrigger = meanDiff >= ARBITER_THRESHOLDS.FRONT_CAM_DIFF_THRESHOLD;
  const ratioTrigger = changeRatio >= ARBITER_THRESHOLDS.FRONT_CAM_CHANGE_RATIO_THRESHOLD;

  if (diffTrigger || ratioTrigger) {
    let confidence = 0;
    if (diffTrigger && ratioTrigger) confidence = 0.9;
    else if (diffTrigger) confidence = 0.6;
    else confidence = 0.5;

    return { motionDetected: true, source: 'front_camera', confidence };
  }

  return { motionDetected: false, source: 'none', confidence: 0 };
}

/**
 * Evalúa el reporte del compás y decide si hubo movimiento rotacional.
 */
export function evaluateCompass(report: CompassMotionReport | null, lastReport: CompassMotionReport | null): MotionVerdict {
  if (!report || !lastReport) return { motionDetected: false, source: 'none', confidence: 0 };

  const timeDelta = report.timestamp - lastReport.timestamp;
  if (timeDelta > ARBITER_THRESHOLDS.COMPASS_WINDOW_MS) return { motionDetected: false, source: 'none', confidence: 0 };

  const absDelta = Math.abs(report.deltaDegrees);
  if (absDelta >= ARBITER_THRESHOLDS.COMPASS_DELTA_THRESHOLD) {
    const confidence = Math.min(1, absDelta / (ARBITER_THRESHOLDS.COMPASS_DELTA_THRESHOLD * 3));
    return { motionDetected: true, source: 'compass', confidence };
  }

  return { motionDetected: false, source: 'none', confidence: 0 };
}

/**
 * Evalúa el reporte del acelerómetro y decide si hubo movimiento.
 */
export function evaluateAccelerometer(report: AccelerometerMotionReport | null): MotionVerdict {
  if (!report) return { motionDetected: false, source: 'none', confidence: 0 };

  if (report.magnitude >= ARBITER_THRESHOLDS.ACCEL_MAGNITUDE_THRESHOLD) {
    const confidence = Math.min(1, (report.magnitude - 9.8) / 5);
    return { motionDetected: true, source: 'accelerometer', confidence };
  }

  return { motionDetected: false, source: 'none', confidence: 0 };
}

/**
 * Árbitro completo: fusión de todos los sensores.
 * Si CUALQUIER sensor detecta movimiento, se considera artefacto.
 * Retorna el veredicto con la confianza más alta.
 */
export function arbitrate(
  frontCamReport: FrontCameraMotionReport | null,
  compassReport: CompassMotionReport | null,
  lastCompassReport: CompassMotionReport | null,
  accelReport: AccelerometerMotionReport | null,
): MotionVerdict {
  const verdicts: MotionVerdict[] = [
    evaluateFrontCamera(frontCamReport),
    evaluateCompass(compassReport, lastCompassReport),
    evaluateAccelerometer(accelReport),
  ].filter(v => v.motionDetected);

  if (verdicts.length === 0) {
    return { motionDetected: false, source: 'none', confidence: 0 };
  }

  // Fusión: si múltiples sensores detectan movimiento, la confianza sube
  const best = verdicts.reduce((a, b) => a.confidence > b.confidence ? a : b);
  if (verdicts.length >= 2) {
    best.confidence = Math.min(1, best.confidence + 0.15 * (verdicts.length - 1));
  }

  return best;
}
