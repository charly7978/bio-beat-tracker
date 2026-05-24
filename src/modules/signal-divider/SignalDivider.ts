import { BandpassFilter } from '../signal-processing/BandpassFilter';
import { NotchFilter } from '../signal-processing/NotchFilter';
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
  rawR: number; rawG: number; rawB: number;
  /** Señal filtrada por bandpass (AC) */
  acValue: number;
  /** Componente DC (para canales que la preservan: SpO2, BP) */
  dcValue: number;
  /** AGC scale */
  agcScale: number;
  /** Calidad 0-100 */
  quality: number;
  /** Confianza 0-1 */
  confidence: number;
  rawBuffer: Float64Array;
  acBuffer: Float64Array;
}

export interface DividerResult {
  channels: {
    hr: ChannelState;
    spo2: ChannelState;
    hrv: ChannelState;
    resp: ChannelState;
    bp: ChannelState;
  };
  arbiterVerdict: MotionVerdict | null;
  arbiterConsulted: boolean;
  timestamp: number;
}

interface RoiExtraction {
  r: number; g: number; b: number;
}

/**
 * SignalDivider — procesa cada frame en 5 canales independientes,
 * cada uno con su propio preset visual, stride, bandpass y AGC.
 * Incluye MotionArbiter para desambiguar señal dudosa.
 */
export class SignalDivider {
  private readonly notchFilters: Map<string, NotchFilter> = new Map(); // Elimina 50/60Hz
  private readonly filters: Map<string, BandpassFilter> = new Map();
  private readonly agcScales: Map<string, number> = new Map();
  private readonly rawValues: Map<string, { r: number; g: number; b: number }> = new Map();

  /** Buffers circulares: raw y AC */
  private readonly rawBuffers: Map<string, Float64Array> = new Map();
  private readonly acBuffers: Map<string, Float64Array> = new Map();
  private readonly heads: Map<string, number> = new Map();
  private readonly dcEmas: Map<string, number> = new Map();
  private readonly fillCounts: Map<string, number> = new Map();
  private frameCount = 0;

  private readonly SAMPLE_RATE = 30;
  private readonly BUFFER_SIZE = 256;
  private readonly BUFFER_MASK = 255; // tamaño potencia de 2 para máscara

  private readonly AGC_TARGET = 40;
  private readonly AGC_MIN_SCALE = 0.5;
  private readonly AGC_MAX_SCALE = 8;
  private readonly AGC_TAIL = 48;

  private frontCamReport: FrontCameraMotionReport | null = null;
  private compassReport: CompassMotionReport | null = null;
  private lastCompassReport: CompassMotionReport | null = null;
  private accelReport: AccelerometerMotionReport | null = null;

  constructor() {
    for (const preset of [HR_CHANNEL, SPO2_CHANNEL, HRV_CHANNEL, RESP_CHANNEL, BP_CHANNEL]) {
      this.notchFilters.set(preset.name, new NotchFilter(this.SAMPLE_RATE, 50, 20));
      this.filters.set(preset.name, new BandpassFilter(this.SAMPLE_RATE, preset.bandpassHigh));
      this.rawBuffers.set(preset.name, new Float64Array(this.BUFFER_SIZE));
      this.acBuffers.set(preset.name, new Float64Array(this.BUFFER_SIZE));
      this.heads.set(preset.name, 0);
      this.fillCounts.set(preset.name, 0);
      this.dcEmas.set(preset.name, 0);
      this.agcScales.set(preset.name, 1.0);
      this.rawValues.set(preset.name, { r: 0, g: 0, b: 0 });
    }
  }

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

  /** Cambiar frecuencia del notch filter: 50 Hz (Europa/Asia) o 60 Hz (USA). */
  setNotchFrequency(freq: 50 | 60): void {
    for (const notchFilter of this.notchFilters.values()) {
      notchFilter.setNotchFrequency(freq);
    }
  }

  /** Resetear todos los notch filters. */
  resetNotchFilters(): void {
    for (const notchFilter of this.notchFilters.values()) {
      notchFilter.reset();
    }
  }

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

    let arbiterConsulted = false;
    let arbiterVerdict: MotionVerdict | null = null;

    const lowestConf = Math.min(
      channels.hr.confidence, channels.spo2.confidence,
      channels.hrv.confidence, channels.bp.confidence,
    );

    if (lowestConf < 0.4) {
      arbiterConsulted = true;
      arbiterVerdict = this.arbitrateMotion();

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

  private processChannel(preset: SignalChannelPreset, data: Uint8ClampedArray, w: number, h: number): ChannelState {
    const roi = this.extractCentralRoi(data, w, h, preset);
    this.rawValues.set(`${preset.name}_raw`, { r: roi.r, g: roi.g, b: roi.b });

    const rawVal = this.selectDominant(roi, preset.dominantChannel);

    // DC rolling (EMA) para canales que la preservan
    const dcEma = this.dcEmas.get(preset.name) ?? 0;
    const dcAlpha = preset.dcMode === 'preserve' ? 0.01 : 0.05;
    const newDc = dcEma + dcAlpha * (rawVal - dcEma);
    this.dcEmas.set(preset.name, newDc);

    // Buffer circular raw
    const rawBuf = this.rawBuffers.get(preset.name)!;
    const head = this.heads.get(preset.name)!;
    rawBuf[head] = rawVal;
    this.heads.set(preset.name, (head + 1) & this.BUFFER_MASK);

    const fillCount = this.fillCounts.get(preset.name) ?? 0;
    const newFill = Math.min(fillCount + 1, this.BUFFER_SIZE);
    this.fillCounts.set(preset.name, newFill);

    // Notch filter (50/60Hz) → Bandpass
    const notchFilter = this.notchFilters.get(preset.name)!;
    const notched = notchFilter.filter(rawVal);
    const filter = this.filters.get(preset.name)!;
    const acValue = filter.filter(notched);

    // Buffer circular AC
    const acBuf = this.acBuffers.get(preset.name)!;
    acBuf[head] = acValue;

    // AGC sobre AC
    const agcScale = this.computeAgc(acBuf, this.heads.get(preset.name)!, newFill, preset);
    this.agcScales.set(preset.name, agcScale);

    // Calidad del canal
    const quality = this.computeChannelQuality(acBuf, newFill, acValue, preset);
    const confidence = quality / 100;

    return {
      preset,
      rawR: roi.r, rawG: roi.g, rawB: roi.b,
      acValue: acValue * agcScale,
      dcValue: preset.dcMode === 'preserve' || preset.dcMode === 'partial' ? newDc : 0,
      agcScale,
      quality,
      confidence,
      rawBuffer: rawBuf,
      acBuffer: acBuf,
    };
  }

  /** AGC adaptativo sobre buffer AC */
  private computeAgc(acBuf: Float64Array, head: number, fillCount: number, _preset: SignalChannelPreset): number {
    let agcScale = this.agcScales.get(_preset.name) ?? 1.0;
    if (fillCount < 5) return agcScale;

    const tail = Math.min(fillCount, this.AGC_TAIL);
    let peak = 0;
    for (let i = 0; i < tail; i++) {
      const idx = ((head - 1 - i) & this.BUFFER_MASK);
      const abs = Math.abs(acBuf[idx]);
      if (abs > peak) peak = abs;
    }
    if (peak > 0.1) {
      const target = this.AGC_TARGET / peak;
      agcScale += (target - agcScale) * 0.1;
      agcScale = clamp(agcScale, this.AGC_MIN_SCALE, this.AGC_MAX_SCALE);
    }
    return agcScale;
  }

  /** SQI: periodicidad + estabilidad sobre la señal AC */
  private computeChannelQuality(acBuf: Float64Array, fillCount: number, _latestAc: number, preset: SignalChannelPreset): number {
    if (fillCount < 10) return 0;

    const len = Math.min(fillCount, this.BUFFER_SIZE);
    const head = this.heads.get(preset.name)!;

    // Periodicidad por autocorrelación
    const periodicityScore = this.periodicityScore(acBuf, head, len, preset);

    // Estabilidad: desviación del AC en ventana reciente
    const stabilityScore = this.stabilityScore(acBuf, head, len);

    // Penalización por canal
    const penalty = this.channelPenalty(acBuf, head, len, preset);

    return clamp(Math.round((periodicityScore + stabilityScore) * penalty), 0, 100);
  }

  /** Autocorrelación sobre buffer AC para medir periodicidad */
  private periodicityScore(acBuf: Float64Array, head: number, len: number, preset: SignalChannelPreset): number {
    if (len < 20) return 0;
    const minLag = Math.max(2, Math.floor(this.SAMPLE_RATE / preset.bandpassHigh));
    const maxLag = Math.min(Math.floor(len / 2), Math.floor(this.SAMPLE_RATE / Math.max(0.3, preset.bandpassLow)));
    if (minLag >= maxLag) return 15;

    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0, count = 0;
      for (let i = 0; i < len - lag; i++) {
        const idx1 = ((head - 1 - i) & this.BUFFER_MASK);
        const idx2 = ((head - 1 - i - lag) & this.BUFFER_MASK);
        corr += acBuf[idx1] * acBuf[idx2];
        count++;
      }
      if (count > 0) {
        corr = Math.abs(corr / count);
        if (corr > bestCorr) bestCorr = corr;
      }
    }
    return Math.min(60, bestCorr > 0 ? bestCorr * 120 : 0);
  }

  /** Estabilidad inversa de la amplitud del AC */
  private stabilityScore(acBuf: Float64Array, head: number, len: number): number {
    let sum = 0, sumSq = 0;
    const n = Math.min(len, 60);
    for (let i = 0; i < n; i++) {
      const idx = ((head - 1 - i) & this.BUFFER_MASK);
      const v = acBuf[idx];
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const variance = (sumSq / n) - (mean * mean);
    if (variance <= 0) return 0;
    // A mayor varianza = más energía de señal = mejor (hasta cierto punto)
    const score = Math.min(40, variance * 200);
    return score;
  }

  /** Penalizaciones específicas por tipo de canal */
  private channelPenalty(acBuf: Float64Array, head: number, len: number, preset: SignalChannelPreset): number {
    if (preset.name !== 'spo2') return 1;
    // SpO2: señal plana penaliza
    if (len < 5) return 0.5;
    let sum = 0, sumSq = 0;
    const n = Math.min(len, 30);
    for (let i = 0; i < n; i++) {
      const idx = ((head - 1 - i) & this.BUFFER_MASK);
      const v = acBuf[idx];
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const variance = (sumSq / n) - (mean * mean);
    return variance > 0.3 ? 1.0 : variance * 3;
  }

  private extractCentralRoi(data: Uint8ClampedArray, w: number, h: number, preset: SignalChannelPreset): RoiExtraction {
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

  private selectDominant(roi: RoiExtraction, dominant: 'R' | 'G' | 'B' | 'RG'): number {
    switch (dominant) {
      case 'R': return roi.r;
      case 'G': return roi.g;
      case 'B': return roi.b;
      case 'RG': return (roi.r + roi.g) / 2;
    }
  }

  /** Árbitro que fusiona sensores */
  private arbitrateMotion(): MotionVerdict {
    const fc = evaluateFrontCamera(this.frontCamReport);
    const co = evaluateCompass(this.compassReport, this.lastCompassReport);
    const ac = evaluateAccelerometer(this.accelReport);

    const triggered = [fc, co, ac].filter(v => v.motionDetected);
    if (triggered.length === 0) return { motionDetected: false, source: 'none', confidence: 0 };

    const best = triggered.reduce((a, b) => a.confidence > b.confidence ? a : b);
    if (triggered.length >= 2) best.confidence = Math.min(1, best.confidence + 0.15 * (triggered.length - 1));
    return best;
  }
}
