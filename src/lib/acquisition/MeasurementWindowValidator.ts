import { median, percentile } from '../../utils/stats';


/**
 * MeasurementWindowValidator
 * ==========================
 * Final clinical gatekeeper. Receives a complete measurement window (20-40s)
 * and performs deep statistical analysis to decide if the data is
 * medically trustworthy.
 */

export interface VitalReadiness {
  hr: boolean;
  spo2: boolean;
  bp: boolean;
  respiration: boolean;
  arrhythmia: boolean;
}

export interface QualitySummary {
  sqiMedian: number;
  piMedian: number;
  fpsMedian: number;
  jitterMedian: number;
  motionP95: number;
  clippingRatio: number;
  validContactRatio: number;
}

export interface ValidationVerdict {
  accepted: boolean;
  vitalReadiness: VitalReadiness;
  rejectionReasons: string[];
  qualitySummary: QualitySummary;
}

export interface ValidationFrame {
  sqi: number;
  pi: number;
  fps: number;
  jitter: number;
  motion: number;
  isClipping: boolean;
  hasContact: boolean;
}

export class MeasurementWindowValidator {
  /**
   * Validates a window of frames against clinical-grade thresholds.
   */
  public static validate(frames: ValidationFrame[]): ValidationVerdict {
    const reasons: string[] = [];
    const n = frames.length;

    if (n < 300) { // Assuming ~10s minimum for ANY decision
      return {
        accepted: false,
        vitalReadiness: { hr: false, spo2: false, bp: false, respiration: false, arrhythmia: false },
        rejectionReasons: ["Sesión demasiado corta (< 10s)"],
        qualitySummary: this.emptySummary()
      };
    }

    const sqis = new Float32Array(n);
    const pis = new Float32Array(n);
    const fpss = new Float32Array(n);
    const jitters = new Float32Array(n);
    const motions = new Float32Array(n);
    let clippingCount = 0;
    let contactCount = 0;

    for (let i = 0; i < n; i++) {
      sqis[i] = frames[i].sqi;
      pis[i] = frames[i].pi;
      fpss[i] = frames[i].fps;
      jitters[i] = frames[i].jitter;
      motions[i] = frames[i].motion;
      if (frames[i].isClipping) clippingCount++;
      if (frames[i].hasContact) contactCount++;
    }

    const sqiMedian = median(sqis);
    const piMedian = median(pis);
    const fpsMedian = median(fpss);
    const jitterMedian = median(jitters);
    const motionP95 = percentile(motions, 95);
    const clippingRatio = clippingCount / n;
    const validContactRatio = contactCount / n;

    // Clinical Logic Gates
    const hrReady = sqiMedian >= 45 && validContactRatio > 0.8;
    const spo2Ready = hrReady && piMedian >= 0.005 && clippingRatio < 0.05;
    const bpReady = spo2Ready && n >= 600; // Requires 20s minimum
    const respReady = hrReady && n >= 900; // Requires 30s minimum
    const arrhythmiaReady = hrReady && n >= 1200; // Requires 40s minimum for reliable RR analysis

    if (sqiMedian < 30) reasons.push("Calidad de señal insuficiente (SQI mediano bajo)");
    if (validContactRatio < 0.75) reasons.push("Contacto de dedo inestable durante la sesión");
    if (fpsMedian < 24) reasons.push("Rendimiento del dispositivo bajo (FPS < 24)");
    if (motionP95 > 0.4) reasons.push("Exceso de movimiento detectado");
    if (clippingRatio > 0.15) reasons.push("Saturación de sensor detectada (clipping)");

    const accepted = reasons.length === 0 && (hrReady || spo2Ready);

    return {
      accepted,
      vitalReadiness: {
        hr: hrReady,
        spo2: spo2Ready,
        bp: bpReady,
        respiration: respReady,
        arrhythmia: arrhythmiaReady
      },
      rejectionReasons: reasons,
      qualitySummary: {
        sqiMedian,
        piMedian,
        fpsMedian,
        jitterMedian,
        motionP95,
        clippingRatio,
        validContactRatio
      }
    };
  }

  private static emptySummary(): QualitySummary {
    return { sqiMedian: 0, piMedian: 0, fpsMedian: 0, jitterMedian: 0, motionP95: 0, clippingRatio: 0, validContactRatio: 0 };
  }
}
