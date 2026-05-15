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

const log = createLogger('PPGSignalProcessor');

interface ROIMetrics {
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  coverageRatio: number;
  fingerScore: number;
}

/**
 * MULTI-SOURCE PPG SIGNAL PROCESSOR
 * 
 * Mejoras clave:
 * 1. Estado de contacto 3-niveles (NO_CONTACT / UNSTABLE / STABLE)
 * 2. Selección competitiva de canal (R, G, R-G, CHROM 3R-2G)
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
  private readonly FINGER_CONFIRM_FRAMES = 5;   // ~170ms @ 30fps — balance velocidad/estabilidad
  private readonly FINGER_LOST_FRAMES = 90;     // ~3s tolerancia antes de degradar
  private readonly STABLE_THRESHOLD = 30;       // ~1s para STABLE — evitar parpadeo
  private readonly UNSTABLE_GRACE = 120;        // ~4s antes de NO_CONTACT total

  // Suavizado temporal — más lentos = más estable
  private smoothedRed = 0;
  private smoothedGreen = 0;
  private smoothedBlue = 0;
  private smoothedCoverage = 0;
  private smoothedFingerScore = 0;
  private readonly RGB_SMOOTH_ALPHA = 0.05;       // era 0.10 — más suave
  private readonly COVERAGE_SMOOTH_ALPHA = 0.06;  // era 0.12 — más suave

  // IMU / Motion
  private motionScore = 0;
  private motionListenerActive = false;
  private lastAcceleration = { x: 0, y: 0, z: 0 };
  private readonly MOTION_THRESHOLD = 0.6;

  // Cache: PI se calcula una sola vez por frame y se reutiliza en SQI, contact state, etc.
  private cachedPI = 0;
  // Cache de stats lentas (recomputadas cada N frames): evita slice+sort por frame
  // sobre ventanas estadísticas de 30-90 muestras que cambian lentamente.
  private cachedSqi = 0;

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
    this.updateContactState(roi);

    const motionArtifact = this.motionScore > this.MOTION_THRESHOLD;

    if (this.contactState === 'NO_CONTACT') {
      this.signalQuality = 0;
      this.onSignalReady({
        timestamp,
        rawValue: 0,
        filteredValue: 0,
        quality: 0,
        fingerDetected: false,
        contactState: 'NO_CONTACT',
        motionArtifact,
        roi: { x: 0, y: 0, width: imageData.width, height: imageData.height },
        perfusionIndex: 0,
        rawRed: roi.rawRed,
        rawGreen: roi.rawGreen,
        diagnostics: {
          message: `BUSCANDO DEDO C:${(roi.coverageRatio * 100).toFixed(0)}%`,
          hasPulsatility: false,
          pulsatilityValue: 0,
        },
      });
      return;
    }

    // Tenemos contacto (UNSTABLE o STABLE)
    this.updateChannelBaselines(roi.rawRed, roi.rawGreen, roi.rawBlue, motionArtifact);

    this.redBuffer.push(roi.rawRed);
    this.greenBuffer.push(roi.rawGreen);
    this.blueBuffer.push(roi.rawBlue);

    // ACDC over a 36+ sample window changes slowly — recompute every 3 frames
    // (~10 Hz) instead of every frame to cut 3 slice+sort allocations.
    if (this.redBuffer.length >= 36 && this.frameCount % 3 === 0) {
      this.calculateACDCPrecise();
    }
    // Calcular PI UNA sola vez por frame — todos los consumidores leen del cache.
    this.cachedPI = this.calculatePerfusionIndex();

    // Multi-source extraction
    const pulseSource = this.extractBestPulseSignal(roi.rawRed, roi.rawGreen, roi.rawBlue, motionArtifact);

    this.rawBuffer.push(pulseSource.value);

    const endFilt = ppgPerf.start('bandpass');
    const filtered = this.bandpassFilter.filter(pulseSource.value);
    endFilt();
    this.filteredBuffer.push(filtered);

    const endSqi = ppgPerf.start('sqi');
    // SQI is a statistical aggregate over 90 samples — recompute every 3 frames
    // (~10 Hz) instead of every frame. Cached value is reused otherwise.
    if (this.frameCount % 3 === 0) {
      this.cachedSqi = this.calculateSignalQuality();
    }
    this.signalQuality = this.cachedSqi;
    endSqi();

    const perfusionIndex = this.cachedPI;
    const adjustedQuality = motionArtifact
      ? Math.max(0, this.signalQuality * 0.75)
      : this.signalQuality;
    const gatedQuality = this.contactState === 'STABLE_CONTACT' && perfusionIndex >= 0.005
      ? adjustedQuality
      : Math.min(18, adjustedQuality * 0.45);

    const now = timestamp;
    if (now - this.lastLogTime >= 2000) {
      this.lastLogTime = now;
      const snap = ppgPerf.snapshot();
      log.info(
        `[${pulseSource.label}] Filt=${filtered.toFixed(3)} Q=${gatedQuality.toFixed(0)}% ` +
        `PI=${perfusionIndex.toFixed(2)} Contact=${this.contactState} ` +
        `FPS=${snap.fps.toFixed(1)} jitter=${snap.jitterMs.toFixed(1)}ms ` +
        `roi=${(snap.stages.roi?.p95 ?? 0).toFixed(2)}ms ` +
        `filt=${(snap.stages.bandpass?.p95 ?? 0).toFixed(2)}ms ` +
        `sqi=${(snap.stages.sqi?.p95 ?? 0).toFixed(2)}ms ` +
        `dropEst=${snap.droppedEstimate}`
      );
    }

    this.onSignalReady({
      timestamp,
      rawValue: pulseSource.value,
      filteredValue: filtered,
      quality: gatedQuality,
      fingerDetected: this.fingerDetected,
      contactState: this.contactState,
      motionArtifact,
      roi: { x: 0, y: 0, width: imageData.width, height: imageData.height },
      perfusionIndex,
      rawRed: roi.rawRed,
      rawGreen: roi.rawGreen,
      diagnostics: {
        message:
          `${pulseSource.label}:${pulseSource.strength.toFixed(1)} ` +
          `PI:${perfusionIndex.toFixed(2)} C:${(this.smoothedCoverage * 100).toFixed(0)} ` +
          `${this.contactState}${motionArtifact ? ' MOV' : ''}`,
        hasPulsatility: this.contactState === 'STABLE_CONTACT' && perfusionIndex >= 0.05 && pulseSource.strength > 1.5,
        pulsatilityValue: this.contactState === 'STABLE_CONTACT' ? Math.max(perfusionIndex, pulseSource.strength * 0.02) : 0,
      },
    });
  }

  // === ESTADO DE CONTACTO UNIFICADO ===
  private updateContactState(roi: ROIMetrics): void {
    const previousState = this.contactState;
    const instantDetected = this.detectFingerInstant(roi);

    if (instantDetected) {
      this.fingerLostCount = 0;
      this.fingerConfidenceCount = Math.min(this.fingerConfidenceCount + 1, 100);
      this.stableContactCount++;

      if (this.fingerConfidenceCount >= this.FINGER_CONFIRM_FRAMES) {
        this.fingerDetected = true;
        // Require real perfusion for STABLE — not just visual contact
        this.contactState = (this.stableContactCount >= this.STABLE_THRESHOLD && this.cachedPI > 0.003)
          ? 'STABLE_CONTACT'
          : 'UNSTABLE_CONTACT';
      }
    } else {
      // Decremento lento — no perder confianza por un solo frame malo
      this.fingerConfidenceCount = Math.max(0, this.fingerConfidenceCount - 0.5);
      this.fingerLostCount++;
      // stableContactCount decrementa lento para no perder STABLE por glitches
      this.stableContactCount = Math.max(0, this.stableContactCount - 0.3);

      if (this.fingerDetected) {
        // Soft hold: mantener contacto con gracia — stricter thresholds
        const softHold =
          this.smoothedCoverage > 0.15 &&
          (this.smoothedRed - (this.smoothedGreen + this.smoothedBlue) / 2) > 8 &&
          this.smoothedFingerScore > 0.20 &&
          (this.smoothedRed / Math.max(1, this.smoothedGreen)) > 1.05;

        if (softHold || this.fingerLostCount < this.FINGER_LOST_FRAMES) {
          this.contactState = 'UNSTABLE_CONTACT';
        } else if (this.fingerLostCount < this.UNSTABLE_GRACE) {
          this.contactState = 'UNSTABLE_CONTACT';
          // Don't reset buffers yet
        } else {
          this.contactState = 'NO_CONTACT';
          this.fingerDetected = false;
          this.stableContactCount = 0;
          this.resetSignalTrackingBuffers();
          this.resetBaselines();
        }
      } else {
        this.contactState = 'NO_CONTACT';
      }
    }

    // Resetear buffers solo al entrar en contacto desde NO_CONTACT
    if (previousState === 'NO_CONTACT' && this.contactState !== 'NO_CONTACT') {
      this.resetSignalTrackingBuffers();
    }
  }

  private detectFingerInstant(roi: ROIMetrics): boolean {
    const { rawRed, rawGreen, rawBlue, coverageRatio, fingerScore } = roi;

    // Smooth inputs
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

    const r = this.smoothedRed;
    const g = this.smoothedGreen;
    const b = this.smoothedBlue;
    const totalIntensity = r + g + b;
    const redDominance = r - (g + b) / 2;
    const rgRatio = r / Math.max(1, g);
    const rbRatio = r / Math.max(1, b); // Hemoglobin absorption is highest in Blue
    const notBlownOut = !(r > 253 && g > 252 && b > 252);

    // === HEMOGLOBIN SIGNATURE: red MUST dominate and blue MUST be very low ===
    if (this.fingerDetected) {
      // MAINTAIN contact — slightly relaxed thresholds
      const maintainContact =
        r > 45 &&
        rgRatio > 1.05 &&
        rbRatio > 1.25 &&
        redDominance > 10 &&
        this.smoothedCoverage > 0.15 &&
        notBlownOut;
      return maintainContact;
    } else {
      // ACQUIRE contact — strict hemoglobin thresholds (literature validated)
      const acquireContact =
        r > 75 &&
        rgRatio > 1.15 &&
        rbRatio > 1.45 &&
        redDominance > 18 &&
        totalIntensity > 110 && totalIntensity < 750 &&
        this.smoothedCoverage > 0.30 &&
        this.smoothedFingerScore > 0.35 &&
        this.motionScore < 1.2 &&
        notBlownOut;
      
      if (acquireContact && this.frameCount % 30 === 0) {
        log.info(`[Finger Acquisition] R:${r.toFixed(1)} G:${g.toFixed(1)} B:${b.toFixed(1)} R/G:${rgRatio.toFixed(2)} R/B:${rbRatio.toFixed(2)}`);
      }
      return acquireContact;
    }
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

    const roiSize = Math.min(width, height) * 0.78;
    const startX = Math.floor((width - roiSize) / 2);
    const startY = Math.floor((height - roiSize) / 2);
    const endX = startX + Math.floor(roiSize);
    const endY = startY + Math.floor(roiSize);

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
      const centerBias = clamp(1 - distanceFromCenter * 1.2, 0.3, 1);

      const brightnessScore = clamp((total - 120) / 220, 0, 1);
      const redRatioScore = clamp((rednessRatio - 1.02) / 0.85, 0, 1);
      const dominanceScore = clamp((redDominance - 10) / 35, 0, 1);
      const frameScore = redRatioScore * 0.45 + dominanceScore * 0.4 + brightnessScore * 0.15;

      this.tileConfidence[i] = this.tileConfidence[i] * 0.75 + frameScore * centerBias * 0.25;
      const combinedScore = this.tileConfidence[i] * 0.7 + frameScore * 0.3;

      m.red = red; m.green = green; m.blue = blue;
      m.total = total; m.redDominance = redDominance; m.rednessRatio = rednessRatio;
      m.centerBias = centerBias; m.frameScore = frameScore; m.combinedScore = combinedScore;
      m.valid = true;
      m.isFinger =
        red > 55 &&
        total > 120 &&
        redDominance > 12 &&
        rednessRatio > 1.08 &&
        combinedScore > 0.42;
      validCount++;
      if (m.isFinger) {
        fingerCount++;
        fingerScoreSum += combinedScore;
      }
    }

    if (validCount === 0) {
      return { rawRed: 0, rawGreen: 0, rawBlue: 0, coverageRatio: 0, fingerScore: 0 };
    }

    const useFingerOnly = fingerCount >= 5;
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
      R: rPulse * 3200,
      G: gPulse * 3200,
      RG: this.blendRG(rPulse, gPulse, rawRed, rawGreen, motionArtifact) * 3200,
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

    let greenWeight = 0.55;
    let redWeight = 0.45;

    if (piSum > 0) {
      greenWeight = clamp(greenPI / piSum, 0.25, 0.8);
      redWeight = 1 - greenWeight;
    }

    // Clipping penalties
    if (rawGreen > 245) { greenWeight *= 0.4; redWeight = 1 - greenWeight; }
    if (rawRed > 245) { redWeight *= 0.4; greenWeight = 1 - redWeight; }
    if (motionArtifact) { greenWeight = clamp(greenWeight + 0.05, 0.3, 0.8); redWeight = 1 - greenWeight; }

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

  // === SQI UNIFICADO - ÚNICA FUENTE DE VERDAD ===
  private calculateSignalQuality(): number {
    if (this.filteredBuffer.length < 24) return 0;
    if (this.contactState === 'NO_CONTACT') return 0;

    const perfusionIndex = this.cachedPI;
    const redDominance = this.smoothedRed - (this.smoothedGreen + this.smoothedBlue) / 2;

    // Gate: no perfusion = no real signal
    if (perfusionIndex < 0.005) return Math.min(15, this.smoothedCoverage * 20);
    // Gate: red must dominate (hemoglobin signature)
    if (redDominance < 15) return 0;

    const recent = this.filteredBuffer.tail(90);
    const sortedView = this.sortedScratch.subarray(0, recent.length);
    for (let i = 0; i < recent.length; i++) sortedView[i] = recent[i];
    sortedView.sort();
    const sorted = sortedView;
    const p10 = sorted[Math.floor((sorted.length - 1) * 0.1)] ?? 0;
    const p90 = sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0;
    const range = p90 - p10;

    if (range < 0.3) return 5;

    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, v) => a + (v - mean) ** 2, 0) / recent.length;
    const stdDev = Math.sqrt(variance);
    const snr = range / (stdDev + 0.15);

    // MEJORA: Skewness y Kurtosis (Estándares en SQI clínico)
    let skewSum = 0;
    let kurtSum = 0;
    for (const v of recent) {
      const diff = (v - mean) / (stdDev + 0.001);
      skewSum += diff ** 3;
      kurtSum += diff ** 4;
    }
    const skewness = skewSum / recent.length;
    const kurtosis = kurtSum / recent.length;

    // Normal PPG: Skewness > 0, Kurtosis ~3-5
    const skewScore = clamp(skewness * 5, 0, 10);
    const kurtScore = clamp((5 - Math.abs(kurtosis - 4)) * 2, 0, 10);

    const snrScore = Math.min(30, snr * 10);
    const perfusionScore = Math.min(25, perfusionIndex * 12);
    const coverageScore = Math.min(15, this.smoothedCoverage * 25);
    const fingerScore = Math.min(15, this.smoothedFingerScore * 22);
    const motionPenalty = Math.min(25, this.motionScore * 20);

    const baseQuality = snrScore + perfusionScore + coverageScore + fingerScore + skewScore + kurtScore - motionPenalty;
    
    // Bonus for stable contact + pulsatility evidence
    const stabilityBonus = this.contactState === 'STABLE_CONTACT' ? 5 : 0;
    const pulsatilityBonus = (this.redAC > 0 || this.greenAC > 0) ? 5 : 0;

    const finalSqi = clamp(baseQuality + stabilityBonus + pulsatilityBonus, 0, 100);
    
    if (this.frameCount % 90 === 0) {
      log.info(`[SQI Debug] Snr:${snr.toFixed(1)} Skew:${skewness.toFixed(2)} Kurt:${kurtosis.toFixed(2)} PI:${perfusionIndex.toFixed(2)} Final:${finalSqi.toFixed(0)}%`);
    }

    return finalSqi;
  }

  private calculatePerfusionIndex(): number {
    // PI como ratio (0.0-1.0), NO porcentaje. La UI multiplica *100 para display.
    if (this.greenDC > 0) return this.greenAC / this.greenDC;
    if (this.redDC > 0) return this.redAC / this.redDC;
    return 0;
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
    this.fingerConfidenceCount = 0;
    this.fingerLostCount = 0;
    this.stableContactCount = 0;
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
    this.sourceBuffers = { R: [], G: [], RG: [] };
    this.sourceScores = { R: 0, G: 0, RG: 0 };
    this.activeSource = 'RG';
    this.lastSourceSwitch = 0;
    this.resetBaselines();
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
