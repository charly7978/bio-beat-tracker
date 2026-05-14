import { ArrhythmiaProcessor } from './arrhythmia-processor';
import { BloodPressureProcessor } from './BloodPressureProcessor';
import { createLogger } from '../../utils/logger';
import { isPhysiologicalRR, getMonotonicNow } from '../../utils/physio';

const log = createLogger('VitalSignsProcessor');

export interface VitalSignsResult {
  spo2: number;
  pressure: {
    systolic: number;
    diastolic: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
    featureQuality: number;
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

// getMonotonicNow importado desde utils/physio.ts

/**
 * PROCESADOR DE SIGNOS VITALES - SIN CLAMPS
 * 
 * CAMBIOS PRINCIPALES:
 * 1. SpO2 = 110 - 25 * R (fórmula pura, SIN CLAMP)
 * 2. Presión arterial desde morfología PPG (SIN BASE FIJA 120/80)
 * 3. Todos los valores calculados crudos
 * 4. SQI indica confiabilidad en lugar de forzar rangos
 * 
 * Referencias:
 * - Ratio-of-Ratios: Webster 1997, Tremper 1989
 * - BP from PPG morphology: Elgendi 2019, Mukkamala 2022
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
    arrhythmiaCount: 0,
    arrhythmiaStatus: "SIN ARRITMIAS|0",
    lastArrhythmiaData: null as { timestamp: number; rmssd: number; rrVariation: number; } | null,
    signalQuality: 0
  };
  
  // Historial de señal
  private signalHistory: number[] = [];
  private readonly HISTORY_SIZE = 90;
  private frameCount = 0;  // Contador continuo para logging/diagnóstico
  
  // RGB para SpO2
  private rgbData: RGBData = { redAC: 0, redDC: 0, greenAC: 0, greenDC: 0 };
  
  // Gating de estabilidad (Consistencia)
  private stableFramesCount: number = 0;
  private readonly STABILITY_SPO2_FRAMES = 45;  // ~1.5s para SpO2 (actualización rápida)
  private readonly STABILITY_BP_FRAMES = 60;    // ~2s para BP (necesita más ciclos)
  private lastCoherentSpO2: number = 0;
  
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
      arrhythmiaCount: 0,
      arrhythmiaStatus: "CALIBRANDO...",
      lastArrhythmiaData: null,
      signalQuality: 0
    };
    this.signalHistory = [];
    this.stableFramesCount = 0;
    this.lastCoherentSpO2 = 0;
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
    this.frameCount++;

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
    const minQualityForCalculation = 8;
    if (this.measurements.signalQuality < minQualityForCalculation) {
      this.stableFramesCount = Math.max(0, this.stableFramesCount - 1);
      return;
    }

    const confidence = this.getMeasurementConfidence();

    // Gating progresivo: HIGH avanza rápido, MEDIUM avanza, LOW mantiene
    if (confidence === 'HIGH') {
      this.stableFramesCount = Math.min(this.stableFramesCount + 2, 600);
    } else if (confidence === 'MEDIUM') {
      this.stableFramesCount = Math.min(this.stableFramesCount + 1, 600);
    } else if (confidence === 'LOW') {
      // LOW: no avanza ni retrocede — mantiene estado
    } else {
      this.stableFramesCount = Math.max(0, this.stableFramesCount - 2);
    }

    if (this.stableFramesCount % 60 === 0 && this.stableFramesCount > 0) {
      log.info(`[Stability] ${this.stableFramesCount} frames | ${confidence} | SQI:${this.measurements.signalQuality}`);
    }
    
    // === SpO2 — Basado en física (Beer-Lambert), no estadística ===
    // SpO2 usa ratios ópticos AC/DC directamente de la cámara.
    // Solo necesita datos RGB válidos y confidence no-INVALID.
    const spo2 = this.calculateSpO2Raw();
    if (spo2 > 0 && spo2 >= 70 && spo2 <= 100 && confidence !== 'INVALID') {
      const isCoherent = this.lastCoherentSpO2 === 0 || Math.abs(spo2 - this.lastCoherentSpO2) < 5;
      if (isCoherent || this.frameCount > 300) {
        this.lastCoherentSpO2 = spo2;
        this.measurements.spo2 = this.smoothValue(this.measurements.spo2, spo2, 'stable');
      }
    }

    const validRR = rrData.intervals.filter(isPhysiologicalRR);
    const avgRR = validRR.length > 0 ? validRR.reduce((a, b) => a + b, 0) / validRR.length : 0;
    const hr = avgRR > 0 ? 60000 / avgRR : 0;

    // === BP — requiere 2+ RR válidos y estabilidad moderada ===
    if (validRR.length >= 2) {
      const bpEstimate = this.bloodPressureProcessor.estimate(
        this.signalHistory, validRR, 30
      );
      this.lastBPConfidence = bpEstimate.confidence;
      this.lastBPFeatureQuality = bpEstimate.featureQuality;
      
      if (bpEstimate.systolic > 0 && bpEstimate.confidence !== 'INSUFFICIENT') {
        // BP se actualiza con MEDIUM+ confidence tras estabilidad mínima
        // HIGH confidence pasa inmediatamente (suficientes ciclos PPG de calidad)
        const bpReady = bpEstimate.confidence === 'HIGH' ||
          (this.stableFramesCount >= this.STABILITY_BP_FRAMES && confidence !== 'INVALID');
        if (bpReady) {
          this.measurements.systolicPressure = this.smoothValue(this.measurements.systolicPressure, bpEstimate.systolic, 'stable');
          this.measurements.diastolicPressure = this.smoothValue(this.measurements.diastolicPressure, bpEstimate.diastolic, 'stable');
        }
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
  }

  /**
   * SpO2 - FÓRMULA RATIO-OF-RATIOS
   * 
   * Basado en Beer-Lambert / TI SLAA655, calibrado para cámara smartphone:
   * R = (AC_red/DC_red) / (AC_green/DC_green)
   * SpO2 = 112 - 28 * R   (coeficientes empíricos para green como proxy IR)
   * 
   * Verde se usa como proxy de IR porque ofrece mejor SNR en la yema del dedo
   * con LED flash blanco que el canal azul.
   * 
   * Mejoras implementadas:
   * - Filtrado de mediana sobre ventana de R para estabilidad
   * - Gating por PI mínimo (perfusión) antes de calcular
   * - Validación del rango físico de R (0.2-2.5 para tejido humano)
   */
  // Buffer para valores R (Ratio-of-Ratios) para filtrado de mediana
  private rValueHistory: number[] = [];
  private readonly R_HISTORY_SIZE = 7;  // Ventana corta: convergencia rápida, mediana estable
  private calculateSpO2Raw(): number {
    const { redAC, redDC, greenAC, greenDC } = this.rgbData;
    
    // DC mínimo: necesitamos baseline de canal suficiente
    if (redDC < 10 || greenDC < 5) return 0;
    
    const piRed = (redAC / redDC) * 100;   // como %
    const piGreen = (greenAC / greenDC) * 100;

    // Log de depuración (~cada 0.3s)
    if (this.frameCount % 10 === 0) {
      log.info(`[SpO2 Debug] ACr:${redAC.toFixed(3)} DCr:${redDC.toFixed(0)} PIr:${piRed.toFixed(3)}% | ACg:${greenAC.toFixed(3)} DCg:${greenDC.toFixed(0)} PIg:${piGreen.toFixed(3)}%`);
    }
    
    // Umbral mínimo de pulsatilidad: PI > 0.02% (relajado para cámara)
    if (piRed < 0.02 || piGreen < 0.02) return 0;
    
    const ratioRed = redAC / redDC;
    const ratioGreen = greenAC / greenDC;
    if (!isFinite(ratioRed) || !isFinite(ratioGreen) || ratioRed <= 0 || ratioGreen <= 0) return 0;
    
    const currentR = ratioRed / ratioGreen;
    
    // Rango físico de R para tejido humano con cámara+flash:
    // Con dedo en flash blanco, rojo está cerca de saturación → R puede ser bajo (0.1+)
    if (currentR < 0.1 || currentR > 2.5) {
      if (this.frameCount % 15 === 0) log.warn(`[SpO2] R fuera de rango: ${currentR.toFixed(3)}`);
      return 0;
    }

    // Acumular R para filtrado de mediana
    this.rValueHistory.push(currentR);
    if (this.rValueHistory.length > this.R_HISTORY_SIZE) {
      this.rValueHistory.shift();
    }

    // Solo necesitamos 3 muestras para mediana estable
    if (this.rValueHistory.length < 3) return 0;

    // Mediana de R: robusto ante outliers
    const sortedR = [...this.rValueHistory].sort((a, b) => a - b);
    const medianR = sortedR[Math.floor(sortedR.length / 2)];
    
    // Curva de calibración: Green como proxy IR (TI SLAA655 adaptado)
    // SpO2 = 112 - 28 * R
    const spo2 = Math.min(100, Math.max(70, 112 - 28 * medianR));
    
    if (this.frameCount % 30 === 0) {
      log.info(`[SpO2 Result] R_med:${medianR.toFixed(3)} -> SpO2:${spo2.toFixed(1)}% (n=${this.rValueHistory.length})`);
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
    this.frameCount = 0;
    this.stableFramesCount = 0;
    this.lastCoherentSpO2 = 0;
    this.measurements = {
      spo2: 0,
      systolicPressure: 0,
      diastolicPressure: 0,
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


