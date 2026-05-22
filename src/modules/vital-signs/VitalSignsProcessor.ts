import { ArrhythmiaProcessor } from './arrhythmia-processor';
import { BloodPressureProcessor } from './BloodPressureProcessor';
import { SpO2Processor } from './SpO2Processor';
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
  blueAC: number;
  blueDC: number;
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
  private spo2Processor: SpO2Processor;
  private lastBPConfidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT' = 'INSUFFICIENT';
  private lastBPFeatureQuality: number = 0;
  private lastSpO2RValue: number = 0;
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
  private rgbData: RGBData = { redAC: 0, redDC: 0, greenAC: 0, greenDC: 0, blueAC: 0, blueDC: 0 };
  
  // Gating de estabilidad (Consistencia)
  private stableFramesCount: number = 0;
  
  // Suavizado adaptativo para estabilidad SIN perder respuesta
  // Alpha más bajo = más suavizado = lecturas más estables
  private readonly EMA_ALPHA_STABLE = 0.20;
  private readonly EMA_ALPHA_DYNAMIC = 0.30;

  // Contador de pulsos válidos
  private validPulseCount: number = 0;
  private readonly MIN_PULSES_REQUIRED = 2;
  private lastBPM: number = 0;
  /** PI del pipeline PPG (AC/DC canónico); evita que `isClinicallyValid` dependa solo del ratio RGB usado en SpO2 */
  private lastPpgPerfusionIndex = 0;
  private lastSqmBundle: SignalQualityMetrics | null = null;
  private spo2DisplayHold = 0;
  private spo2DisplayFrames = 0;
  private lastValidPulseCount = -1;
  private rgbDataReady = false;
  /** Evita que BP desaparezca por un frame de gate bajo */
  private displayHold = {
    systolic: 0,
    diastolic: 0,
    missedFrames: 0,
  };
  private readonly DISPLAY_HOLD_MAX_FRAMES = 120;

  constructor() {
    this.arrhythmiaProcessor = new ArrhythmiaProcessor();
    this.bloodPressureProcessor = new BloodPressureProcessor();
    this.spo2Processor = new SpO2Processor();
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
    this.lastPpgPerfusionIndex = 0;
    this.spo2Processor.reset();
  }

  forceCalibrationCompletion(): void {
    this.isCalibrating = false;
    this.calibrationSamples = this.CALIBRATION_REQUIRED;
  }
  
  setRGBData(data: RGBData): void {
    this.rgbData = data;
    this.rgbDataReady = true;
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

    // Validar pulso real (BP y arritmias)
    this.validateRealPulse(rrData);

    // SpO2: detectar transicion sin-pulso → con-pulso para resetear estado.
    if (this.lastValidPulseCount === 0 && this.validPulseCount >= 1) {
      this.spo2Processor.reset();
      this.rgbDataReady = false;
    }
    this.lastValidPulseCount = this.validPulseCount;

    this.measurements.spo2 = 0;
    // Solo alimentar cuando hay pulso valido Y datos RGB frescos.
    // Sin rgbDataReady, los AC/DC viejos (pre-reset) contaminarian el buffer.
    if (this.validPulseCount >= 1 && this.rgbDataReady) {
      const sp2 = this.spo2Processor.update(
        this.rgbData.redAC, this.rgbData.redDC,
        this.rgbData.greenAC, this.rgbData.greenDC,
        this.rgbData.blueAC, this.rgbData.blueDC,
      );
      if (sp2.confidence !== 'INSUFFICIENT' && sp2.spo2 >= 70 && sp2.spo2 <= 100) {
        this.measurements.spo2 = sp2.spo2;
        this.lastSpO2RValue = sp2.rValue;
      }
    }

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
    if (this.measurements.spo2 >= 70 && this.measurements.spo2 <= 100) {
      this.spo2DisplayHold = this.measurements.spo2;
      this.spo2DisplayFrames = 0;
    } else if (this.spo2DisplayHold > 0) {
      this.spo2DisplayFrames++;
      if (this.spo2DisplayFrames >= 45) {
        this.spo2DisplayHold = 0;
      }
    }
    const spo2Shown = this.measurements.spo2 > 0
      ? this.measurements.spo2
      : this.spo2DisplayHold;
    const spo2HasDisplay =
      spo2Shown >= 70 && spo2Shown <= 100;

    const spo2Status: MeasurementStatus = !spo2HasDisplay
      ? "LOW_SIGNAL_QUALITY"
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
      this.lastBPConfidence !== 'INSUFFICIENT' &&
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
          ? "BPM desde ensemble Elgendi + Pan–Tompkins PPG + autocorrelación"
          : (sqi < 12 ? "SQI insuficiente para validar picos" : "Sin consenso fiable de detectores / frecuencia"),
        signalQuality: { ...commonSQM },
        diagnostics: { bpmRaw: this.lastBPM }
      },
      spo2: {
        name: "SpO2",
        value: spo2HasDisplay ? Math.round(spo2Shown) : null,
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
        diagnostics: { rValue: this.lastSpO2RValue },
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
    
    this.lastBPM = currentBPM > 0 ? currentBPM : 0;
    const hr = this.lastBPM;

    // === BP y Arritmias — requieren rrData válido ===
    const validRR = rrData?.intervals?.filter(isPhysiologicalRR) || [];
    
    // === BP ===
    if (validRR.length >= 2) {
      const bpEstimate = this.bloodPressureProcessor.estimate(
        this.morphologyHistory.tail(this.HISTORY_SIZE),
        validRR,
        30,
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
      detectorAgree >= VITAL_THRESHOLDS.QUALITY.MIN_DETECTOR_AGREEMENT_ARRHYTHMIA + 0.06 &&
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
    this.signalHistory.reset();
    this.morphologyHistory.reset();
    this.respirationHistory.reset();
    this.validPulseCount = 0;
    this.arrhythmiaProcessor.reset();
    this.measurements.arrhythmiaCount = 0;
    this.measurements.arrhythmiaStatus = "SIN ARRITMIAS|0";
    this.measurements.lastArrhythmiaData = null;
    this.lastPpgPerfusionIndex = 0;
    this.rgbDataReady = false;
    this.spo2Processor.reset();
    return result;
  }

  fullReset(): void {
    this.signalHistory.reset();
    this.morphologyHistory.reset();
    this.respirationHistory.reset();
    this.validPulseCount = 0;
    this.frameCount = 0;
    this.stableFramesCount = 0;
    this.measurements = {
      spo2: 0,
      systolicPressure: 0,
      diastolicPressure: 0,
      arrhythmiaCount: 0,
      arrhythmiaStatus: "SIN ARRITMIAS|0",
      lastArrhythmiaData: null,
      signalQuality: 0
    };
    this.rgbData = { redAC: 0, redDC: 0, greenAC: 0, greenDC: 0, blueAC: 0, blueDC: 0 };
    this.lastPpgPerfusionIndex = 0;
    this.displayHold = { systolic: 0, diastolic: 0, missedFrames: 0 };
    this.spo2DisplayHold = 0;
    this.spo2DisplayFrames = 0;
    this.rgbDataReady = false;
    this.isCalibrating = false;
    this.calibrationSamples = 0;
    this.arrhythmiaProcessor.reset();
    this.bloodPressureProcessor.fullReset();
    this.spo2Processor.reset();
  }
}


