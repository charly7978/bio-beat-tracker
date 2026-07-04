import { ArrhythmiaProcessor } from './arrhythmia-processor';
import { BloodPressureProcessor } from './BloodPressureProcessor';
import { SpO2Calculator, type RGBData } from './SpO2Calculator';
export type { RGBData };
import { DisplaySmoothing } from './DisplaySmoothing';

import { createLogger } from '../../utils/logger';
import { isPhysiologicalRR, getMonotonicNow } from '../../utils/physio';
import { VitalMeasurement, MeasurementStatus, SignalQualityMetrics } from '../../types/measurements';
import { CalibrationManager } from './CalibrationManager';
import { SignalQualityIndex } from '../signal-quality/SignalQualityIndex';
import { VITAL_THRESHOLDS, CALIBRATION_CONFIG } from '../../config/vitalThresholds';
import { RESPIRATION_DEFAULTS } from '../../config/signalProcessing';
import { RingF32 } from '../../utils/RingBuffer';
import { clamp } from '../../utils/math';
import { estimateRespiratorySmartFusion } from '../../lib/vitals/respiratorySmartFusion';
import type { FingerPlacementMode } from '../../types/signal';

const log = createLogger('VitalSignsProcessor');

export interface VitalSignsDetailedResult {
  heartRate: VitalMeasurement<number>;
  spo2: VitalMeasurement<number>;
  bloodPressure: VitalMeasurement<{ systolic: number; diastolic: number }>;
  respiration: VitalMeasurement<number>;
  arrhythmia: VitalMeasurement<{ count: number; status: string; score?: number }>;
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
  private readonly CALIBRATION_REQUIRED = CALIBRATION_CONFIG.BP_REQUIRED_SAMPLES;
  private isCalibrating: boolean = false;

  // Estado actual - SIN VALORES BASE FIJOS
  private measurements = {
    spo2: 0,
    systolicPressure: 0,
    diastolicPressure: 0,
    arrhythmiaCount: 0,
    arrhythmiaStatus: "SIN ARRITMIAS|0",
    arrhythmiaScore: 0,
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
  private readonly STABILITY_SPO2_FRAMES = VITAL_THRESHOLDS.SPO2.STABILITY_FRAMES;
  private readonly STABILITY_BP_FRAMES = VITAL_THRESHOLDS.BP.STABILITY_FRAMES_HIGH;
  private lastCoherentSpO2: number = 0;
  /** Frames seguidos con SpO2 fuera de banda de coherencia → adapta cambios reales sostenidos. */
  private spo2IncoherentStreak = 0;

  // Suavizado adaptativo para estabilidad SIN perder respuesta
  // Alpha más bajo = más suavizado = lecturas más estables
  private readonly EMA_ALPHA_STABLE = VITAL_THRESHOLDS.QUALITY.VITAL_EMA_PRIMARY_STABLE;
  private readonly EMA_ALPHA_DYNAMIC = VITAL_THRESHOLDS.QUALITY.VITAL_EMA_PRIMARY_DYNAMIC;
  /** Segundo EMA (doble suavizado) — reduce ruido residual con menos latencia que un único EMA fuerte. */
  private readonly EMA_ALPHA_SECONDARY = VITAL_THRESHOLDS.QUALITY.VITAL_EMA_SECONDARY;
  // Estados del segundo EMA por signo vital
  private ema2Spo2 = 0;
  private ema2Sys = 0;
  private ema2Dia = 0;

  // Contador de pulsos válidos
  private validPulseCount: number = 0;
  private readonly MIN_PULSES_REQUIRED = 2;
  private lastBPM: number = 0;
  /** Últimos intervalos RR (ms) recibidos — alimentan la modalidad RIFV de respiración. */
  private lastRrIntervals: number[] = [];
  /** Respiración del acelerómetro (IMU) — 4ª modalidad (ACC) de la Smart Fusion. */
  private lastAccelRespiration: { rpm: number; quality: number } | null = null;

  // Acumuladores ponderados por confianza para resultado final
  private bpSysWeightedSum = 0;
  private bpDiaWeightedSum = 0;
  private bpTotalWeight = 0;
  /** PI del pipeline PPG (AC/DC canónico); evita que `isClinicallyValid` dependa solo del ratio RGB usado en SpO2 */
  private lastPpgPerfusionIndex = 0;
  private lastSqmBundle: SignalQualityMetrics | null = null;

  // Módulos extraídos para reducir tamaño del procesador
  private readonly spo2Calculator: SpO2Calculator;
  private readonly displaySmoothing: DisplaySmoothing;

  constructor() {
    this.arrhythmiaProcessor = new ArrhythmiaProcessor();
    this.bloodPressureProcessor = new BloodPressureProcessor();
    this.spo2Calculator = new SpO2Calculator();
    this.displaySmoothing = new DisplaySmoothing();
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
      arrhythmiaScore: 0,
      lastArrhythmiaData: null,
      signalQuality: 0
    };
    this.signalHistory.reset();
    this.morphologyHistory.reset();
    this.respirationHistory.reset();
    this.lastRrIntervals = [];
    this.lastAccelRespiration = null;
    this.stableFramesCount = 0;
    this.lastCoherentSpO2 = 0;
    this.spo2IncoherentStreak = 0;
    this.lastPpgPerfusionIndex = 0;
    this.bpSysWeightedSum = 0;
    this.bpDiaWeightedSum = 0;
    this.bpTotalWeight = 0;
    this.spo2Calculator.reset();
    this.displaySmoothing.reset();
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
    /** Canales especializados del banco de filtros PPGSignalSplitter (opcionales, no-op si ausentes) */
    splitterChannels?: {
      morphologyFiltered?: number;
      respirationFiltered?: number;
      arrhythmiaFiltered?: number;
      spo2Channels?: {
        acRed: number;
        dcRed: number;
        acGreen: number;
        dcGreen: number;
        acBlue?: number;
        dcBlue?: number;
      };
    },
    faceBvp?: number,
    faceBpm?: number,
    faceQuality?: number,
    /** Respiración pre-estimada del acelerómetro (IMU) — 4ª modalidad de la Smart Fusion. */
    accelRespiration?: { rpm: number; quality: number },
  ): VitalSignsResult {
    this.frameCount++;
    // Espeja el estado cacheado del acelerómetro (ya throttled en el procesador).
    this.lastAccelRespiration =
      accelRespiration && accelRespiration.quality > 0 ? accelRespiration : null;

    if (
      typeof perfusionIndexFromPpg === 'number' &&
      Number.isFinite(perfusionIndexFromPpg) &&
      perfusionIndexFromPpg > 0
    ) {
      this.lastPpgPerfusionIndex = perfusionIndexFromPpg;
    }

    this.syncAnthropometric();

    // Canal 3 (Bessel): si disponible, usa morfología con fase lineal; si no, fallback al valor clásico
    const morphSample = (() => {
      const fromSplitter = splitterChannels?.morphologyFiltered;
      if (typeof fromSplitter === 'number' && Number.isFinite(fromSplitter) && fromSplitter !== 0) {
        return fromSplitter;
      }
      return typeof morphologyValue === 'number' && Number.isFinite(morphologyValue)
        ? morphologyValue
        : signalValue;
    })();
    this.signalHistory.push(signalValue);
    this.morphologyHistory.push(morphSample);

    // Canal 4 (LP respiratorio): si disponible, usa señal pre-filtrada a banda respiratoria;
    // si no, usa signalValue (comportamiento previo — no rompe nada)
    const respirationSample = (() => {
      const fromSplitter = splitterChannels?.respirationFiltered;
      return typeof fromSplitter === 'number' && Number.isFinite(fromSplitter)
        ? fromSplitter
        : signalValue;
    })();
    this.respirationHistory.push(respirationSample);

    // Guarda los RR para la modalidad RIFV de respiración (getFormattedResult no
    // recibe rrData en su firma).
    if (rrData?.intervals && rrData.intervals.length > 0) {
      this.lastRrIntervals = rrData.intervals;
    }
    // Canal 2 (SpO2 AC/DC): si disponible, actualiza rgbData con los canales limpios del splitter
    if (splitterChannels?.spo2Channels) {
      const { acRed, dcRed, acGreen, dcGreen, acBlue, dcBlue } = splitterChannels.spo2Channels;
      if (dcRed > 0 && dcGreen > 0) {
        const hasBlue =
          typeof acBlue === 'number' && Number.isFinite(acBlue) &&
          typeof dcBlue === 'number' && Number.isFinite(dcBlue) && dcBlue > 0;
        this.rgbData = {
          redAC: acRed,
          redDC: dcRed,
          greenAC: acGreen,
          greenDC: dcGreen,
          blueAC: hasBlue ? acBlue : this.rgbData.blueAC,
          blueDC: hasBlue ? dcBlue : this.rgbData.blueDC,
        };
      }
    }

    const effectiveSqi = Math.max(
      signalQuality,
      sqmBundle?.sqi ?? 0,
      this.lastSqmBundle?.sqi ?? 0,
    );

    // Control de calibración HONESTO: solo avanza si la señal es usable.
    // Se elimina el conteo de frames ciego. La calibración ahora es un estado de confianza.
    if (this.isCalibrating && SignalQualityIndex.isAdequateForLiveVitals(effectiveSqi, perfusionIndexFromPpg ?? 0)) {
      this.calibrationSamples++;
      if (this.calibrationSamples >= this.CALIBRATION_REQUIRED) {
        this.isCalibrating = false;
      }
    }

    this.measurements.signalQuality = effectiveSqi;
    if (sqmBundle) {
      this.lastSqmBundle = SignalQualityIndex.enrichMetrics(
        { ...sqmBundle, sqi: effectiveSqi },
        undefined,
      );
    }

    // Validar pulso real (BP y arritmias; SpO2 usa ratio RGB y no depende de RR)
    this.validateRealPulse(rrData);

    // Fusionar BPM de dedo y rostro usando pesos de calidad
    let fusedBpm = currentBPM;
    if (typeof faceBpm === 'number' && faceBpm > 45 && faceBpm < 200 && typeof faceQuality === 'number' && faceQuality > 15) {
      const fingerWeight = Math.max(5, signalQuality);
      const faceWeight = Math.max(5, faceQuality);
      fusedBpm = (currentBPM * fingerWeight + faceBpm * faceWeight) / (fingerWeight + faceWeight);
    }

    this.calculateVitalSigns(signalValue, effectiveSqi, fusedBpm, rrData);

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
    const respReady =
      vitalUiGate &&
      respBuf.length >= RESPIRATION_DEFAULTS.minBuffer * 0.55 &&
      this.stableFramesCount >= RESPIRATION_DEFAULTS.minStableFrames;
    // Smart Fusion multi-modalidad (Karlen 2013): RIAV (envolvente del pulso) +
    // RIIV (canal LP respiratorio) + RIFV (RSA en la serie RR). Solo fusiona si
    // las modalidades concuerdan → alta especificidad (no inventa un número en
    // ventanas ambiguas).
    const respFusion = respReady
      ? estimateRespiratorySmartFusion({
        pulseSeries: this.signalHistory.tail(this.HISTORY_SIZE),
        respBandSeries: respBuf,
        fsHz: this.VITAL_SIGNAL_ESTIMATE_HZ,
        rrIntervalsMs: this.lastRrIntervals,
        approxBpm: this.lastBPM,
        minRpm: RESPIRATION_DEFAULTS.minRpm,
        maxRpm: RESPIRATION_DEFAULTS.maxRpm,
        accModality: this.lastAccelRespiration
          ? { available: true, rpm: this.lastAccelRespiration.rpm, quality: this.lastAccelRespiration.quality }
          : undefined,
      })
      : null;
    // Forma compatible {rpm, score} para no alterar el downstream (respOk/status).
    const respEst =
      respFusion && respFusion.available
        ? { rpm: respFusion.rpm, score: respFusion.confidence }
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

    const spo2Shown = this.displaySmoothing.updateSpO2Hold(
      this.measurements.spo2,
      spo2UiReady && this.measurements.spo2 >= 70 && this.measurements.spo2 <= 100,
    );
    const spo2HasDisplay = spo2Shown >= 70 && spo2Shown <= 100;

    const spo2Status: MeasurementStatus = !spo2UiReady && !spo2HasDisplay
      ? "LOW_SIGNAL_QUALITY"
      : !spo2HasDisplay
        ? "NO_VALID_SIGNAL"
        : spo2Calib.expired
          ? "CALIBRATION_EXPIRED"
          : spo2Calib.available
            ? "VALID"
            : "REQUIRES_CALIBRATION";

    const bpShown = this.displaySmoothing.updateBPHold(
      this.measurements.systolicPressure,
      this.measurements.diastolicPressure,
      bpUiReady && this.measurements.systolicPressure > 0 && this.measurements.diastolicPressure > 0,
    );
    const bpSysShown = bpShown.systolic;
    const bpDiaShown = bpShown.diastolic;
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
        diagnostics: { rValue: (() => { const h = this.spo2Calculator.getRValueHistory(); return h.length ? h[h.length - 1] : undefined; })() },
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
          ? `Smart Fusion multi-modalidad RIAV+RIIV+RIFV (${respFusion?.fusedCount ?? 1} señales, Karlen 2013)`
          : "Ventana o estabilidad insuficiente para fusión respiratoria",
        signalQuality: { ...commonSQM },
        diagnostics: {
          bufferSamples: respBuf.length,
          score: respEst?.score,
          fusedCount: respFusion?.fusedCount ?? 0,
          agreement: respFusion?.agreement ?? 0,
          modalities: respFusion?.modalities,
        }
      },
      arrhythmia: {
        name: "Pulse Regularity",
        value: {
          count: this.measurements.arrhythmiaCount,
          status: this.measurements.arrhythmiaStatus,
          score: this.measurements.arrhythmiaScore,
        },
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
    rrData?: RRData,
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
      this.stableFramesCount = Math.min(this.stableFramesCount + 0.5, 600);
    } else {
      this.stableFramesCount = Math.max(0, this.stableFramesCount - 2);
    }

    if (this.stableFramesCount % 60 === 0 && this.stableFramesCount > 0) {
      log.info(`[Stability] ${this.stableFramesCount} frames | ${confidence} | SQI:${this.measurements.signalQuality}`);
    }

    // === SpO2 — Basado en física (Beer-Lambert), no estadística ===
    // SpO2 usa ratios ópticos AC/DC directamente de la cámara.
    // Solo necesita datos RGB válidos y confidence no-INVALID.
    const spo2 = this.spo2Calculator.calculate(this.rgbData, this.frameCount);
    const spo2Conf = this.getSpo2Confidence();
    if (spo2 > 0 && spo2 >= 70 && spo2 <= 100 && spo2Conf !== 'INVALID') {
      const isCoherent = this.lastCoherentSpO2 === 0 || Math.abs(spo2 - this.lastCoherentSpO2) < 5;
      if (isCoherent) {
        this.spo2IncoherentStreak = 0;
      } else {
        this.spo2IncoherentStreak++;
      }
      // Rechaza outliers sueltos (causa del salto errático), pero adapta un cambio
      // REAL sostenido (≥25 frames ≈2.5 s fuera de banda → el valor cambió de verdad).
      // Antes un bypass por frameCount>300 desactivaba la coherencia → ruido pasaba.
      if (isCoherent || this.spo2IncoherentStreak >= 25) {
        this.spo2IncoherentStreak = 0;
        this.lastCoherentSpO2 = spo2;
        const pi = this.currentPerfusionIndex();
        const wSpo2 = clamp(signalQuality / 80, 0.1, 1.0) * clamp(pi / 0.005, 0.1, 1.0);
        const firstPass = this.displaySmoothing.smoothWeightedValue(this.measurements.spo2, spo2, wSpo2, 'stable');
        this.measurements.spo2 = this.applyEma2('ema2Spo2', firstPass);
      }
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

        const finalSys = adjusted.systolic;
        const finalDia = adjusted.diastolic;

        const bpCfg = VITAL_THRESHOLDS.BP;
        const bpReady =
          bpEstimate.confidence === 'HIGH' ||
          (bpEstimate.confidence === 'MEDIUM' &&
            this.stableFramesCount >= bpCfg.STABILITY_FRAMES_MEDIUM) ||
          (bpEstimate.confidence === 'LOW' &&
            this.stableFramesCount >= bpCfg.STABILITY_FRAMES_HIGH);
        if (bpReady) {
          const cw = this.confidenceToWeight(bpEstimate.confidence)
            * clamp(bpEstimate.featureQuality / 60, 0.1, 1.0);

          const bpFirstSys = this.displaySmoothing.smoothWeightedValue(
            this.measurements.systolicPressure,
            finalSys,
            cw,
            'stable',
          );
          this.measurements.systolicPressure = this.applyEma2('ema2Sys', bpFirstSys);
          const bpFirstDia = this.displaySmoothing.smoothWeightedValue(
            this.measurements.diastolicPressure,
            finalDia,
            cw,
            'stable',
          );
          this.measurements.diastolicPressure = this.applyEma2('ema2Dia', bpFirstDia);

          this.bpSysWeightedSum += finalSys * cw;
          this.bpDiaWeightedSum += finalDia * cw;
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
    this.measurements.arrhythmiaScore = arrhythmiaResult.arrhythmiaScore;
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
   *
   * NOTA: La implementación concreta se delegó a SpO2Calculator (importado arriba).
   * Este comentario y el método huérfano calculateSpO2Raw se eliminaron en la
   * optimización 2026 para evitar duplicación de lógica.
   */

  /**
   * Segundo pase EMA sobre un valor ya suavizado por {@link DisplaySmoothing}.
   * El primer pase (ponderado por confianza) lo hace displaySmoothing;
   * este segundo pase reduce el residuo ruidoso con alpha fijo, sin añadir
   * latencia apreciable porque el primer pase ya respondió al cambio.
   */
  private applyEma2(
    key: 'ema2Spo2' | 'ema2Sys' | 'ema2Dia',
    firstPass: number,
  ): number {
    if (firstPass === 0 || isNaN(firstPass)) {
      this[key] = 0;
      return firstPass;
    }
    const prev = this[key];
    if (prev === 0 || isNaN(prev)) {
      this[key] = firstPass;
      return firstPass;
    }
    const out = prev * (1 - this.EMA_ALPHA_SECONDARY) + firstPass * this.EMA_ALPHA_SECONDARY;
    this[key] = out;
    return out;
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
    this.lastRrIntervals = [];
    this.lastAccelRespiration = null;
    this.validPulseCount = 0;
    this.arrhythmiaProcessor.reset();
    this.measurements.arrhythmiaCount = 0;
    this.measurements.arrhythmiaStatus = "SIN ARRITMIAS|0";
    this.measurements.lastArrhythmiaData = null;
    this.spo2Calculator.reset();
    this.lastPpgPerfusionIndex = 0;
    this.bpSysWeightedSum = 0;
    this.bpDiaWeightedSum = 0;
    this.bpTotalWeight = 0;
    this.ema2Spo2 = 0;
    this.ema2Sys = 0;
    this.ema2Dia = 0;
    return result;
  }

  fullReset(): void {
    this.signalHistory.reset();
    this.morphologyHistory.reset();
    this.respirationHistory.reset();
    this.lastRrIntervals = [];
    this.lastAccelRespiration = null;
    this.validPulseCount = 0;
    this.spo2Calculator.reset();
    this.frameCount = 0;
    this.stableFramesCount = 0;
    this.lastCoherentSpO2 = 0;
    this.spo2IncoherentStreak = 0;
    this.measurements = {
      spo2: 0,
      systolicPressure: 0,
      diastolicPressure: 0,
      arrhythmiaCount: 0,
      arrhythmiaStatus: "SIN ARRITMIAS|0",
      arrhythmiaScore: 0,
      lastArrhythmiaData: null,
      signalQuality: 0
    };
    this.rgbData = { redAC: 0, redDC: 0, greenAC: 0, greenDC: 0 };
    this.lastPpgPerfusionIndex = 0;
    this.displaySmoothing.reset();
    this.isCalibrating = false;
    this.calibrationSamples = 0;
    this.arrhythmiaProcessor.reset();
    this.bloodPressureProcessor.reset();
    this.bpSysWeightedSum = 0;
    this.bpDiaWeightedSum = 0;
    this.bpTotalWeight = 0;
    this.ema2Spo2 = 0;
    this.ema2Sys = 0;
    this.ema2Dia = 0;
  }
}


