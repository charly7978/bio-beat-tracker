import { ArrhythmiaProcessor } from './arrhythmia-processor';
import { BloodPressureProcessor } from './BloodPressureProcessor';
import { createLogger } from '../../utils/logger';
import { isPhysiologicalRR, getMonotonicNow } from '../../utils/physio';
import { VitalMeasurement, MeasurementStatus, SignalQualityMetrics } from '../../types/measurements';
import { CalibrationManager } from './CalibrationManager';
import { SignalQualityIndex } from '../signal-quality/SignalQualityIndex';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { RESPIRATION_DEFAULTS } from '../../config/signalProcessing';
import { RingF32 } from '../../utils/RingBuffer';
import { clamp } from '../../utils/math';
import { estimateRespiratoryModulationRpm } from '../signal-processing/shared/dsp';
import type { FingerPlacementMode } from '../../types/signal';

const log = createLogger('VitalSignsProcessor');

export interface VitalSignsDetailedResult {
  heartRate: VitalMeasurement<number>;
  spo2: VitalMeasurement<number>;
  bloodPressure: VitalMeasurement<{ systolic: number; diastolic: number }>;
  respiration: VitalMeasurement<number>;
  arrhythmia: VitalMeasurement<{ count: number; status: string }>;
  signalQuality: number;
  isCalibrating: boolean;
  calibrationProgress: number;
}

export interface VitalSignsResult extends VitalSignsDetailedResult {
  lastArrhythmiaData?: {
    timestamp: number;
    rmssd: number;
    rrVariation: number;
  } | null;
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
 * 1. SpO2 ratio-of-ratios (Beer–Lambert aprox.) + suavizado; la UI muestra estimación cuando SQI+PI son válidos aunque no haya perfil de oxímetro en `CalibrationManager`.
 * 2. Presión arterial PWA morfológica; misma política: estimación visible sin tensiómetro de referencia, con estado `REQUIRES_CALIBRATION` y menor confianza.
 * 3. `processSignal` acepta PI del PPG para no desalinear `isClinicallyValid` respecto al canal RGB usado solo en SpO2.
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
  private readonly HISTORY_SIZE = VITAL_THRESHOLDS.BP.MIN_BUFFER_SAMPLES;
  private signalHistory: RingF32 = new RingF32(this.HISTORY_SIZE);
  private morphologyHistory: RingF32 = new RingF32(this.HISTORY_SIZE);
  private placementMode: FingerPlacementMode = 'hybrid';
  /** Buffer más largo para modulación respiratoria (~10 Hz efectivos desde Index). */
  private readonly RESPIRATION_BUFFER = 320;
  private respirationHistory: RingF32 = new RingF32(this.RESPIRATION_BUFFER);
  private readonly VITAL_SIGNAL_ESTIMATE_HZ = 10;
  private frameCount = 0;  // Contador continuo para logging/diagnóstico
  
  // RGB para SpO2
  private rgbData: RGBData = { redAC: 0, redDC: 0, greenAC: 0, greenDC: 0 };
  
  // Gating de estabilidad (Consistencia)
  private stableFramesCount: number = 0;
  private readonly STABILITY_SPO2_FRAMES = 45;  // ~1.5s para SpO2 (actualización rápida)
  private readonly STABILITY_BP_FRAMES = VITAL_THRESHOLDS.BP.STABILITY_FRAMES_HIGH;
  private lastCoherentSpO2: number = 0;
  
  // Suavizado adaptativo para estabilidad SIN perder respuesta
  // Alpha más bajo = más suavizado = lecturas más estables
  private readonly EMA_ALPHA_STABLE = 0.15;
  private readonly EMA_ALPHA_DYNAMIC = 0.25;

  // Contador de pulsos válidos
  private validPulseCount: number = 0;
  private readonly MIN_PULSES_REQUIRED = 2;
  private lastBPM: number = 0;

  // Acumuladores ponderados por confianza para resultado final
  private bpSysWeightedSum = 0;
  private bpDiaWeightedSum = 0;
  private bpTotalWeight = 0;
  /** PI del pipeline PPG (AC/DC canónico); evita que `isClinicallyValid` dependa solo del ratio RGB usado en SpO2 */
  private lastPpgPerfusionIndex = 0;
  private lastSqmBundle: SignalQualityMetrics | null = null;
  /** Evita que SpO2/PA desaparezcan por un frame de gate bajo */
  private displayHold = {
    spo2: 0,
    systolic: 0,
    diastolic: 0,
    missedFrames: 0,
  };
  private readonly DISPLAY_HOLD_MAX_FRAMES = 240;

  constructor() {
    this.arrhythmiaProcessor = new ArrhythmiaProcessor();
    this.bloodPressureProcessor = new BloodPressureProcessor();
    this.arrhythmiaProcessor.setArrhythmiaDetectionCallback((detected) => {
      log.info(`Estado arritmia → ${detected ? 'ARRITMIA' : 'NORMAL'}`);
    });
    this.syncAnthropometric();
  }

  private syncAnthropometric(): void {
    const cal = CalibrationManager.getInstance();
    const anthrop = cal.getAnthropometric();
    if (anthrop) {
      this.bloodPressureProcessor.setAnthropometric(anthrop);
    }
  }

  /** Calentamiento in-sesión (muestras internas), no crea perfiles en `CalibrationManager`. */
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
    this.signalHistory.reset();
    this.morphologyHistory.reset();
    this.respirationHistory.reset();
    this.stableFramesCount = 0;
    this.lastCoherentSpO2 = 0;
    this.lastPpgPerfusionIndex = 0;
    this.bpSysWeightedSum = 0;
    this.bpDiaWeightedSum = 0;
    this.bpTotalWeight = 0;
  }

  forceCalibrationCompletion(): void {
    this.isCalibrating = false;
    this.calibrationSamples = this.CALIBRATION_REQUIRED;
  }
  
  setRGBData(data: RGBData): void {
    this.rgbData = data;
  }

  setPlacementMode(mode: FingerPlacementMode): void {
    this.placementMode = mode;
    this.bloodPressureProcessor.setPlacementMode(mode);
  }

  processSignal(
    signalValue: number,
    signalQuality: number,
    currentBPM: number,
    rrData?: RRData,
    perfusionIndexFromPpg?: number,
    sqmBundle?: Partial<SignalQualityMetrics>,
    morphologyValue?: number,
  ): VitalSignsResult {
    this.frameCount++;

    if (
      typeof perfusionIndexFromPpg === 'number' &&
      Number.isFinite(perfusionIndexFromPpg) &&
      perfusionIndexFromPpg > 0
    ) {
      this.lastPpgPerfusionIndex = perfusionIndexFromPpg;
    }

    this.syncAnthropometric();

    const morphSample =
      typeof morphologyValue === 'number' && Number.isFinite(morphologyValue)
        ? morphologyValue
        : signalValue;
    this.signalHistory.push(signalValue);
    this.morphologyHistory.push(morphSample);
    this.respirationHistory.push(signalValue);
    // Control de calibración
    if (this.isCalibrating) {
      this.calibrationSamples++;
      if (this.calibrationSamples >= this.CALIBRATION_REQUIRED) {
        this.isCalibrating = false;
      }
    }

    const effectiveSqi = Math.max(
      signalQuality,
      sqmBundle?.sqi ?? 0,
      this.lastSqmBundle?.sqi ?? 0,
    );
    this.measurements.signalQuality = effectiveSqi;
    if (sqmBundle) {
      this.lastSqmBundle = SignalQualityIndex.enrichMetrics(
        { ...sqmBundle, sqi: effectiveSqi },
        undefined,
      );
    }

    // Validar pulso real (BP y arritmias; SpO2 usa ratio RGB y no depende de RR)
    this.validateRealPulse(rrData);

    this.calculateVitalSigns(signalValue, effectiveSqi, currentBPM, rrData);


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

  // El método calculateSignalQuality ha sido eliminado para usar el SQI unificado de PPGSignalProcessor.


  private getMeasurementConfidence(): 'HIGH' | 'MEDIUM' | 'LOW' | 'INVALID' {
    const sq = this.measurements.signalQuality;
    if (sq >= 55 && this.validPulseCount >= 4) return 'HIGH';
    if (sq >= 30 && this.validPulseCount >= 3) return 'MEDIUM';
    if (sq >= 12 && this.validPulseCount >= 2) return 'LOW';
    return 'INVALID';
  }

  /** Convierte nivel de confianza a peso numérico para acumulación ponderada */
  private confidenceToWeight(confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INVALID'): number {
    switch (confidence) {
      case 'HIGH': return 1.0;
      case 'MEDIUM': return 0.7;
      case 'LOW': return 0.4;
      default: return 0;
    }
  }

  /** SpO2 ratio-of-ratios: no requiere ventana RR, solo RGB + perfusión mínima */
  private getSpo2Confidence(): 'LOW' | 'INVALID' {
    const sq = this.measurements.signalQuality;
    const piRgb = this.rgbData.greenDC > 0 ? this.rgbData.greenAC / this.rgbData.greenDC : 0;
    const pi = Math.max(piRgb, this.lastPpgPerfusionIndex);
    if (SignalQualityIndex.isAdequateForLiveVitals(sq, pi)) return 'LOW';
    if (sq >= 8 && pi >= 0.00015 && this.rgbData.redDC >= 10 && this.rgbData.greenDC >= 5) {
      return 'LOW';
    }
    return 'INVALID';
  }

  private currentPerfusionIndex(): number {
    const piRgb = this.rgbData.greenDC > 0 ? this.rgbData.greenAC / this.rgbData.greenDC : 0;
    return Math.max(piRgb, this.lastPpgPerfusionIndex);
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
    const calib = CalibrationManager.getInstance();
    const now = Date.now();
    const sqi = this.measurements.signalQuality;
    const pi = this.currentPerfusionIndex();
    const isClinicallyValid = SignalQualityIndex.isClinicallyValid(sqi, pi);
    const vitalUiGate =
      isClinicallyValid || SignalQualityIndex.isAdequateForLiveVitals(sqi, pi);
    const spo2UiReady = this.getSpo2Confidence() !== 'INVALID';
    const spo2Calib = calib.getCalibrationInfo('SPO2');
    const bpCalib = calib.getCalibrationInfo('BP');

    const respBuf = this.respirationHistory.tail(this.RESPIRATION_BUFFER);
    const respEst =
      vitalUiGate && respBuf.length >= RESPIRATION_DEFAULTS.minBuffer * 0.55 && this.stableFramesCount >= RESPIRATION_DEFAULTS.minStableFrames
        ? estimateRespiratoryModulationRpm(respBuf, this.VITAL_SIGNAL_ESTIMATE_HZ)
        : null;

    const commonSQM: SignalQualityMetrics = this.lastSqmBundle ?? {
      sqi,
      perfusionIndex: pi,
      snr: null,
      periodicity: null,
      motionScore: null,
      saturationRatio: 0,
      frameDropRatio: 0,
      fpsEffective: 30,
      timestampJitterMs: 0,
    };

    const hrMinSqi = VITAL_THRESHOLDS.QUALITY.MIN_FOR_HR;
    const hrOk = this.lastBPM > 0 && sqi >= hrMinSqi;
    const bpUiReady =
      vitalUiGate || (this.validPulseCount >= 2 && sqi >= 12);

    if (
      spo2UiReady &&
      this.measurements.spo2 > 0 &&
      this.measurements.spo2 >= 70 &&
      this.measurements.spo2 <= 100
    ) {
      this.displayHold.spo2 = this.measurements.spo2;
      this.displayHold.missedFrames = 0;
    } else if (this.displayHold.spo2 > 0) {
      this.displayHold.missedFrames++;
      if (
        this.measurements.spo2 > 0 &&
        Math.abs(this.measurements.spo2 - this.displayHold.spo2) /
          Math.max(1, this.displayHold.spo2) >
          0.015
      ) {
        this.displayHold.spo2 = this.measurements.spo2;
        this.displayHold.missedFrames = 0;
      }
    }

    if (
      bpUiReady &&
      this.measurements.systolicPressure > 0 &&
      this.measurements.diastolicPressure > 0
    ) {
      this.displayHold.systolic = this.measurements.systolicPressure;
      this.displayHold.diastolic = this.measurements.diastolicPressure;
      this.displayHold.missedFrames = 0;
    } else if (this.displayHold.systolic > 0 && this.measurements.systolicPressure > 0) {
      const sysDrift =
        Math.abs(this.measurements.systolicPressure - this.displayHold.systolic) /
        Math.max(1, this.displayHold.systolic);
      const diaDrift =
        Math.abs(this.measurements.diastolicPressure - this.displayHold.diastolic) /
        Math.max(1, this.displayHold.diastolic);
      if (sysDrift > 0.02 || diaDrift > 0.02) {
        this.displayHold.systolic = this.measurements.systolicPressure;
        this.displayHold.diastolic = this.measurements.diastolicPressure;
        this.displayHold.missedFrames = 0;
      }
    }

    const holdActive =
      this.displayHold.missedFrames < this.DISPLAY_HOLD_MAX_FRAMES;
    const spo2Shown =
      spo2UiReady &&
      this.measurements.spo2 > 0
        ? this.measurements.spo2
        : holdActive && this.displayHold.spo2 > 0
          ? this.displayHold.spo2
          : 0;
    const spo2HasDisplay =
      spo2Shown >= 70 && spo2Shown <= 100;

    const spo2Status: MeasurementStatus = !spo2UiReady && !holdActive
      ? "LOW_SIGNAL_QUALITY"
      : !spo2HasDisplay
        ? "NO_VALID_SIGNAL"
        : spo2Calib.expired
          ? "CALIBRATION_EXPIRED"
          : spo2Calib.available
            ? "VALID"
            : "REQUIRES_CALIBRATION";
    const bpSysShown =
      bpUiReady && this.measurements.systolicPressure > 0
        ? this.measurements.systolicPressure
        : holdActive && this.displayHold.systolic > 0
          ? this.displayHold.systolic
          : 0;
    const bpDiaShown =
      bpUiReady && this.measurements.diastolicPressure > 0
        ? this.measurements.diastolicPressure
        : holdActive && this.displayHold.diastolic > 0
          ? this.displayHold.diastolic
          : 0;
    const bpHasMorph =
      bpUiReady &&
      (this.lastBPConfidence !== 'INSUFFICIENT' || holdActive) &&
      bpSysShown > 0 &&
      bpDiaShown > 0;

    const bpStatus: MeasurementStatus = !bpUiReady
      ? "LOW_SIGNAL_QUALITY"
      : !bpHasMorph
        ? "NO_VALID_SIGNAL"
        : bpCalib.expired
          ? "CALIBRATION_EXPIRED"
          : bpCalib.available
            ? "VALID"
            : "REQUIRES_CALIBRATION";

    const respOk = respEst && respEst.score >= 0.14;
    const respStatus: MeasurementStatus = !vitalUiGate
      ? "LOW_SIGNAL_QUALITY"
      : respBuf.length < RESPIRATION_DEFAULTS.minBuffer * 0.55 || this.stableFramesCount < RESPIRATION_DEFAULTS.minStableFrames
        ? "INSUFFICIENT_WINDOW"
        : respOk
          ? "VALID"
          : "NO_VALID_SIGNAL";

    const res: VitalSignsResult = {
      heartRate: {
        name: "Heart Rate",
        value: hrOk ? Math.round(this.lastBPM) : null,
        unit: "bpm",
        timestamp: now,
        confidence: hrOk ? Math.min(0.98, 0.45 + sqi / 200) : (sqi >= hrMinSqi ? 0.35 : 0.12),
        status: !hrOk && sqi < 12 ? "LOW_SIGNAL_QUALITY" : (!hrOk ? "NO_VALID_SIGNAL" : "VALID"),
        reason: hrOk
          ? "BPM desde detector Elgendi optimizado"
          : (sqi < 12 ? "SQI insuficiente para validar picos" : "Sin consenso fiable de detectores / frecuencia"),
        signalQuality: { ...commonSQM },
        diagnostics: { bpmRaw: this.lastBPM }
      },
      spo2: {
        name: "SpO2",
        value: spo2HasDisplay ? Math.round(this.measurements.spo2) : null,
        unit: "%",
        timestamp: now,
        confidence: !spo2HasDisplay
          ? 0.22
          : spo2Calib.available && !spo2Calib.expired
            ? 0.88
            : spo2Calib.expired
              ? 0.34
              : 0.52,
        status: spo2Status,
        reason:
          spo2Calib.available && !spo2Calib.expired
            ? "Beer–Lambert ratio-of-ratios con perfil de referencia vigente"
            : "Estimación ratio-of-ratios cámara+flash (no sustituye oxímetro certificado); calibre con oxímetro para uso clínico",
        signalQuality: { ...commonSQM },
        diagnostics: { rValue: this.rValueHistory[this.rValueHistory.length - 1] },
        calibration: spo2Calib
      },
      bloodPressure: {
        name: "Blood Pressure",
        value: bpHasMorph
          ? {
              systolic: Math.round(bpSysShown),
              diastolic: Math.round(bpDiaShown),
            }
          : null,
        unit: "mmHg",
        timestamp: now,
        confidence: !bpHasMorph
          ? 0.26
          : bpCalib.available && !bpCalib.expired && this.lastBPConfidence === 'HIGH'
            ? 0.9
            : bpCalib.available && !bpCalib.expired
              ? 0.64
              : 0.4,
        status: bpStatus,
        reason:
          bpCalib.available && !bpCalib.expired
            ? "PWA morfológica con perfil calibrado"
            : "Estimación PWA desde morfología PPG (sin tensiómetro de referencia); valor orientativo",
        signalQuality: { ...commonSQM },
        diagnostics: { featureQuality: this.lastBPFeatureQuality },
        calibration: bpCalib
      },
      respiration: {
        name: "Respiration",
        value: respOk ? Math.round(respEst!.rpm) : null,
        unit: "rpm",
        timestamp: now,
        confidence: respOk ? clamp(respEst!.score, 0, 1) : 0,
        status: respStatus,
        reason: respOk
          ? "Modulación de amplitud PPG (banda respiratoria)"
          : "Ventana o estabilidad insuficiente para modulación respiratoria",
        signalQuality: { ...commonSQM },
        diagnostics: { bufferSamples: respBuf.length, score: respEst?.score }
      },
      arrhythmia: {
        name: "Pulse Regularity", 
        value: { count: this.measurements.arrhythmiaCount, status: this.measurements.arrhythmiaStatus },
        unit: "events", 
        timestamp: now, 
        confidence: vitalUiGate ? 0.85 : 0.2,
        status: vitalUiGate ? "VALID" : "LOW_SIGNAL_QUALITY", 
        reason: "RR interval variability analysis (RMSSD/Shannon)",
        signalQuality: { ...commonSQM }, 
        diagnostics: { rmssd: this.measurements.lastArrhythmiaData?.rmssd }
      },
      signalQuality: Math.round(sqi),
      isCalibrating: this.isCalibrating,
      calibrationProgress: this.getCalibrationProgress(),
      lastArrhythmiaData: this.measurements.lastArrhythmiaData
    };

    return res;
  }

  /**
   * CÁLCULO UNIFICADO DE SIGNOS VITALES
   * Usa extractCycleFeatures (API moderna) en lugar de extractAllFeatures (legacy)
   * para glucosa, hemoglobina y lípidos con modelos basados en literatura
   */
  private calculateVitalSigns(
    signalValue: number, 
    signalQuality: number,
    currentBPM: number,
    rrData?: RRData
  ): void {
    const minQualityForCalculation = 5; // Bajado de 12 para permitir visualización temprana
    if (signalQuality < minQualityForCalculation) {
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
    const spo2Conf = this.getSpo2Confidence();
    if (spo2 > 0 && spo2 >= 70 && spo2 <= 100 && spo2Conf !== 'INVALID') {
      const isCoherent = this.lastCoherentSpO2 === 0 || Math.abs(spo2 - this.lastCoherentSpO2) < 5;
      if (isCoherent || this.frameCount > 300) {
        this.lastCoherentSpO2 = spo2;
        this.measurements.spo2 = this.smoothValue(this.measurements.spo2, spo2, 'stable');
      }
    }

    this.lastBPM = currentBPM > 0 ? currentBPM : 0;
    const hr = this.lastBPM;

    // === BP y Arritmias — requieren rrData válido ===
    const validRR = rrData?.intervals?.filter(isPhysiologicalRR) || [];
    
    // === BP ===
    if (validRR.length >= 2) {
      // morphologyHistory se alimenta a la cadencia de vitales (1 muestra cada
      // VITALS_PROCESS_EVERY_N_FRAMES frames ≈ 10 Hz), NO a la tasa de frames de
      // cámara. Pasar 30 aquí desescalaba ~3× todas las features temporales del
      // PWA (SUT/PW50/fase diastólica) y hacía que la validación de ciclo
      // (350–1800 ms) rechazara latidos de frecuencia normal. Usar la misma
      // tasa efectiva que la respiración (única fuente: VITAL_SIGNAL_ESTIMATE_HZ).
      const bpEstimate = this.bloodPressureProcessor.estimate(
        this.morphologyHistory.tail(this.HISTORY_SIZE),
        validRR,
        this.VITAL_SIGNAL_ESTIMATE_HZ,
        this.lastBPM > 0 ? this.lastBPM : undefined,
      );

      this.lastBPConfidence = bpEstimate.confidence;
      this.lastBPFeatureQuality = bpEstimate.featureQuality;
      
      if (bpEstimate.systolic > 0 && bpEstimate.confidence !== 'INSUFFICIENT') {
        const calib = CalibrationManager.getInstance();
        const adjusted = calib.applyBloodPressureCalibration(
          bpEstimate.systolic,
          bpEstimate.diastolic,
        );
        const bpCfg = VITAL_THRESHOLDS.BP;
        const bpReady =
          bpEstimate.confidence === 'HIGH' ||
          (bpEstimate.confidence === 'MEDIUM' &&
            this.stableFramesCount >= bpCfg.STABILITY_FRAMES_MEDIUM) ||
          (bpEstimate.confidence === 'LOW' &&
            this.stableFramesCount >= bpCfg.STABILITY_FRAMES_HIGH);
        if (bpReady) {
          this.measurements.systolicPressure = this.smoothValue(
            this.measurements.systolicPressure,
            adjusted.systolic,
            'stable',
          );
          this.measurements.diastolicPressure = this.smoothValue(
            this.measurements.diastolicPressure,
            adjusted.diastolic,
            'stable',
          );
          // Acumular BP ponderado por confianza × calidad de feature
          const cw = this.confidenceToWeight(bpEstimate.confidence)
            * clamp(bpEstimate.featureQuality / 60, 0.1, 1.0);
          this.bpSysWeightedSum += adjusted.systolic * cw;
          this.bpDiaWeightedSum += adjusted.diastolic * cw;
          this.bpTotalWeight += cw;
        }
      }
    }

    // Arrhythmia — solo con RR robustos y SQI suficiente
    const arrCfg = VITAL_THRESHOLDS.ARRHYTHMIA;
    const arrhythmiaRR = validRR.slice(-arrCfg.RR_WINDOW_SIZE);
    const detectorAgree = this.lastSqmBundle?.detectorAgreement ?? 0;
    const arrhythmiaInput = (
      arrhythmiaRR.length >= arrCfg.MIN_INTERVALS &&
      this.measurements.signalQuality >= arrCfg.MIN_SQI &&
      detectorAgree >= VITAL_THRESHOLDS.QUALITY.MIN_DETECTOR_AGREEMENT_ARRHYTHMIA &&
      hr >= VITAL_THRESHOLDS.HR.MIN &&
      hr <= VITAL_THRESHOLDS.HR.MAX &&
      this.validPulseCount >= 3
    ) ? { ...rrData!, intervals: arrhythmiaRR } : undefined;

    const arrhythmiaResult = this.arrhythmiaProcessor.processRRData(arrhythmiaInput);
    this.measurements.arrhythmiaStatus = arrhythmiaResult.arrhythmiaStatus;
    this.measurements.lastArrhythmiaData = arrhythmiaResult.lastArrhythmiaData;
    this.measurements.arrhythmiaCount = arrhythmiaResult.arrhythmiaCount;
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
  private calculateSpO2Raw(): number {
    const spoCfg = VITAL_THRESHOLDS.SPO2;
    const { redAC, redDC, greenAC, greenDC } = this.rgbData;

    if (redDC < spoCfg.MIN_RED_DC || greenDC < spoCfg.MIN_GREEN_DC) return 0;
    
    const piRed = (redAC / redDC) * 100;   // como %
    const piGreen = (greenAC / greenDC) * 100;

    // Log de depuración (~cada 0.3s)
    if (this.frameCount % 10 === 0) {
      log.info(`[SpO2 Debug] ACr:${redAC.toFixed(3)} DCr:${redDC.toFixed(0)} PIr:${piRed.toFixed(3)}% | ACg:${greenAC.toFixed(3)} DCg:${greenDC.toFixed(0)} PIg:${piGreen.toFixed(3)}%`);
    }
    
    if (piRed < spoCfg.MIN_PI_PERCENT || piGreen < spoCfg.MIN_PI_PERCENT) return 0;
    
    const ratioRed = redAC / redDC;
    const ratioGreen = greenAC / greenDC;
    if (!isFinite(ratioRed) || !isFinite(ratioGreen) || ratioRed <= 0 || ratioGreen <= 0) return 0;
    
    const currentR = ratioRed / ratioGreen;
    
    // Rango físico de R para tejido humano con cámara+flash:
    // Con dedo en flash blanco, rojo está cerca de saturación → R puede ser bajo (0.1+)
    if (currentR < spoCfg.R_VALUE_MIN || currentR > spoCfg.R_VALUE_MAX) {
      if (this.frameCount % 15 === 0) log.warn(`[SpO2] R fuera de rango: ${currentR.toFixed(3)}`);
      return 0;
    }

    // Acumular R para filtrado de mediana
    this.rValueHistory.push(currentR);
    if (this.rValueHistory.length > spoCfg.R_HISTORY_SAMPLES) {
      this.rValueHistory.shift();
    }

    if (this.rValueHistory.length < 3) return 0;

    const sortedR = [...this.rValueHistory].sort((a, b) => a - b);
    const medianR = sortedR[Math.floor(sortedR.length / 2)] ?? 0;

    const spo2 = Math.min(
      spoCfg.DISPLAY_CAP,
      Math.max(
        spoCfg.MIN_VALID,
        spoCfg.R_MODEL_INTERCEPT - spoCfg.R_MODEL_SLOPE * medianR,
      ),
    );
    
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
    if (this.bpTotalWeight > 0 && result.bloodPressure.value) {
      const wAvgSys = Math.round(this.bpSysWeightedSum / this.bpTotalWeight);
      const wAvgDia = Math.round(this.bpDiaWeightedSum / this.bpTotalWeight);
      if (wAvgSys > 0 && wAvgDia > 0) {
        result.bloodPressure.value.systolic = wAvgSys;
        result.bloodPressure.value.diastolic = wAvgDia;
      }
    }
    this.signalHistory.reset();
    this.morphologyHistory.reset();
    this.respirationHistory.reset();
    this.validPulseCount = 0;
    this.arrhythmiaProcessor.reset();
    this.measurements.arrhythmiaCount = 0;
    this.measurements.arrhythmiaStatus = "SIN ARRITMIAS|0";
    this.measurements.lastArrhythmiaData = null;
    this.rValueHistory = [];
    this.lastPpgPerfusionIndex = 0;
    this.bpSysWeightedSum = 0;
    this.bpDiaWeightedSum = 0;
    this.bpTotalWeight = 0;
    return result;
  }

  fullReset(): void {
    this.signalHistory.reset();
    this.morphologyHistory.reset();
    this.respirationHistory.reset();
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
    this.lastPpgPerfusionIndex = 0;
    this.displayHold = { spo2: 0, systolic: 0, diastolic: 0, missedFrames: 0 };
    this.isCalibrating = false;
    this.calibrationSamples = 0;
    this.arrhythmiaProcessor.reset();
    this.bloodPressureProcessor.reset();
    this.bpSysWeightedSum = 0;
    this.bpDiaWeightedSum = 0;
    this.bpTotalWeight = 0;
  }
}


