import type { ProcessedSignal, ProcessingError, SignalProcessor as SignalProcessorInterface, ContactState } from '../../types/signal';
import { BandpassFilter } from './BandpassFilter';
import { createLogger, ppgPerf } from '../../utils/logger';
import { clamp } from '../../utils/math';
import { RingF32 } from '../../utils/RingBuffer';
import {
  DEFAULT_BACKPRESSURE_CONFIG,
  sanitizeBackpressureConfig,
  type BackpressureConfig,
} from '../../lib/perf/backpressureConfig';
import type { MeasurementStatus, SignalQualityMetrics } from '../../types/measurements';
import {
  SignalQualityIndex,
  createDiagnosticStatusState,
  type DiagnosticStatusState,
} from '../signal-quality/SignalQualityIndex';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { redSeriesCoefficientOfVariation } from './fingerRoiPulsation';
import { hasFingerHemoglobinSignature } from '../../lib/finger/fingerContactSignature';

const log = createLogger('PPGSignalProcessor');
// BUILD_STAMP: 2026-05-15 18:32:00

interface ROIMetrics {
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  coverageRatio: number;
  fingerScore: number;
  roiX: number;
  roiY: number;
  roiW: number;
  roiH: number;
}

/**
 * MULTI-SOURCE PPG SIGNAL PROCESSOR
 * 
 * Mejoras clave:
 * 1. Estado de contacto 3-niveles (NO_CONTACT / UNSTABLE / STABLE)
 * 2. Selección competitiva de canal (R, G, R-G; sin CHROM — ruido con dedo+flash)
 * 3. SQI unificado — única fuente de verdad
 * 4. Histéresis fuerte para tolerancia a temblores
 */
export class PPGSignalProcessor implements SignalProcessorInterface {
  public isProcessing = false;

  private bandpassFilter: BandpassFilter;

  private readonly BUFFER_SIZE = 300;
  private readonly ACDC_WINDOW = 180;
  private readonly TILE_COLUMNS = 5;
  private readonly TILE_ROWS = 5;

  // === BACKPRESSURE / ADAPTIVE STRIDE ===
  // Stride de muestreo de píxeles dentro del ROI. 3 = baseline (cada 3 píxeles).
  // Sube a 4 si fps < 20 sostenido > 3s, baja a 3 cuando fps >= 25.
  // Evita reescribir el pipeline cuando el dispositivo es lento; sólo reduce el
  // muestreo espacial preservando la temporal (que es lo que importa para BPM).
  private pixelStride = 3;
  private lastBackpressureCheck = 0;
  private lowFpsSinceMs = 0;
  private highFpsSinceMs = 0;
  private readonly BACKPRESSURE_CHECK_MS = 1000;
  private backpressureConfig: BackpressureConfig = { ...DEFAULT_BACKPRESSURE_CONFIG };

  // Buffer reutilizable de tiles (evita Array.from + map por frame).
  private readonly tileBuffer: { red: number; green: number; blue: number; count: number }[] =
    Array.from({ length: this.TILE_COLUMNS * this.TILE_ROWS }, () => ({ red: 0, green: 0, blue: 0, count: 0 }));

  // Buffer pre-asignado para tile metrics (evita map/filter chain en hot path).
  // Cada slot corresponde a un tile; se reutiliza cada frame.
  private readonly tileMetrics: {
    red: number; green: number; blue: number;
    total: number; redDominance: number; rednessRatio: number;
    centerBias: number; frameScore: number; combinedScore: number;
    valid: boolean; isFinger: boolean;
  }[] = Array.from({ length: this.TILE_COLUMNS * this.TILE_ROWS }, () => ({
    red: 0, green: 0, blue: 0,
    total: 0, redDominance: 0, rednessRatio: 0,
    centerBias: 0, frameScore: 0, combinedScore: 0,
    valid: false, isFinger: false,
  }));

  // Buffers (ring buffers Float32 — sin Array.shift O(n) por frame)
  private readonly rawBuffer = new RingF32(this.BUFFER_SIZE);
  private readonly filteredBuffer = new RingF32(this.BUFFER_SIZE);
  private readonly redBuffer = new RingF32(this.BUFFER_SIZE);
  private readonly greenBuffer = new RingF32(this.BUFFER_SIZE);
  private readonly blueBuffer = new RingF32(this.BUFFER_SIZE);
  private tileConfidence: number[] = new Array(25).fill(0);
  private readonly frameIntervalBuffer = new RingF32(30);

  // Scratch buffers reusables para stats (ACDC, SQI, source-score) — evita
  // `[...arr].sort()` por frame. Tamaño máximo = ACDC_WINDOW.
  private readonly statScratch = new Float32Array(this.ACDC_WINDOW);
  private readonly sortedScratch = new Float32Array(this.ACDC_WINDOW);

  // LUTs de teselado: cachean Math.floor((px / roiSize) * cols) por píxel
  // del ROI. Se reconstruyen sólo cuando cambia el tamaño del ROI.
  private tileXLut: Int8Array | null = null;
  private tileYLut: Int8Array | null = null;
  private tileLutKey = '';

  // AC/DC
  private redDC = 0;
  private redAC = 0;
  private greenDC = 0;
  private greenAC = 0;
  private blueDC = 0;
  private blueAC = 0;

  // Baselines dinámicas
  private redBaseline = 0;
  private greenBaseline = 0;
  private blueBaseline = 0;
  private estimatedSampleRate = 30;
  private lastFrameTimestamp = 0;

  private frameCount = 0;
  private lastLogTime = 0;

  // === ESTADO DE CONTACTO UNIFICADO ===
  private contactState: ContactState = 'NO_CONTACT';
  private fingerDetected = false;
  private signalQuality = 0;
  private fingerConfidenceCount = 0;
  private fingerLostCount = 0;
  private stableContactCount = 0;
  private instantLostStreak = 0;
  private lastInstantFinger = false;
  private readonly FINGER_CONFIRM_FRAMES = VITAL_THRESHOLDS.FINGER.FINGER_CONFIRM_FRAMES;

  // Suavizado temporal — más lentos = más estable
  private smoothedRed = 0;
  private smoothedGreen = 0;
  private smoothedBlue = 0;
  private smoothedCoverage = 0;
  private smoothedFingerScore = 0;
  private readonly RGB_SMOOTH_ALPHA = 0.07;
  private readonly COVERAGE_SMOOTH_ALPHA = 0.09;

  /** Ventana corta de R medio en ROI — CV temporal para distinguir tejido pulsátil vs. rojo estático */
  private readonly roiRedPulseRing = new RingF32(VITAL_THRESHOLDS.FINGER.ROI_PULSE_BUFFER);
  private lastRoiRedCv = 0;

  // IMU / Motion
  private motionScore = 0;
  private motionListenerActive = false;
  private lastAcceleration = { x: 0, y: 0, z: 0 };
  private readonly MOTION_THRESHOLD = VITAL_THRESHOLDS.QUALITY.MAX_MOTION;

  // Cache: PI se calcula una sola vez por frame y se reutiliza en SQI, contact state, etc.
  private cachedPI = 0;
  private underexposureEma = 0;
  // Cache de stats lentas (recomputadas cada N frames): evita slice+sort por frame
  // sobre ventanas estadísticas de 30-90 muestras que cambian lentamente.
  private cachedSqi = 0;
  private cachedPeriodicity = 0;
  private periodicityEma = 0;
  private displaySqiEma = 0;
  private consecutiveNoContactFrames = 0;
  private periodicitySkip = 0;
  private readonly diagStatusState: DiagnosticStatusState = createDiagnosticStatusState();

  // === MULTI-SOURCE RANKING (CHROM eliminado — amplifica ruido sin dedo) ===
  private readonly SOURCE_BUFFER_SIZE = 120;
  private readonly sourceBuffers: { [key: string]: RingF32 } = {
    R: new RingF32(this.SOURCE_BUFFER_SIZE),
    G: new RingF32(this.SOURCE_BUFFER_SIZE),
    RG: new RingF32(this.SOURCE_BUFFER_SIZE),
  };
  private activeSource: string = 'RG';
  private sourceScores: { [key: string]: number } = { R: 0, G: 0, RG: 0 };
  private lastSourceSwitch = 0;
  private readonly SOURCE_HYSTERESIS_MS = 2000;

  constructor(
    public onSignalReady?: (signal: ProcessedSignal) => void,
    public onError?: (error: ProcessingError) => void
  ) {
    this.bandpassFilter = new BandpassFilter(this.estimatedSampleRate);
  }

  async initialize(): Promise<void> {
    this.reset();
  }

  start(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.initialize();
    this.startMotionListener();
  }

  stop(): void {
    this.isProcessing = false;
    this.stopMotionListener();
  }

  async calibrate(): Promise<boolean> {
    return true;
  }

  processFrame(imageData: ImageData, frameTimestampMs?: number): void {
    if (!this.isProcessing || !this.onSignalReady) return;

    this.frameCount++;
    const timestamp = typeof frameTimestampMs === 'number' && Number.isFinite(frameTimestampMs)
      ? frameTimestampMs
      : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.updateSampleRate(timestamp);
    this.maybeAdaptBackpressure(timestamp);

    const endRoi = ppgPerf.start('roi');
    const roi = this.extractROI(imageData);
    endRoi();

    this.roiRedPulseRing.push(roi.rawRed);
    const Fpulse = VITAL_THRESHOLDS.FINGER;
    const nPulse = this.roiRedPulseRing.copyTailInto(this.statScratch, Fpulse.ROI_PULSE_BUFFER);
    this.lastRoiRedCv =
      nPulse >= Fpulse.ROI_PULSE_MIN_SAMPLES
        ? redSeriesCoefficientOfVariation(this.statScratch, nPulse)
        : 0;

    this.updateContactState(roi);

    const motionArtifact = this.motionScore > this.MOTION_THRESHOLD;

    if (this.contactState === 'NO_CONTACT') {
      this.consecutiveNoContactFrames++;
      this.signalQuality = 0;
      this.displaySqiEma = SignalQualityIndex.smoothDisplayedSqi(
        this.displaySqiEma,
        0,
        'NO_CONTACT',
      );
      Object.assign(this.diagStatusState, createDiagnosticStatusState());
      this.onSignalReady({
        timestamp,
        rawValue: 0,
        filteredValue: 0,
        quality: 0,
        fingerDetected: false,
        contactState: 'NO_CONTACT',
        motionArtifact,
        roi: this.signalRoiFromMetrics(roi),
        perfusionIndex: 0,
        rawRed: roi.rawRed,
        rawGreen: roi.rawGreen,
        diagnostics: this.buildFingerDiagnostics(roi, motionArtifact, "NO_FINGER"),
      });
      return;
    }

    // GATES DE RECHAZO ESTRICTOS (Phase 3C)
    let rejectionStatus: MeasurementStatus | null = null;
    const r = this.smoothedRed;
    const g = this.smoothedGreen;
    const b = this.smoothedBlue;

    const underInstant = r < 12 && g < 10 ? 1 : 0;
    this.underexposureEma = this.underexposureEma * 0.92 + underInstant * 0.08;
    
    if (r > 253 && g > 252) rejectionStatus = "SATURATED";
    else if (r < 15 && g < 10) rejectionStatus = "UNDEREXPOSED";
    else if (motionArtifact) rejectionStatus = "MOTION_ARTIFACT";
    else if (this.pixelStride > 6) rejectionStatus = "LOW_FPS";
    else if (this.frameCount < 28) rejectionStatus = "WARMUP";

    if (rejectionStatus && rejectionStatus !== "WARMUP" && rejectionStatus !== "MOTION_ARTIFACT") {
      this.onSignalReady({
        timestamp,
        rawValue: 0, filteredValue: 0, quality: 0,
        fingerDetected: true, contactState: this.contactState,
        motionArtifact,
        roi: this.signalRoiFromMetrics(roi),
        perfusionIndex: this.cachedPI,
        rawRed: roi.rawRed,
        rawGreen: roi.rawGreen,
        diagnostics: this.buildFingerDiagnostics(roi, motionArtifact, rejectionStatus, {
          message: `RECHAZADO: ${rejectionStatus}`,
        }),
      });
      // No retornamos aquí para permitir que los buffers sigan llenándose, pero la UI sabrá que no es válido
    }

    // Tenemos contacto (UNSTABLE o STABLE)
    this.updateChannelBaselines(roi.rawRed, roi.rawGreen, roi.rawBlue, motionArtifact);

    this.redBuffer.push(roi.rawRed);
    this.greenBuffer.push(roi.rawGreen);
    this.blueBuffer.push(roi.rawBlue);

    // ACDC: más frecuente con dedo para que PI/SQI no queden en 0 varios segundos
    if (this.redBuffer.length >= 36 && this.frameCount % 2 === 0) {
      this.calculateACDCPrecise();
    }
    const acPi = this.calculatePerfusionIndex();
    const pulsePi = this.estimatePulsePiFromRoi();
    this.cachedPI = Math.max(acPi, pulsePi);
    this.reconcileStableContact();

    // Multi-source extraction
    const pulseSource = this.extractBestPulseSignal(roi.rawRed, roi.rawGreen, roi.rawBlue, motionArtifact);

    this.rawBuffer.push(pulseSource.value);

    const endFilt = ppgPerf.start('bandpass');
    const filtered = this.bandpassFilter.filter(pulseSource.value);
    endFilt();
    this.filteredBuffer.push(filtered);

    const endSqi = ppgPerf.start('sqi');
    this.periodicitySkip++;
    if (this.periodicitySkip >= 4 || this.filteredBuffer.length < 90) {
      this.periodicitySkip = 0;
      const pInstant = this.calculatePeriodicity();
      this.periodicityEma =
        this.periodicityEma <= 0
          ? pInstant
          : this.periodicityEma * 0.72 + pInstant * 0.28;
    }
    this.cachedPeriodicity = this.periodicityEma;

    const snapPerf = ppgPerf.snapshot();
    const metrics: SignalQualityMetrics = {
      sqi: 0,
      perfusionIndex: this.cachedPI,
      snr: pulseSource.strength,
      periodicity: this.cachedPeriodicity,
      motionScore: this.motionScore,
      saturationRatio: roi.rawRed > 250 ? 1 : 0,
      underexposureRatio: this.underexposureEma,
      frameDropRatio: snapPerf.droppedEstimate / Math.max(1, this.frameCount),
      fpsEffective: this.estimatedSampleRate,
      timestampJitterMs: snapPerf.jitterMs,
    };

    this.cachedSqi = SignalQualityIndex.calculate(metrics);
    this.signalQuality = this.cachedSqi;

    const rejectionScale =
      rejectionStatus === 'MOTION_ARTIFACT'
        ? 0.78
        : rejectionStatus && rejectionStatus !== 'WARMUP'
          ? 0.45
          : 1;
    this.displaySqiEma = SignalQualityIndex.smoothDisplayedSqi(
      this.displaySqiEma,
      this.signalQuality,
      this.contactState,
      rejectionScale,
    );
    endSqi();

    const perfusionIndex = this.cachedPI;
    const displayQuality = this.displaySqiEma;

    const now = timestamp;
    if (now - this.lastLogTime >= 2000) {
      this.lastLogTime = now;
      const snap = ppgPerf.snapshot();
      log.info(
        `[${pulseSource.label}] Filt=${filtered.toFixed(3)} Q=${displayQuality} raw=${this.signalQuality} ` +
        `PI=${perfusionIndex.toFixed(4)} P=${this.cachedPeriodicity.toFixed(2)} Contact=${this.contactState} ` +
        `FPS=${snap.fps.toFixed(1)} jitter=${snap.jitterMs.toFixed(1)}ms ` +
        `roi=${(snap.stages.roi?.p95 ?? 0).toFixed(2)}ms ` +
        `filt=${(snap.stages.bandpass?.p95 ?? 0).toFixed(2)}ms ` +
        `sqi=${(snap.stages.sqi?.p95 ?? 0).toFixed(2)}ms ` +
        `dropEst=${snap.droppedEstimate}`
      );
    }

    const displayStatus = SignalQualityIndex.resolveDiagnosticDisplayStatus(
      this.diagStatusState,
      {
        rejectionStatus,
        rawSqi: this.signalQuality,
        pi: perfusionIndex,
        fingerDetected: this.fingerDetected,
        contactState: this.contactState,
      },
    );

    this.onSignalReady({
      timestamp,
      rawValue: pulseSource.value,
      filteredValue: filtered,
      quality: displayQuality,
      fingerDetected: this.fingerDetected,
      contactState: this.contactState,
      motionArtifact,
      roi: this.signalRoiFromMetrics(roi),
      perfusionIndex,
      rawRed: roi.rawRed,
      rawGreen: roi.rawGreen,
      diagnostics: {
        ...this.buildFingerDiagnostics(roi, motionArtifact, displayStatus, {
          message:
            `${pulseSource.label}:${pulseSource.strength.toFixed(1)} ` +
            `PI:${perfusionIndex.toFixed(2)} SQI:${Math.round(this.diagStatusState.smoothedSqi)} ` +
            `C:${(roi.coverageRatio * 100).toFixed(0)}% ${this.contactState}${motionArtifact ? ' MOV' : ''}`,
          hasPulsatility:
            SignalQualityIndex.isClinicallyValid(this.signalQuality, perfusionIndex) ||
            SignalQualityIndex.isAdequateForLiveVitals(this.signalQuality, perfusionIndex),
          pulsatilityValue:
            this.contactState === 'STABLE_CONTACT'
              ? Math.max(perfusionIndex, pulseSource.strength * 0.02)
              : 0,
        }),
        sqm: {
          sqi: this.signalQuality,
          perfusionIndex: perfusionIndex,
          snr: pulseSource.strength,
          periodicity: this.cachedPeriodicity,
          motionScore: this.motionScore,
          saturationRatio: (roi.rawRed > 250 ? 1 : 0),
          underexposureRatio: this.underexposureEma,
          fpsEffective: this.estimatedSampleRate,
          frameDropRatio: ppgPerf.snapshot().droppedEstimate / Math.max(1, this.frameCount),
          timestampJitterMs: ppgPerf.snapshot().jitterMs,
        } as SignalQualityMetrics,
      },
    });
  }

  // === ESTADO DE CONTACTO UNIFICADO ===
  private updateContactState(roi: ROIMetrics): void {
    const previousState = this.contactState;
    const F = VITAL_THRESHOLDS.FINGER;
    const instantDetected = this.detectFingerInstant(roi);
    this.lastInstantFinger = instantDetected;

    if (instantDetected) {
      this.instantLostStreak = 0;
      this.fingerLostCount = 0;
      this.fingerConfidenceCount = Math.min(this.fingerConfidenceCount + 1, 100);
      this.stableContactCount++;

      if (this.fingerConfidenceCount >= this.FINGER_CONFIRM_FRAMES) {
        this.fingerDetected = true;
        this.contactState = 'UNSTABLE_CONTACT';
      }
    } else {
      this.instantLostStreak++;
      this.fingerConfidenceCount = Math.max(0, this.fingerConfidenceCount - 1);
      this.fingerLostCount++;
      this.stableContactCount = Math.max(0, this.stableContactCount - 1);

      const snap = this.rgbSnapshotFromRoi(roi);
      const softHold =
        this.fingerDetected &&
        this.instantLostStreak < F.INSTANT_LOST_TO_UNSTABLE &&
        hasFingerHemoglobinSignature(snap);

      if (softHold) {
        this.contactState = 'UNSTABLE_CONTACT';
      } else if (
        this.fingerDetected &&
        this.instantLostStreak < F.INSTANT_LOST_TO_NO_CONTACT &&
        this.fingerLostCount < F.FINGER_LOST_FRAMES_UI
      ) {
        this.contactState = 'UNSTABLE_CONTACT';
      } else if (
        this.fingerDetected &&
        this.fingerLostCount < F.UNSTABLE_GRACE_FRAMES
      ) {
        this.contactState = 'UNSTABLE_CONTACT';
      } else {
        this.forceNoContact();
      }
    }

    if (previousState === 'NO_CONTACT' && this.contactState !== 'NO_CONTACT') {
      const minGap = VITAL_THRESHOLDS.QUALITY.BUFFER_RESET_AFTER_NO_CONTACT_FRAMES;
      if (this.consecutiveNoContactFrames >= minGap) {
        this.resetSignalTrackingBuffers();
      }
      this.consecutiveNoContactFrames = 0;
    } else if (this.contactState !== 'NO_CONTACT') {
      this.consecutiveNoContactFrames = 0;
    }
  }

  /** STABLE solo con PI real ya calculado en este frame (no en updateContactState). */
  private reconcileStableContact(): void {
    if (!this.fingerDetected || !this.lastInstantFinger) {
      if (this.contactState === 'STABLE_CONTACT') {
        this.contactState = 'UNSTABLE_CONTACT';
      }
      return;
    }
    const minPi = VITAL_THRESHOLDS.QUALITY.MIN_PI;
    const F = VITAL_THRESHOLDS.FINGER;
    const pulseOk =
      this.lastRoiRedCv >= F.ROI_RED_CV_MIN * 0.82 &&
      this.smoothedCoverage >= F.MIN_COVERAGE * 0.9;
    const piOk = this.cachedPI >= minPi * 0.75;
    const stable =
      this.stableContactCount >= VITAL_THRESHOLDS.QUALITY.STABLE_FRAMES_REQ &&
      (piOk || pulseOk) &&
      this.smoothedCoverage >= F.MIN_COVERAGE * 0.88;
    this.contactState = stable ? 'STABLE_CONTACT' : 'UNSTABLE_CONTACT';
  }

  private forceNoContact(): void {
    this.contactState = 'NO_CONTACT';
    this.fingerDetected = false;
    this.fingerConfidenceCount = 0;
    this.stableContactCount = 0;
    this.instantLostStreak = 0;
    this.lastInstantFinger = false;
    this.decaySmoothedRgbFast();
    this.resetSignalTrackingBuffers();
    this.resetBaselines();
    this.roiRedPulseRing.reset();
    this.lastRoiRedCv = 0;
  }

  private decaySmoothedRgbFast(): void {
    const k = 0.55;
    this.smoothedRed *= 1 - k;
    this.smoothedGreen *= 1 - k;
    this.smoothedBlue *= 1 - k;
    this.smoothedCoverage *= 1 - k;
    this.smoothedFingerScore *= 1 - k;
    if (this.smoothedRed < 2) this.smoothedRed = 0;
    if (this.smoothedCoverage < 0.02) this.smoothedCoverage = 0;
  }

  private rgbSnapshotFromRoi(roi: ROIMetrics) {
    return {
      red: this.smoothedRed || roi.rawRed,
      green: this.smoothedGreen || roi.rawGreen,
      blue: this.smoothedBlue || roi.rawBlue,
      coverage: roi.coverageRatio,
      fingerScore: roi.fingerScore,
    };
  }

  private detectFingerInstant(roi: ROIMetrics): boolean {
    const F = VITAL_THRESHOLDS.FINGER;
    const { rawRed, rawGreen, rawBlue, coverageRatio, fingerScore } = roi;

    if (this.smoothedRed === 0) {
      this.smoothedRed = rawRed;
      this.smoothedGreen = rawGreen;
      this.smoothedBlue = rawBlue;
      this.smoothedCoverage = coverageRatio;
      this.smoothedFingerScore = fingerScore;
    } else {
      const a = this.RGB_SMOOTH_ALPHA;
      const ca = this.COVERAGE_SMOOTH_ALPHA;
      this.smoothedRed = this.smoothedRed * (1 - a) + rawRed * a;
      this.smoothedGreen = this.smoothedGreen * (1 - a) + rawGreen * a;
      this.smoothedBlue = this.smoothedBlue * (1 - a) + rawBlue * a;
      this.smoothedCoverage = this.smoothedCoverage * (1 - ca) + coverageRatio * ca;
      this.smoothedFingerScore = this.smoothedFingerScore * (1 - ca) + fingerScore * ca;
    }

    const snap = this.rgbSnapshotFromRoi(roi);
    if (!hasFingerHemoglobinSignature(snap)) {
      return false;
    }

    const r = snap.red;
    const g = Math.max(1, snap.green);
    const b = Math.max(1, snap.blue);
    const totalIntensity = r + g + b;
    const redDominance = r - (g + b) / 2;
    const rgRatio = r / g;
    const rbRatio = r / b;
    const notBlownOut = !(r > 254 && g > 254 && b > 254);
    if (!notBlownOut || this.motionScore > F.ACQUIRE_MAX_MOTION_SOFT) {
      return false;
    }

    if (this.fingerDetected) {
      return (
        hasFingerHemoglobinSignature({
          red: rawRed,
          green: rawGreen,
          blue: rawBlue,
          coverage: coverageRatio,
          fingerScore,
        }) &&
        (rbRatio >= F.MAINTAIN_RB || this.cachedPI > F.PULSE_HOLD_MIN_PI)
      );
    }

    const strictAcquire =
      rbRatio >= F.ACQUIRE_RB_STRICT &&
      totalIntensity >= F.ACQUIRE_INTENSITY_MIN &&
      totalIntensity <= F.ACQUIRE_INTENSITY_MAX &&
      this.smoothedCoverage >= F.MIN_COVERAGE &&
      this.smoothedFingerScore >= F.ACQUIRE_SMOOTHED_FINGER_MIN;

    const softAcquire =
      rbRatio >= F.ACQUIRE_SOFT_RB &&
      totalIntensity >= F.ACQUIRE_SOFT_INTENSITY_MIN &&
      this.smoothedCoverage >= F.MIN_COVERAGE * F.SOFT_COVERAGE_MULT &&
      roi.fingerScore >= F.ACQUIRE_SOFT_FINGER_SCORE_ROI &&
      redDominance >= F.ACQUIRE_SOFT_DOMINANCE;

    const pulsatileAcquire =
      this.lastRoiRedCv >= F.ROI_RED_CV_MIN &&
      rbRatio >= F.HEMOGLOBIN_MIN_RB &&
      this.smoothedCoverage >= F.PULSATILE_ACQUIRE_COVERAGE &&
      roi.fingerScore >= F.PULSATILE_ACQUIRE_FINGER_ROI &&
      redDominance >= F.PULSATILE_ACQUIRE_MIN_DOMINANCE;

    return strictAcquire || softAcquire || pulsatileAcquire;
  }

  private computeRoiRect(width: number, height: number) {
    const roiSize = Math.min(width, height) * VITAL_THRESHOLDS.FINGER.ROI_SIZE_FRACTION;
    const startX = Math.floor((width - roiSize) / 2);
    const startY = Math.floor((height - roiSize) / 2);
    const side = Math.floor(roiSize);
    return { startX, startY, endX: startX + side, endY: startY + side, roiW: side, roiH: side };
  }

  private signalRoiFromMetrics(roi: ROIMetrics) {
    return { x: roi.roiX, y: roi.roiY, width: roi.roiW, height: roi.roiH };
  }

  private buildFingerDiagnostics(
    roi: ROIMetrics,
    motionArtifact: boolean,
    status: MeasurementStatus,
    extras?: {
      message?: string;
      hasPulsatility?: boolean;
      pulsatilityValue?: number;
    },
  ) {
    const coverageRatio = roi.coverageRatio;
    return {
      message:
        extras?.message ??
        `BUSCANDO DEDO · cobertura ${(coverageRatio * 100).toFixed(0)}%`,
      hasPulsatility: extras?.hasPulsatility ?? false,
      pulsatilityValue: extras?.pulsatilityValue ?? 0,
      coverageRatio,
      status,
    };
  }

  private updateSampleRate(timestamp: number): void {
    if (this.lastFrameTimestamp === 0) {
      this.lastFrameTimestamp = timestamp;
      return;
    }

    const delta = timestamp - this.lastFrameTimestamp;
    this.lastFrameTimestamp = timestamp;

    if (delta < 10 || delta > 100) return;

    this.frameIntervalBuffer.push(delta);

    if (this.frameIntervalBuffer.length < 8) return;

    // Median FPS drifts slowly — recompute every 10 frames.
    if (this.frameCount % 10 !== 0) return;

    const fiTail = this.frameIntervalBuffer.tail(this.frameIntervalBuffer.length);
    fiTail.sort((a, b) => a - b);
    const median = fiTail[Math.floor(fiTail.length / 2)] ?? 33;
    const estimatedFps = clamp(1000 / median, 20, 40);

    if (Math.abs(estimatedFps - this.estimatedSampleRate) > 2) {
      this.estimatedSampleRate = estimatedFps;
      this.bandpassFilter.setSampleRate(this.estimatedSampleRate);
    }
  }

  private extractROI(imageData: ImageData): ROIMetrics {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    const { startX, startY, endX, endY, roiW, roiH } = this.computeRoiRect(width, height);

    // Reset reusable tile buffer (no GC churn por frame)
    const tiles = this.tileBuffer;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      t.red = 0; t.green = 0; t.blue = 0; t.count = 0;
    }

    const roiWidth = Math.max(1, endX - startX);
    const roiHeight = Math.max(1, endY - startY);

    // Sample every Nth pixel — N adaptativo (3 normal, 4 bajo backpressure)
    const stride = this.pixelStride;
    for (let y = startY; y < endY; y += stride) {
      for (let x = startX; x < endX; x += stride) {
        const i = (y * width + x) * 4;
        const tileX = Math.min(this.TILE_COLUMNS - 1, Math.floor(((x - startX) / roiWidth) * this.TILE_COLUMNS));
        const tileY = Math.min(this.TILE_ROWS - 1, Math.floor(((y - startY) / roiHeight) * this.TILE_ROWS));
        const tile = tiles[tileY * this.TILE_COLUMNS + tileX];

        tile.red += data[i];
        tile.green += data[i + 1];
        tile.blue += data[i + 2];
        tile.count++;
      }
    }

    // Reducir tiles a métricas en buffer pre-asignado — sin allocs por frame.
    const F = VITAL_THRESHOLDS.FINGER;
    const metrics = this.tileMetrics;
    const N = tiles.length;
    let validCount = 0;
    let fingerCount = 0;
    let fingerScoreSum = 0;

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
        1,
      );

      const brightnessScore = clamp((total - F.TILE_BRIGHTNESS_OFFSET) / 250, 0, 1);
      const redRatioScore = clamp((rednessRatio - 1.01) / 0.88, 0, 1);
      const domOff = F.TILE_DOMINANCE_SCORE_OFFSET;
      const dominanceScore = clamp((redDominance - domOff) / 32, 0, 1);
      const frameScore = redRatioScore * 0.45 + dominanceScore * 0.4 + brightnessScore * 0.15;

      this.tileConfidence[i] = this.tileConfidence[i] * 0.75 + frameScore * centerBias * 0.25;
      const combinedScore = this.tileConfidence[i] * 0.7 + frameScore * 0.3;

      m.red = red; m.green = green; m.blue = blue;
      m.total = total; m.redDominance = redDominance; m.rednessRatio = rednessRatio;
      m.centerBias = centerBias; m.frameScore = frameScore; m.combinedScore = combinedScore;
      m.valid = true;
      m.isFinger =
        red > F.TILE_MIN_RED &&
        total > F.TILE_MIN_TOTAL &&
        redDominance > F.TILE_MIN_DOMINANCE &&
        rednessRatio > F.TILE_MIN_RG &&
        combinedScore > F.TILE_MIN_COMBINED_SCORE;
      validCount++;
      if (m.isFinger) {
        fingerCount++;
        fingerScoreSum += combinedScore;
      }
    }

    if (validCount === 0) {
      return {
        rawRed: 0,
        rawGreen: 0,
        rawBlue: 0,
        coverageRatio: 0,
        fingerScore: 0,
        roiX: startX,
        roiY: startY,
        roiW,
        roiH,
      };
    }

    const useFingerOnly = fingerCount >= F.MIN_FINGER_TILES_FOR_WEIGHTING;
    let rWs = 0, gWs = 0, bWs = 0, tw = 0;
    
    // MEJORA: Ponderación adaptativa por SNR individual de celda
    for (let i = 0; i < N; i++) {
      const m = metrics[i];
      if (!m.valid) continue;
      if (useFingerOnly && !m.isFinger) continue;
      
      // La confianza combinada incluye centerBias y estabilidad temporal
      const snrWeight = 0.2 + m.combinedScore * 2.5 + m.centerBias * 0.5;
      
      rWs += m.red * snrWeight;
      gWs += m.green * snrWeight;
      bWs += m.blue * snrWeight;
      tw += snrWeight;
    }

    const rawRed = tw > 0 ? rWs / tw : 0;
    const rawGreen = tw > 0 ? gWs / tw : 0;
    const rawBlue = tw > 0 ? bWs / tw : 0;

    return {
      rawRed,
      rawGreen,
      rawBlue,
      coverageRatio: fingerCount / validCount,
      fingerScore: fingerCount > 0 ? fingerScoreSum / fingerCount : 0,
      roiX: startX,
      roiY: startY,
      roiW,
      roiH,
    };
  }

  private updateChannelBaselines(rawRed: number, rawGreen: number, rawBlue: number, motionArtifact: boolean): void {
    if (this.redBaseline === 0) {
      this.redBaseline = rawRed;
      this.greenBaseline = rawGreen;
      this.blueBaseline = rawBlue;
      return;
    }

    const alpha = motionArtifact ? 0.008 : this.contactState === 'STABLE_CONTACT' ? 0.02 : 0.04;
    this.redBaseline = this.redBaseline * (1 - alpha) + rawRed * alpha;
    this.greenBaseline = this.greenBaseline * (1 - alpha) + rawGreen * alpha;
    this.blueBaseline = this.blueBaseline * (1 - alpha) + rawBlue * alpha;
  }

  // === MULTI-SOURCE COMPETITIVE EXTRACTION ===
  private extractBestPulseSignal(
    rawRed: number, rawGreen: number, rawBlue: number, motionArtifact: boolean
  ): { value: number; label: string; strength: number } {
    const rNorm = this.redBaseline > 0 ? (this.redBaseline - rawRed) / this.redBaseline : 0;
    const gNorm = this.greenBaseline > 0 ? (this.greenBaseline - rawGreen) / this.greenBaseline : 0;
    const bNorm = this.blueBaseline > 0 ? (this.blueBaseline - rawBlue) / this.blueBaseline : 0;

    const clampPulse = (v: number) => clamp(v, -0.04, 0.04);
    const rPulse = clampPulse(rNorm);
    const gPulse = clampPulse(gNorm);

    // Source candidates (CHROM removed — amplifies noise without finger)
    const sources: { [key: string]: number } = {
      R: rPulse * 3800,
      G: gPulse * 3800,
      RG: this.blendRG(rPulse, gPulse, rawRed, rawGreen, motionArtifact) * 3800,
    };

    // Update per-source buffers (ring auto-evicts más viejo)
    this.sourceBuffers.R.push(sources.R);
    this.sourceBuffers.G.push(sources.G);
    this.sourceBuffers.RG.push(sources.RG);

    // Rank sources every ~1 second (30 frames)
    if (this.frameCount % 30 === 0 && this.redBuffer.length >= 60) {
      this.rankSources();
    }

    const value = clamp(sources[this.activeSource] ?? sources['RG'], -80, 80);
    const strength = Math.max(Math.abs(rPulse), Math.abs(gPulse)) * 1000;

    return { value, label: this.activeSource, strength };
  }

  private blendRG(rPulse: number, gPulse: number, rawRed: number, rawGreen: number, motionArtifact: boolean): number {
    const redPI = this.redDC > 0 ? this.redAC / this.redDC : 0;
    const greenPI = this.greenDC > 0 ? this.greenAC / this.greenDC : 0;
    const piSum = redPI + greenPI;

    let greenWeight = 0.65; // Favor Green (mejor SNR para HR)
    let redWeight = 0.35;

    if (piSum > 0) {
      greenWeight = clamp(greenPI / piSum, 0.4, 0.9);
      redWeight = 1 - greenWeight;
    }

    // Clipping penalties - muy agresivos para evitar picos falsos
    if (rawGreen > 248) { greenWeight = 0.1; redWeight = 0.9; }
    else if (rawRed > 248) { redWeight = 0.1; greenWeight = 0.9; }
    
    if (this.contactState === 'STABLE_CONTACT' && !motionArtifact) {
      // En estado estable, el canal verde es el estándar de oro para BPM
      greenWeight = clamp(greenWeight + 0.15, 0.6, 0.95);
      redWeight = 1 - greenWeight;
    }

    return rPulse * redWeight + gPulse * greenWeight;
  }

  private rankSources(): void {
    const now = Date.now();
    // Hysteresis: don't switch too often
    if (now - this.lastSourceSwitch < this.SOURCE_HYSTERESIS_MS) return;

    let bestSource = this.activeSource;
    let bestScore = -1;

    for (const key of Object.keys(this.sourceBuffers)) {
      const buf = this.sourceBuffers[key];
      if (buf.length < 45) continue;

      const recent = buf.tail(90);
      const score = this.computeSourceScore(recent);
      this.sourceScores[key] = score;

      if (score > bestScore) {
        bestScore = score;
        bestSource = key;
      }
    }

    // Only switch if new source is significantly better (>20%)
    const currentScore = this.sourceScores[this.activeSource] ?? 0;
    if (bestSource !== this.activeSource && bestScore > currentScore * 1.2) {
      this.activeSource = bestSource;
      this.lastSourceSwitch = now;
    }
  }

  private computeSourceScore(buffer: number[]): number {
    if (buffer.length < 30) return 0;

    const sorted = [...buffer].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    const range = p90 - p10;
    if (range < 0.3) return 0;

    const mean = buffer.reduce((a, b) => a + b, 0) / buffer.length;
    const variance = buffer.reduce((a, v) => a + (v - mean) ** 2, 0) / buffer.length;
    const snr = range / (Math.sqrt(variance) + 0.1);

    // Check for clipping
    const clipped = buffer.filter(v => Math.abs(v) > 70).length / buffer.length;
    const clipPenalty = clipped * 30;

    return Math.max(0, snr * 15 - clipPenalty);
  }

  private calculateACDCPrecise(): void {
    const windowSize = Math.min(this.ACDC_WINDOW, this.redBuffer.length);
    if (windowSize < 36) return;

    const redW = this.redBuffer.tail(windowSize);
    const greenW = this.greenBuffer.tail(windowSize);
    const blueW = this.blueBuffer.tail(windowSize);

    this.redDC = redW.reduce((a, b) => a + b, 0) / redW.length;
    this.greenDC = greenW.reduce((a, b) => a + b, 0) / greenW.length;
    this.blueDC = blueW.reduce((a, b) => a + b, 0) / blueW.length;

    if (this.redDC < 5 || this.greenDC < 5) return;

    const sortedScratch = this.sortedScratch;
    const computeAC = (window: number[], dc: number) => {
      let sumSq = 0;
      const n = window.length;
      for (let i = 0; i < n; i++) {
        const d = window[i] - dc;
        sumSq += d * d;
        sortedScratch[i] = window[i];
      }
      const rms = Math.sqrt(sumSq / n);
      // In-place sort sobre la porción usada del scratch (sin alocar).
      const view = sortedScratch.subarray(0, n);
      view.sort();
      const p5 = view[Math.floor(n * 0.05)] ?? 0;
      const p95 = view[Math.floor(n * 0.95)] ?? 0;
      const p2p = p95 - p5;
      return (rms * Math.sqrt(2) + p2p * 0.5) / 2;
    };

    this.redAC = computeAC(redW, this.redDC);
    this.greenAC = computeAC(greenW, this.greenDC);
    this.blueAC = computeAC(blueW, this.blueDC);

    const redPI = this.redAC / this.redDC;
    const greenPI = this.greenAC / this.greenDC;

    if (redPI < 0.0001 || greenPI < 0.0001) {
      this.redAC = 0;
      this.greenAC = 0;
    }
  }

  /**
   * Calcula la periodicidad de la señal mediante autocorrelación simplificada.
   * Un valor cercano a 1 indica una señal rítmica (pulso cardíaco).
   * ZERO-ALLOCATION: Usa copyTailInto para evitar alocar number[] en cada frame.
   */
  private calculatePeriodicity(): number {
    const nReq = 90;
    if (this.filteredBuffer.length < nReq) return 0;
    
    // Usamos sortedScratch como buffer temporal para no alocar
    const n = this.filteredBuffer.copyTailInto(this.sortedScratch, nReq);
    const data = this.sortedScratch;
    
    // Autocorrelación para el lag de un pulso típico (0.5s a 1.2s @ 30fps -> lag 15 a 36)
    let maxCorr = 0;
    for (let lag = 15; lag <= 36; lag++) {
      let dot = 0;
      let magA = 0;
      let magB = 0;
      for (let i = 0; i < n - lag; i++) {
        dot += data[i] * data[i + lag];
        magA += data[i] * data[i];
        magB += data[i + lag] * data[i + lag];
      }
      if (magA > 0 && magB > 0) {
        const corr = dot / Math.sqrt(magA * magB);
        if (corr > maxCorr) maxCorr = corr;
      }
    }
    return maxCorr;
  }

  private calculatePerfusionIndex(): number {
    // PI como ratio (0.0-1.0), NO porcentaje. La UI multiplica *100 para display.
    if (this.greenDC > 0) return this.greenAC / this.greenDC;
    if (this.redDC > 0) return this.redAC / this.redDC;
    return 0;
  }

  /** PI proxy desde CV temporal del ROI (antes de que ACDC llene la ventana). */
  private estimatePulsePiFromRoi(): number {
    const cv = this.lastRoiRedCv;
    if (cv < VITAL_THRESHOLDS.FINGER.ROI_RED_CV_MIN * 0.65) return 0;
    return clamp(cv * 0.018, 0.00015, 0.012);
  }

  private resetBaselines(): void {
    this.redBaseline = 0;
    this.greenBaseline = 0;
    this.blueBaseline = 0;
  }

  private resetSignalTrackingBuffers(): void {
    this.rawBuffer.reset();
    this.filteredBuffer.reset();
    this.redBuffer.reset();
    this.greenBuffer.reset();
    this.blueBuffer.reset();
    this.redDC = 0; this.redAC = 0;
    this.greenDC = 0; this.greenAC = 0;
    this.blueDC = 0; this.blueAC = 0;
    this.sourceBuffers.R.reset();
    this.sourceBuffers.G.reset();
    this.sourceBuffers.RG.reset();
    this.bandpassFilter.reset();
    this.roiRedPulseRing.reset();
    this.lastRoiRedCv = 0;
  }

  reset(): void {
    this.rawBuffer.reset();
    this.filteredBuffer.reset();
    this.redBuffer.reset();
    this.greenBuffer.reset();
    this.blueBuffer.reset();
    this.tileConfidence = new Array(25).fill(0);
    this.frameIntervalBuffer.reset();
    this.frameCount = 0;
    this.lastLogTime = 0;
    this.lastFrameTimestamp = 0;
    this.estimatedSampleRate = 30;
    this.fingerDetected = false;
    this.contactState = 'NO_CONTACT';
    this.signalQuality = 0;
    this.cachedSqi = 0;
    this.cachedPI = 0;
    this.cachedPeriodicity = 0;
    this.periodicityEma = 0;
    this.displaySqiEma = 0;
    this.consecutiveNoContactFrames = 0;
    this.periodicitySkip = 0;
    Object.assign(this.diagStatusState, createDiagnosticStatusState());
    this.underexposureEma = 0;
    this.fingerConfidenceCount = 0;
    this.fingerLostCount = 0;
    this.stableContactCount = 0;
    this.instantLostStreak = 0;
    this.lastInstantFinger = false;
    this.smoothedRed = 0;
    this.smoothedGreen = 0;
    this.smoothedBlue = 0;
    this.smoothedCoverage = 0;
    this.smoothedFingerScore = 0;
    this.redDC = 0; this.redAC = 0;
    this.greenDC = 0; this.greenAC = 0;
    this.blueDC = 0; this.blueAC = 0;
    this.motionScore = 0;
    this.lastAcceleration = { x: 0, y: 0, z: 0 };
    this.sourceBuffers.R.reset();
    this.sourceBuffers.G.reset();
    this.sourceBuffers.RG.reset();
    this.sourceScores = { R: 0, G: 0, RG: 0 };
    this.activeSource = 'RG';
    this.lastSourceSwitch = 0;
    this.resetBaselines();
    this.roiRedPulseRing.reset();
    this.lastRoiRedCv = 0;
    this.bandpassFilter.setSampleRate(this.estimatedSampleRate);
    this.bandpassFilter.reset();
  }

  private handleMotionEvent = (event: DeviceMotionEvent) => {
    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x === null || acc.y === null || acc.z === null) return;

    const dx = (acc.x ?? 0) - this.lastAcceleration.x;
    const dy = (acc.y ?? 0) - this.lastAcceleration.y;
    const dz = (acc.z ?? 0) - this.lastAcceleration.z;

    this.lastAcceleration = { x: acc.x ?? 0, y: acc.y ?? 0, z: acc.z ?? 0 };

    const accelRMS = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const rot = event.rotationRate;
    let gyroRMS = 0;

    if (rot && rot.alpha !== null && rot.beta !== null && rot.gamma !== null) {
      gyroRMS = Math.sqrt((rot.alpha ?? 0) ** 2 + (rot.beta ?? 0) ** 2 + (rot.gamma ?? 0) ** 2) / 120;
    }

    const rawScore = accelRMS * 0.5 + gyroRMS * 0.3;
    this.motionScore = this.motionScore * 0.85 + rawScore * 0.15;
  };

  private startMotionListener(): void {
    if (this.motionListenerActive) return;
    try {
      if (typeof DeviceMotionEvent !== 'undefined') {
        const dme = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
        if (typeof dme.requestPermission === 'function') {
          dme.requestPermission()
            .then((state: string) => {
              if (state === 'granted') {
                window.addEventListener('devicemotion', this.handleMotionEvent, { passive: true });
                this.motionListenerActive = true;
              }
            })
            .catch(() => { /* Permission denied — ignore silently */ });
        } else {
          window.addEventListener('devicemotion', this.handleMotionEvent, { passive: true });
          this.motionListenerActive = true;
        }
      }
    } catch { /* DeviceMotion not supported — ignore silently */ }
  }

  private stopMotionListener(): void {
    if (!this.motionListenerActive) return;
    window.removeEventListener('devicemotion', this.handleMotionEvent);
    this.motionListenerActive = false;
    this.motionScore = 0;
  }

  // clamp() importado desde utils/math.ts

  /**
   * Backpressure: si el fps real cae por debajo de 20 durante > 3s, sube el
   * stride espacial a 4 (≈1.78× más rápido el bucle de píxeles). Cuando el fps
   * vuelve a >= 25 sostenido > 3s, restaura stride 3. No toca el resto del
   * pipeline ni la frecuencia temporal de muestreo.
   */
  private maybeAdaptBackpressure(nowMs: number): void {
    if (nowMs - this.lastBackpressureCheck < this.BACKPRESSURE_CHECK_MS) return;
    this.lastBackpressureCheck = nowMs;
    const cfg = this.backpressureConfig;

    // Stride forzado (modo manual / test) — bypass total.
    if (typeof cfg.forceStride === 'number') {
      if (this.pixelStride !== cfg.forceStride) {
        this.pixelStride = cfg.forceStride;
        log.info(`Backpressure FORCED stride=${this.pixelStride}`);
      }
      this.lowFpsSinceMs = 0; this.highFpsSinceMs = 0;
      return;
    }

    // Adaptación deshabilitada → vuelve a baseline (3) y no toca más.
    if (!cfg.enabled) {
      if (this.pixelStride !== 3) {
        this.pixelStride = 3;
        log.info('Backpressure DISABLED — stride reset to 3');
      }
      this.lowFpsSinceMs = 0; this.highFpsSinceMs = 0;
      return;
    }

    const fps = ppgPerf.snapshot().fps;
    if (fps <= 0) return;

    if (fps < cfg.lowFpsThreshold) {
      this.highFpsSinceMs = 0;
      if (this.lowFpsSinceMs === 0) this.lowFpsSinceMs = nowMs;
      else if (this.pixelStride < cfg.maxStride && nowMs - this.lowFpsSinceMs >= cfg.sustainMs) {
        this.pixelStride = Math.min(cfg.maxStride, this.pixelStride + 1);
        log.warn(`Backpressure ON — fps=${fps.toFixed(1)} stride=${this.pixelStride}`);
      }
    } else if (fps >= cfg.highFpsThreshold) {
      this.lowFpsSinceMs = 0;
      if (this.highFpsSinceMs === 0) this.highFpsSinceMs = nowMs;
      else if (this.pixelStride > 3 && nowMs - this.highFpsSinceMs >= cfg.sustainMs) {
        this.pixelStride = Math.max(3, this.pixelStride - 1);
        log.info(`Backpressure OFF — fps=${fps.toFixed(1)} stride=${this.pixelStride}`);
      }
    } else {
      this.lowFpsSinceMs = 0;
      this.highFpsSinceMs = 0;
    }
  }

  getRGBStats() {
    return {
      redAC: this.redAC, redDC: this.redDC,
      greenAC: this.greenAC, greenDC: this.greenDC,
      rgRatio: this.greenDC > 0 ? this.redDC / this.greenDC : 0,
      ratioOfRatios: this.greenDC > 0 && this.greenAC > 0 && this.redDC > 0
        ? (this.redAC / this.redDC) / (this.greenAC / this.greenDC)
        : 0,
    };
  }

  /** Estado actual del backpressure adaptativo (para telemetría). */
  getBackpressureState() {
    return {
      pixelStride: this.pixelStride,
      estimatedSampleRate: this.estimatedSampleRate,
      activeSource: this.activeSource,
      config: { ...this.backpressureConfig },
    };
  }

  /** Aplica una nueva configuración de backpressure (saneada). */
  setBackpressureConfig(partial: Partial<BackpressureConfig>): BackpressureConfig {
    this.backpressureConfig = sanitizeBackpressureConfig({ ...this.backpressureConfig, ...partial });
    // Forzar re-evaluación inmediata
    this.lastBackpressureCheck = 0;
    this.maybeAdaptBackpressure(typeof performance !== 'undefined' ? performance.now() : Date.now());
    return { ...this.backpressureConfig };
  }

  getBackpressureConfig(): BackpressureConfig {
    return { ...this.backpressureConfig };
  }
}
