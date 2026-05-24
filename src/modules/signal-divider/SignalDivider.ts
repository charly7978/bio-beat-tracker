import { BandpassFilter } from '../signal-processing/BandpassFilter';
import { transformPixel } from '../signal-processing/visualTransform';
import { clamp } from '../../utils/math';
import {
  HR_CHANNEL, SPO2_CHANNEL, HRV_CHANNEL, RESP_CHANNEL, BP_CHANNEL,
  type SignalChannelPreset,
} from './channelPresets';
import {
  evaluateFrontCamera,
  evaluateCompass,
  evaluateAccelerometer,
  type MotionVerdict,
  type FrontCameraMotionReport,
  type CompassMotionReport,
  type AccelerometerMotionReport,
} from '../../lib/sensors/motionArbiter';

export interface ChannelState {
  preset: SignalChannelPreset;
  /** Valores crudos R, G, B promedio del tile central */
  rawR: number; rawG: number; rawB: number;
  /** Señal filtrada (bandpass) */
  filtered: number;
  /** AGC scale actual */
  agcScale: number;
  /** SQI específico del canal (0-100) */
  quality: number;
  /** Confianza (0-1) */
  confidence: number;
  filteredBuffer: Float64Array[];
}

export interface DividerResult {
  channels: {
    hr: ChannelState;
    spo2: ChannelState;
    hrv: ChannelState;
    resp: ChannelState;
    bp: ChannelState;
  };
  /** Veredicto del MotionArbiter si fue consultado */
  arbiterVerdict: MotionVerdict | null;
  /** El arbiter fue consultado esta frame */
  arbiterConsulted: boolean;
  timestamp: number;
}

/** Resultado de extraer ROI de un solo tile central por canal */
interface RoiExtraction {
  r: number; g: number; b: number;
}

/**
 * SignalDivider — el corazón de la arquitectura de procesamiento por
 * señal exclusiva.
 *
 * Toma el ImageData RAW de la cámara y produce señales optimizadas para
 * cada signo vital. Cada canal aplica su propio:
 *   1. Transformación visual (boost de canal, gamma, contraste)
 *   2. Pixel stride (resolución espacial)
 *   3. Filtro bandpass (frecuencias específicas)
 *   4. AGC adaptativo
 *   5. SQI específico
 *
 * Además, integra el MotionArbiter: cuando la confianza de un canal es
 * baja, consulta sensores auxiliares (cámara frontal, compás) para
 * determinar si la ambigüedad es ruido o señal real.
 */
export class SignalDivider {
  private readonly filters: Map<string, BandpassFilter> = new Map();
  private readonly bufferSizes: Map<string, number> = new Map();
  private readonly filteredValues: Map<string, Float64Array> = new Map();
  private readonly agcScales: Map<string, number> = new Map();
  private readonly rawValues: Map<string, { r: number; g: number; b: number }> = new Map();

  private frameCount = 0;
  private readonly SAMPLE_RATE = 30;

  private frontCamReport: FrontCameraMotionReport | null = null;
  private compassReport: CompassMotionReport | null = null;
  private lastCompassReport: CompassMotionReport | null = null;
  private accelReport: AccelerometerMotionReport | null = null;

  private readonly BUFFER_SIZE = 256;
  private readonly AGC_TARGET = 40;
  private readonly AGC_MIN_SCALE = 0.5;
  private readonly AGC_MAX_SCALE = 8;
  private readonly AGC_TAIL = 48;

  constructor() {
    for (const preset of [HR_CHANNEL, SPO2_CHANNEL, HRV_CHANNEL, RESP_CHANNEL, BP_CHANNEL]) {
      this.filters.set(preset.name, new BandpassFilter(this.SAMPLE_RATE, preset.bandpassHigh));
      this.bufferSizes.set(preset.name, 0);
      this.filteredValues.set(preset.name, new Float64Array(this.BUFFER_SIZE));
      this.agcScales.set(preset.name, 1.0);
      this.rawValues.set(preset.name, { r: 0, g: 0, b: 0 });
    }
  }

  /** Inyecta reportes de sensores externos antes de procesar */
  setSensorReports(
    frontCam: FrontCameraMotionReport | null,
    compass: CompassMotionReport | null,
    lastCompass: CompassMotionReport | null,
    accel: AccelerometerMotionReport | null,
  ): void {
    this.frontCamReport = frontCam;
    this.compassReport = compass;
    this.lastCompassReport = lastCompass;
    this.accelReport = accel;
  }

  /**
   * Procesa un frame completo: extrae ROI por canal, filtra, aplica AGC,
   * consulta al MotionArbiter si es necesario.
   */
  processFrame(imageData: ImageData, timestampMs: number): DividerResult {
    this.frameCount++;
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;

    const channels = {
      hr: this.processChannel(HR_CHANNEL, data, w, h),
      spo2: this.processChannel(SPO2_CHANNEL, data, w, h),
      hrv: this.processChannel(HRV_CHANNEL, data, w, h),
      resp: this.processChannel(RESP_CHANNEL, data, w, h),
      bp: this.processChannel(BP_CHANNEL, data, w, h),
    };

    // MotionArbiter: consultar si ALGÚN canal tiene confianza baja
    let arbiterConsulted = false;
    let arbiterVerdict: MotionVerdict | null = null;

    const lowestConf = Math.min(
      channels.hr.confidence, channels.spo2.confidence,
      channels.hrv.confidence, channels.bp.confidence,
    );

    if (lowestConf < 0.4) {
      arbiterConsulted = true;
      arbiterVerdict = arbitrateMotion(
        this.frontCamReport,
        this.compassReport,
        this.lastCompassReport,
        this.accelReport,
      );

      // Si el arbiter detectó movimiento, marcar todos los canales como
      // artefacto (bajar confianza drásticamente)
      if (arbiterVerdict.motionDetected) {
        for (const key of Object.keys(channels) as (keyof typeof channels)[]) {
          channels[key].confidence *= 0.3;
          channels[key].quality = Math.max(0, channels[key].quality - 30);
        }
      }
    }

    return {
      channels,
      arbiterVerdict,
      arbiterConsulted,
      timestamp: timestampMs,
    };
  }

  /** Procesa un canal: extrae ROI visual transformado + filtra + AGC */
  private processChannel(preset: SignalChannelPreset, data: Uint8ClampedArray, w: number, h: number): ChannelState {
    const roi = this.extractCentralRoi(data, w, h, preset);
    const rawKey = `${preset.name}_raw`;
    this.rawValues.set(rawKey, { r: roi.r, g: roi.g, b: roi.b });

    // Elegir canal dominante
    const rawVal = this.selectDominant(roi, preset.dominantChannel);

    // Buffer circular simple
    const buf = this.filteredValues.get(preset.name)!;
    let bufLen = this.bufferSizes.get(preset.name) ?? 0;
    if (bufLen < this.BUFFER_SIZE) {
      buf[bufLen] = rawVal;
      bufLen++;
      this.bufferSizes.set(preset.name, bufLen);
    } else {
      // Shift circular
      for (let i = 0; i < this.BUFFER_SIZE - 1; i++) buf[i] = buf[i + 1];
      buf[this.BUFFER_SIZE - 1] = rawVal;
    }

    // Filtro
    const filter = this.filters.get(preset.name)!;
    const filtered = filter.filter(rawVal);

    // AGC simple
    let agcScale = this.agcScales.get(preset.name) ?? 1.0;
    const tailLen = Math.min(bufLen, this.AGC_TAIL);
    let peak = 0;
    for (let i = 0; i < tailLen; i++) {
      const abs = Math.abs(buf[bufLen - 1 - i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 1) {
      const target = this.AGC_TARGET / peak;
      agcScale += (target - agcScale) * 0.1;
      agcScale = clamp(agcScale, this.AGC_MIN_SCALE, this.AGC_MAX_SCALE);
    }
    this.agcScales.set(preset.name, agcScale);

    // SQI específico del canal
    const quality = this.computeChannelQuality(buf, bufLen, filtered, preset);
    const confidence = quality / 100;

    return {
      preset,
      rawR: roi.r, rawG: roi.g, rawB: roi.b,
      filtered: filtered * agcScale,
      agcScale,
      quality,
      confidence,
      filteredBuffer: [buf.slice(0, bufLen) as unknown as Float64Array],
    };
  }

  /** Extrae ROI central con transformación visual del canal */
  private extractCentralRoi(
    data: Uint8ClampedArray, w: number, h: number, preset: SignalChannelPreset,
  ): RoiExtraction {
    const roiSize = Math.min(w, h) * 0.7;
    const startX = Math.floor((w - roiSize) / 2);
    const startY = Math.floor((h - roiSize) / 2);
    const side = Math.floor(roiSize);
    const endX = startX + side;
    const endY = startY + side;
    const stride = preset.pixelStride;

    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    const vt = preset.visual;

    for (let y = startY; y < endY; y += stride) {
      for (let x = startX; x < endX; x += stride) {
        const i = (y * w + x) * 4;
        const [r, g, b] = transformPixel(data[i], data[i + 1], data[i + 2], vt);
        sumR += r; sumG += g; sumB += b; count++;
      }
    }

    return count > 0
      ? { r: sumR / count, g: sumG / count, b: sumB / count }
      : { r: 0, g: 0, b: 0 };
  }

  /** Selecciona el valor del canal dominante */
  private selectDominant(roi: RoiExtraction, dominant: 'R' | 'G' | 'B' | 'RG'): number {
    switch (dominant) {
      case 'R': return roi.r;
      case 'G': return roi.g;
      case 'B': return roi.b;
      case 'RG': return (roi.r + roi.g) / 2;
    }
  }

  /** SQI específico por canal */
  private computeChannelQuality(
    buf: Float64Array, len: number, filtered: number, preset: SignalChannelPreset,
  ): number {
    if (len < 10) return 0;

    // 1. SNR: relación entre energía de la señal y ruido
    let signalEnergy = 0, noiseEnergy = 0;
    const half = Math.floor(len / 2);
    for (let i = 0; i < half; i++) {
      signalEnergy += buf[i] * buf[i];
      noiseEnergy += (buf[i] - filtered) * (buf[i] - filtered);
    }
    const snr = noiseEnergy > 0 ? signalEnergy / noiseEnergy : 0;
    const snrScore = Math.min(50, snr * 10);

    // 2. Estabilidad: varianza inversa de la amplitud
    const mean = buf.reduce((a, b) => a + b, 0) / len;
    let variance = 0;
    for (let i = 0; i < len; i++) variance += (buf[i] - mean) ** 2;
    variance /= len;
    const stabilityScore = Math.min(25, variance > 0.1 ? 25 : variance * 250);

    // 3. Periodicidad (específica para cada canal)
    const periodicityScore = this.periodicityScore(buf, len, preset);

    // 4. Penalización específica por canal
    const penalty = preset.name === 'spo2' ? this.spo2Penalty(buf, len) : 1;

    return clamp(Math.round((snrScore + stabilityScore + periodicityScore) * penalty), 0, 100);
  }

  /** Puntaje de periodicidad basado en autocorrelación simple */
  private periodicityScore(buf: Float64Array, len: number, preset: SignalChannelPreset): number {
    if (len < 20) return 0;
    const minLag = Math.max(2, Math.floor(this.SAMPLE_RATE / preset.bandpassHigh));
    const maxLag = Math.min(len / 2, Math.floor(this.SAMPLE_RATE / preset.bandpassLow));
    if (minLag >= maxLag) return 15;

    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0, count = 0;
      for (let i = 0; i < len - lag; i++) {
        corr += buf[i] * buf[i + lag];
        count++;
      }
      if (count > 0) {
        corr /= count;
        if (corr > bestCorr) bestCorr = corr;
      }
    }
    return Math.min(25, bestCorr > 0 ? bestCorr * 40 : 0);
  }

  /** Penalización para SpO2: señal plana = baja calidad */
  private spo2Penalty(buf: Float64Array, len: number): number {
    if (len < 5) return 0.5;
    const mean = buf.reduce((a, b) => a + b, 0) / len;
    let variance = 0;
    for (let i = 0; i < len; i++) variance += (buf[i] - mean) ** 2;
    variance /= len;
    return variance > 0.5 ? 1.0 : variance * 2;
  }
}

/** Árbitro que fusiona todos los sensores */
function arbitrateMotion(
  frontCam: FrontCameraMotionReport | null,
  compass: CompassMotionReport | null,
  lastCompass: CompassMotionReport | null,
  accel: AccelerometerMotionReport | null,
): MotionVerdict {
  const fc = evaluateFrontCamera(frontCam);
  const co = evaluateCompass(compass, lastCompass);
  const ac = evaluateAccelerometer(accel);

  const triggered = [fc, co, ac].filter(v => v.motionDetected);
  if (triggered.length === 0) return { motionDetected: false, source: 'none', confidence: 0 };

  const best = triggered.reduce((a, b) => a.confidence > b.confidence ? a : b);
  if (triggered.length >= 2) best.confidence = Math.min(1, best.confidence + 0.15 * (triggered.length - 1));
  return best;
}
