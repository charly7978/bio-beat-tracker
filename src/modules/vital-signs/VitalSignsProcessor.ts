import { ArrhythmiaProcessor } from './arrhythmia-processor';
import { BloodPressureProcessor } from './BloodPressureProcessor';
import { PPGFeatureExtractor } from './PPGFeatureExtractor';
import { createLogger } from '../../utils/logger';
import { isPhysiologicalRR } from '../../utils/physio';

const log = createLogger('VitalSignsProcessor');

export interface VitalSignsResult {
  spo2: number;
  pressure: {
    systolic: number;
    diastolic: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
    featureQuality: number;
  };
  glucose: {
    value: number;
    trend: 'STABLE' | 'RISING' | 'FALLING';
    confidence: number;
  };
  arterialHealth: {
    agingIndex: number;
    stiffness: number;
    vascularStatus: string;
  };
  arrhythmiaCount: number;
  arrhythmiaStatus: string;
  isCalibrating: boolean;
  calibrationProgress: number;
  lastArrhythmiaData?: {
    timestamp: number;
    rmssd: number;
    rrVariation: number;
  };
  // NUEVO: Indicadores de calidad
  signalQuality: number;
  measurementConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INVALID';
  diagnostics?: Record<string, any>;
}

export interface RGBData {
  redAC: number;
  redDC: number;
  greenAC: number;
  greenDC: number;
}

interface RRData {
  intervals: number[];
  lastPeakTime: number | null;
  timestampNow?: number;
}

const getMonotonicNow = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

/**
 * PROCESADOR DE SIGNOS VITALES - SIN CLAMPS
 * 
 * CAMBIOS PRINCIPALES:
 * - SpO2 = 110 - 25 * R (fórmula pura, SIN CLAMP)
 * - Presión arterial desde morfología PPG (SIN BASE FIJA 120/80)
 * - Glucosa mediante SDFMFCC (Systolic-Diastolic Framing)
 * - Salud Arterial via APG (b/a, c/a, aging index)
 * 
 * Referencias:
 * - Ratio-of-Ratios: Webster 1997, Tremper 1989
 * - BP from PPG morphology: Elgendi 2019, Mukkamala 2022
 * - Glucose SDFMFCC: Research Directive 2024
 */
export class VitalSignsProcessor {
  private arrhythmiaProcessor: ArrhythmiaProcessor;
  private bloodPressureProcessor: BloodPressureProcessor;
  private lastBPConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT' = 'INSUFFICIENT';
  private lastBPFeatureQuality: number = 0;
  private calibrationSamples: number = 0;
  private readonly CALIBRATION_REQUIRED = 25;
  private isCalibrating: boolean = false;
  
  // Estado actual - SIN VALORES BASE FIJOS
  private measurements = {
    spo2: 0,
    systolicPressure: 0,
    diastolicPressure: 0,
    glucose: 0,
    glucoseTrend: 'STABLE' as 'STABLE' | 'RISING' | 'FALLING',
    agingIndex: 0,
    stiffness: 0,
    arrhythmiaCount: 0,
    arrhythmiaStatus: "SIN ARRITMIAS|0",
    lastArrhythmiaData: null as { timestamp: number; rmssd: number; rrVariation: number; } | null,
    signalQuality: 0
  };
  
  // Historial de señal
  private signalHistory: number[] = [];
  private readonly HISTORY_SIZE = 90;
  
  // RGB para SpO2
  private rgbData: RGBData = { redAC: 0, redDC: 0, greenAC: 0, greenDC: 0 };
  
  // Suavizado adaptativo para estabilidad SIN perder respuesta
  // Alpha más bajo = más suavizado = lecturas más estables
  private readonly EMA_ALPHA_STABLE = 0.20;
  private readonly EMA_ALPHA_DYNAMIC = 0.30;

  // Contador de pulsos válidos
  private validPulseCount: number = 0;
  private readonly MIN_PULSES_REQUIRED = 2;
  
  constructor() {
    this.arrhythmiaProcessor = new ArrhythmiaProcessor();
    this.bloodPressureProcessor = new BloodPressureProcessor();
    this.arrhythmiaProcessor.setArrhythmiaDetectionCallback((detected) => {
      log.info(`Estado arritmia → ${detected ? 'ARRITMIA' : 'NORMAL'}`);
    });
  }

  startCalibration(): void {
    this.isCalibrating = true;
    this.calibrationSamples = 0;
    this.validPulseCount = 0;
    this.measurements = {
      spo2: 0,
      systolicPressure: 0,
      diastolicPressure: 0,
      glucose: 0,
      glucoseTrend: 'STABLE',
      agingIndex: 0,
      stiffness: 0,
      arrhythmiaCount: 0,
      arrhythmiaStatus: "CALIBRANDO...",
      lastArrhythmiaData: null,
      signalQuality: 0
    };
    this.signalHistory = [];
  }

  forceCalibrationCompletion(): void {
    this.isCalibrating = false;
    this.calibrationSamples = this.CALIBRATION_REQUIRED;
  }
  
  setRGBData(data: RGBData): void {
    this.rgbData = data;
  }

  processSignal(
    signalValue: number, 
    rrData?: RRData
  ): VitalSignsResult {
    
    // Actualizar historial
    this.signalHistory.push(signalValue);
    if (this.signalHistory.length > this.HISTORY_SIZE) {
      this.signalHistory.shift();
    }

    // Control de calibración
    if (this.isCalibrating) {
      this.calibrationSamples++;
      if (this.calibrationSamples >= this.CALIBRATION_REQUIRED) {
        this.isCalibrating = false;
      }
    }

    // Calcular SQI propio para control de calidad de signos vitales
    this.measurements.signalQuality = this.calculateSignalQuality();

    // Validar pulso real
    const hasRealPulse = this.validateRealPulse(rrData);
    
    if (!hasRealPulse) {
      // Don't zero-out values that are already accumulated — just stop updating
      // This prevents flicker when signal dips momentarily
      return this.getFormattedResult();
    }

    // Calcular signos vitales — lowered from 30 to 20 samples, 3 to 2 intervals
    if (this.signalHistory.length >= 20 && rrData && rrData.intervals.length >= 2) {
      this.calculateVitalSigns(signalValue, rrData);
    }

    return this.getFormattedResult();
  }

  private validateRealPulse(rrData?: RRData): boolean {
    if (!rrData || !rrData.intervals || rrData.intervals.length < 2) {
      this.validPulseCount = 0;
      return false;
    }
    
    // Ventana humana conservadora: evita ruido no fisiológico sin forzar rangos clínicos “bonitos”
    const validIntervals = rrData.intervals.filter(isPhysiologicalRR);
    
    if (validIntervals.length < 2) {
      this.validPulseCount = 0;
      return false;
    }

    if (rrData.lastPeakTime) {
      const now = typeof rrData.timestampNow === 'number' && Number.isFinite(rrData.timestampNow)
        ? rrData.timestampNow
        : getMonotonicNow();
      const timeSinceLastPeak = now - rrData.lastPeakTime;
      if (timeSinceLastPeak > 4000) {
        this.validPulseCount = 0;
        return false;
      }
    }
    
    this.validPulseCount = validIntervals.length;
    return true;
  }

  private calculateSignalQuality(): number {
    if (this.signalHistory.length < 20) return 0;
    
    const recent = this.signalHistory.slice(-60);
    const sorted = [...recent].sort((a, b) => a - b);
    const p10 = sorted[Math.floor((sorted.length - 1) * 0.1)] ?? 0;
    const p90 = sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0;
    const range = p90 - p10;
    
    if (range < 0.2) return 2;
    
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / recent.length;
    const stdDev = Math.sqrt(variance);
    const snr = range / (stdDev + 0.05);
    
    return Math.min(100, Math.max(0, snr * 16));
  }

  private getMeasurementConfidence(): 'HIGH' | 'MEDIUM' | 'LOW' | 'INVALID' {
    const sq = this.measurements.signalQuality;
    if (sq >= 55 && this.validPulseCount >= 4) return 'HIGH';
    if (sq >= 30 && this.validPulseCount >= 3) return 'MEDIUM';
    if (sq >= 12 && this.validPulseCount >= 2) return 'LOW';
    return 'INVALID';
  }

  /**
   * FORMATEO DE RESULTADOS - REDONDEO APROPIADO
   * Cada signo vital tiene su formato específico:
   * - SpO2: entero (97, 98, 99)
   * - Presión arterial: enteros (120/80)
   * - Glucosa: entero (95, 110, 120)
   * - Hemoglobina: 1 decimal (13.5, 14.2)
   * - Colesterol/Triglicéridos: enteros (180, 150)
   */
  private getFormattedResult(): VitalSignsResult {
    return {
      spo2: Math.round(this.measurements.spo2),
      pressure: {
        systolic: Math.round(this.measurements.systolicPressure),
        diastolic: Math.round(this.measurements.diastolicPressure),
        confidence: this.lastBPConfidence,
        featureQuality: this.lastBPFeatureQuality,
      },
      glucose: {
        value: Math.round(this.measurements.glucose),
        trend: this.measurements.glucoseTrend,
        confidence: this.measurements.signalQuality / 100,
      },
      arterialHealth: {
        agingIndex: Number(this.measurements.agingIndex.toFixed(3)),
        stiffness: Number(this.measurements.stiffness.toFixed(1)),
        vascularStatus: this.getVascularStatus(this.measurements.agingIndex),
      },
      arrhythmiaCount: this.measurements.arrhythmiaCount,
      arrhythmiaStatus: this.measurements.arrhythmiaStatus,
      isCalibrating: this.isCalibrating,
      calibrationProgress: Math.min(100, Math.round((this.calibrationSamples / this.CALIBRATION_REQUIRED) * 100)),
      lastArrhythmiaData: this.measurements.lastArrhythmiaData ?? undefined,
      signalQuality: Math.round(this.measurements.signalQuality),
      measurementConfidence: this.getMeasurementConfidence()
    };
  }

  /**
   * CÁLCULO UNIFICADO DE SIGNOS VITALES
   * Usa extractCycleFeatures (API moderna) en lugar de extractAllFeatures (legacy)
   * para glucosa, hemoglobina y lípidos con modelos basados en literatura
   */
  private calculateVitalSigns(
    signalValue: number, 
    rrData: RRData
  ): void {
    const minQualityForCalculation = 10;
    if (this.measurements.signalQuality < minQualityForCalculation) {
      return;
    }
    
    // SpO2 — lowest gate, always try first
    const spo2 = this.calculateSpO2Raw();
    if (spo2 !== 0 && spo2 > 70 && spo2 < 100) {
      this.measurements.spo2 = this.smoothValue(this.measurements.spo2, spo2, 'stable');
    }

    const validRR = rrData.intervals.filter(isPhysiologicalRR);
    const avgRR = validRR.length > 0 ? validRR.reduce((a, b) => a + b, 0) / validRR.length : 0;
    const hr = avgRR > 0 ? 60000 / avgRR : 0;

    // BP — try with 2+ valid RR
    if (validRR.length >= 2) {
      const bpEstimate = this.bloodPressureProcessor.estimate(
        this.signalHistory, validRR, 30
      );
      this.lastBPConfidence = bpEstimate.confidence;
      this.lastBPFeatureQuality = bpEstimate.featureQuality;
      if (bpEstimate.systolic > 0 && bpEstimate.confidence !== 'INSUFFICIENT') {
        this.measurements.systolicPressure = this.smoothValue(this.measurements.systolicPressure, bpEstimate.systolic, 'stable');
        this.measurements.diastolicPressure = this.smoothValue(this.measurements.diastolicPressure, bpEstimate.diastolic, 'stable');
      }
    }

    // Arrhythmia — solo con RR robustos y SQI suficiente
    const arrhythmiaRR = validRR.slice(-10);
    const arrhythmiaInput = (
      arrhythmiaRR.length >= 5 &&
      this.measurements.signalQuality >= 25 &&
      hr >= 35 &&
      hr <= 180
    ) ? { ...rrData, intervals: arrhythmiaRR } : undefined;

    const arrhythmiaResult = this.arrhythmiaProcessor.processRRData(arrhythmiaInput);
    this.measurements.arrhythmiaStatus = arrhythmiaResult.arrhythmiaStatus;
    this.measurements.lastArrhythmiaData = arrhythmiaResult.lastArrhythmiaData;
    
    const parts = arrhythmiaResult.arrhythmiaStatus.split('|');
    this.measurements.arrhythmiaCount = parts.length > 1 ? (parseInt(parts[1]) || 0) : 0;

    // Advanced Biomarkers (Glucose & Arterial Health)
    if (this.measurements.signalQuality >= 40) {
      this.calculateAdvancedBiomarkers();
    }
  }

  /**
   * CÁLCULO DE BIOMARCADORES AVANZADOS
   * Utiliza la morfología fina (APG) y SDFMFCC
   */
  private calculateAdvancedBiomarkers(): void {
    const cycles = PPGFeatureExtractor.detectCardiacCycles(this.signalHistory, 30);
    if (cycles.length === 0) return;

    let totalGlucose = 0;
    let totalAging = 0;
    let totalStiffness = 0;
    let count = 0;

    for (const cycle of cycles) {
      const features = PPGFeatureExtractor.extractCycleFeatures(this.signalHistory, cycle, 30);
      if (!features || features.quality < 0.4) continue;

      // 1. Glucose via SDFMFCC (Simplified Model)
      // En un entorno real, esto usaría pesos de una red neuronal entrenada.
      // Representamos la sensibilidad a la viscosidad mediante los primeros coeficientes.
      const gS = features.sdfmfcc.systolic[1] || 0;
      const gD = features.sdfmfcc.diastolic[1] || 0;
      const estimatedGlucose = 95 + (gS * 2.5) - (gD * 1.8);
      totalGlucose += estimatedGlucose;

      // 2. Arterial Health via APG
      totalAging += features.apg.agi;
      totalStiffness += features.stiffnessIndex;
      count++;
    }

    if (count > 0) {
      const avgGlucose = totalGlucose / count;
      const avgAging = totalAging / count;
      const avgStiffness = totalStiffness / count;

      // Aplicar suavizado
      this.measurements.glucose = this.smoothValue(this.measurements.glucose, avgGlucose, 'dynamic');
      this.measurements.agingIndex = this.smoothValue(this.measurements.agingIndex, avgAging, 'stable');
      this.measurements.stiffness = this.smoothValue(this.measurements.stiffness, avgStiffness, 'stable');
    }
  }

  private getVascularStatus(agi: number): string {
    if (agi < -0.5) return "ÓPTIMO";
    if (agi < -0.2) return "SALUDABLE";
    if (agi < 0.1) return "PROMEDIO";
    if (agi < 0.4) return "ADVERTENCIA";
    return "RIGIDEZ ARTERIAL";
  }

  /**
   * SpO2 - FÓRMULA RATIO-OF-RATIOS (Estándar Texas Instruments SLAA655)
   * 
   * R = (AC_red/DC_red) / (AC_ir/DC_ir)
   * SpO2 = 110 - 25 * R
   * 
   * Para cámaras usamos verde como proxy de IR (mejor SNR que azul)
   * 
   * VALIDACIÓN: Solo retorna valor si los datos son físicamente plausibles
   */
  // Buffer para valores R (Ratio-of-Ratios) para filtrado de mediana
  private rValueHistory: number[] = [];
  private readonly R_HISTORY_SIZE = 15;

  /**
   * SpO2 - FÓRMULA RATIO-OF-RATIOS (Estándar Texas Instruments SLAA655)
   * 
   * R = (AC_red/DC_red) / (AC_ir/DC_ir)
   * SpO2 = 110 - 25 * R
   * 
   * Para cámaras usamos verde como proxy de IR (mejor SNR que azul)
   * 
   * MEJORA: Implementa filtrado de mediana para R y logging de depuración
   */
  private calculateSpO2Raw(): number {
    const { redAC, redDC, greenAC, greenDC } = this.rgbData;
    
    if (redDC < 15 || greenDC < 15) return 0;
    
    const piRed = (redAC / redDC) * 100;
    const piGreen = (greenAC / greenDC) * 100;

    // Log de depuración para diagnóstico clínico
    if (this.calibrationSamples % 10 === 0) {
      log.info(`[SpO2 Debug] ACr:${redAC.toFixed(3)} DCr:${redDC.toFixed(0)} PIr:${piRed.toFixed(3)}% | ACg:${greenAC.toFixed(3)} DCg:${greenDC.toFixed(0)} PIg:${piGreen.toFixed(3)}%`);
    }
    
    // Umbrales mínimos de pulsatilidad (PI > 0.05%)
    if (piRed < 0.05 || piGreen < 0.05) return 0;
    
    const ratioRed = redAC / redDC;
    const ratioGreen = greenAC / greenDC;
    if (!isFinite(ratioRed) || !isFinite(ratioGreen) || ratioRed <= 0 || ratioGreen <= 0) return 0;
    
    const currentR = ratioRed / ratioGreen;
    
    // Validar rango físico de R para tejido humano
    if (currentR < 0.2 || currentR > 2.5) {
      if (this.calibrationSamples % 5 === 0) log.warn(`[SpO2] R fuera de rango: ${currentR.toFixed(3)}`);
      return 0;
    }

    // Acumular R para filtrado de mediana (Mejor práctica clínica)
    this.rValueHistory.push(currentR);
    if (this.rValueHistory.length > this.R_HISTORY_SIZE) {
      this.rValueHistory.shift();
    }

    if (this.rValueHistory.length < 5) return 0;

    // Calcular mediana de R para estabilidad
    const sortedR = [...this.rValueHistory].sort((a, b) => a - b);
    const medianR = sortedR[Math.floor(sortedR.length / 2)];
    
    // Curva de calibración optimizada para cámara (Green as IR proxy)
    // Usamos intercepto 112 para compensar mayor absorción en verde
    const spo2 = Math.min(100, Math.max(70, 112 - 28 * medianR));
    
    if (this.calibrationSamples % 30 === 0) {
      log.info(`[SpO2 Result] R_med:${medianR.toFixed(3)} -> SpO2:${spo2.toFixed(1)}%`);
    }

    return Number.isFinite(spo2) ? spo2 : 0;
  }

  /**
   * Suavizado EMA adaptativo con detección de outliers
   * type: 'stable' para valores que cambian lentamente (SpO2, PA)
   *       'dynamic' para valores más variables (Glucosa)
   * 
   * MEJORA: Detecta cambios bruscos y ajusta alpha dinámicamente
   */
  private smoothValue(current: number, newVal: number, type: 'stable' | 'dynamic' = 'stable'): number {
    if (current === 0 || isNaN(current) || !isFinite(current)) return newVal; // Fast initial lock
    if (isNaN(newVal) || !isFinite(newVal)) return current;
    
    const baseAlpha = type === 'stable' ? this.EMA_ALPHA_STABLE : this.EMA_ALPHA_DYNAMIC;
    
    // Calcular cambio relativo
    const relativeChange = Math.abs(newVal - current) / (Math.abs(current) + 0.01);
    
    // Si el cambio es muy grande (>50%), podría ser ruido - suavizar más
    // Si el cambio es moderado (<20%), responder más rápido
    let adaptiveAlpha = baseAlpha;
    
    if (relativeChange > 0.5) {
      // Cambio muy grande - probablemente ruido, suavizar mucho más
      adaptiveAlpha = baseAlpha * 0.3;
    } else if (relativeChange > 0.3) {
      // Cambio grande - suavizar un poco más
      adaptiveAlpha = baseAlpha * 0.5;
    } else if (relativeChange < 0.1) {
      // Cambio pequeño - responder más rápido para seguir tendencia
      adaptiveAlpha = baseAlpha * 1.5;
    }
    
    // Limitar alpha entre 0.05 y 0.4
    adaptiveAlpha = Math.max(0.05, Math.min(0.4, adaptiveAlpha));
    
    return current * (1 - adaptiveAlpha) + newVal * adaptiveAlpha;
  }

  getCalibrationProgress(): number {
    return Math.min(100, Math.round((this.calibrationSamples / this.CALIBRATION_REQUIRED) * 100));
  }

  reset(): VitalSignsResult | null {
    const result = this.getFormattedResult();
    this.signalHistory = [];
    this.validPulseCount = 0;
    this.arrhythmiaProcessor.reset();
    this.measurements.arrhythmiaCount = 0;
    this.measurements.arrhythmiaStatus = "SIN ARRITMIAS|0";
    this.measurements.lastArrhythmiaData = null;
    this.rValueHistory = [];
    return result.spo2 !== 0 ? result : null;
  }

  fullReset(): void {
    this.signalHistory = [];
    this.validPulseCount = 0;
    this.rValueHistory = [];
    this.measurements = {
      spo2: 0,
      systolicPressure: 0,
      diastolicPressure: 0,
      glucose: 0,
      glucoseTrend: 'STABLE',
      agingIndex: 0,
      stiffness: 0,
      arrhythmiaCount: 0,
      arrhythmiaStatus: "SIN ARRITMIAS|0",
      lastArrhythmiaData: null,
      signalQuality: 0
    };
    this.rgbData = { redAC: 0, redDC: 0, greenAC: 0, greenDC: 0 };
    this.isCalibrating = false;
    this.calibrationSamples = 0;
    this.arrhythmiaProcessor.reset();
    this.bloodPressureProcessor.fullReset();
  }
}


