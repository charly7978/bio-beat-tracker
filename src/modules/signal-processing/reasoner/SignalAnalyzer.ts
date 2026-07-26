import { clamp } from '../../../utils/math';
import { CardiacKnowledge } from './CardiacKnowledge';

export interface SignalFeatures {
  waveform: WaveformFeatures;
  perfusion: PerfusionFeatures;
  frequency: FrequencyFeatures;
  morphology: MorphologyFeatures;
  crossChannel: CrossChannelFeatures;
}

export interface WaveformFeatures {
  riseTimeMs: number;
  fallTimeMs: number;
  asymmetryRatio: number;
  hasNotch: boolean;
  notchPosition: number;
  systolicSlope: number;
  diastolicSlope: number;
}

export interface PerfusionFeatures {
  acDcRatio: number;
  perfusionIndex: number;
  acAmplitude: number;
  dcLevel: number;
}

export interface FrequencyFeatures {
  dominantFreqHz: number;
  cardiacPowerRatio: number;
  bandPower0_5_4Hz: number;
  totalPower: number;
}

export interface MorphologyFeatures {
  beatConsistency: number;
  beatCorrelation: number;
  templateMatch: number;
}

export interface CrossChannelFeatures {
  rChannelCorrelation: number;
  gChannelCorrelation: number;
  bChannelCorrelation: number;
}

export class SignalAnalyzer {
  private beatBuffer: number[][] = [];
  private templateBuffer: number[] | null = null;
  private readonly BUFFER_MAX = 12;
  private readonly TEMPLATE_LENGTH = 64;

  extractPPGFeatures(
    signal: number[],
    timestamps: number[],
    peakIndices: number[],
    rgbData?: { r: number[]; g: number[]; b: number[] },
  ): SignalFeatures {
    return {
      waveform: this.analyzeWaveform(signal, timestamps, peakIndices),
      perfusion: this.analyzePerfusion(signal),
      frequency: this.analyzeFrequency(signal, timestamps),
      morphology: this.analyzeMorphology(signal, peakIndices),
      crossChannel: this.analyzeCrossChannel(rgbData),
    };
  }

  private analyzeWaveform(
    signal: number[],
    timestamps: number[],
    peakIndices: number[],
  ): WaveformFeatures {
    if (peakIndices.length < 2) {
      return fallbackWaveform();
    }

    const peak0 = peakIndices[peakIndices.length - 2];
    const peak1 = peakIndices[peakIndices.length - 1];
    if (peak0 == null || peak1 == null) return fallbackWaveform();

    const trough = this.findTroughBetween(signal, peak0, peak1);

    const riseStart = trough;
    const riseEnd = peak1;
    const riseTime = riseEnd - riseStart > 0 ? (timestamps[riseEnd] ?? 0) - (timestamps[riseStart] ?? 0) : 0;
    const systolicSlope = riseTime > 0 ? (signal[riseEnd] ?? 0) - (signal[riseStart] ?? 0) / riseTime : 0;

    const fallEnd = this.findNextTrough(signal, peak1) ?? (signal.length - 1);
    const fallTime = fallEnd - peak1 > 0 ? (timestamps[fallEnd] ?? 0) - (timestamps[peak1] ?? 0) : 0;
    const diastolicSlope = fallTime > 0 ? (signal[fallEnd] ?? 0) - (signal[peak1] ?? 0) / fallTime : 0;

    const asymmetryRatio = riseTime + fallTime > 0 ? riseTime / (riseTime + fallTime) : 0.5;

    const notchPos = this.detectDicroticNotch(signal, peak1, fallEnd);
    const notchPosition = notchPos >= 0 ? (notchPos - peak1) / Math.max(1, fallEnd - peak1) : -1;

    return {
      riseTimeMs: riseTime,
      fallTimeMs: fallTime,
      asymmetryRatio,
      hasNotch: notchPos >= 0,
      notchPosition: notchPos >= 0 ? clamp(notchPosition, 0, 1) : -1,
      systolicSlope,
      diastolicSlope,
    };
  }

  private analyzePerfusion(signal: number[]): PerfusionFeatures {
    const n = signal.length;
    if (n < 10) return fallbackPerfusion();

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = signal[i] ?? 0;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const mean = sum / n;
    const acAmplitude = max - min;
    const dcLevel = mean > 0 ? mean : 1;
    const acDcRatio = acAmplitude / dcLevel;
    const perfusionIndex = (acAmplitude / dcLevel) * 100;

    return { acDcRatio, perfusionIndex, acAmplitude, dcLevel };
  }

  private analyzeFrequency(
    signal: number[],
    timestamps: number[],
  ): FrequencyFeatures {
    const n = signal.length;
    if (n < 4) return fallbackFrequency();

    const totalDurationMs = (timestamps[n - 1] ?? 0) - (timestamps[0] ?? 0);
    const fs = totalDurationMs > 0 ? (n / totalDurationMs) * 1000 : 30;

    const fftSize = Math.min(256, n);
    const real: number[] = [];
    const imag: number[] = [];
    for (let k = 0; k < fftSize; k++) {
      let re = 0;
      let im = 0;
      for (let t = 0; t < n; t++) {
        const angle = (-2 * Math.PI * k * t) / fftSize;
        re += (signal[t] ?? 0) * Math.cos(angle);
        im += (signal[t] ?? 0) * Math.sin(angle);
      }
      real.push(re);
      imag.push(im);
    }

    let dominantFreqHz = 0;
    let maxMag = 0;
    let cardiacPower = 0;
    let totalPower = 0;

    for (let k = 0; k < fftSize; k++) {
      const freq = (k * fs) / fftSize;
      const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
      totalPower += mag;
      if (freq >= 0.5 && freq <= 4.0) {
        cardiacPower += mag;
        if (mag > maxMag) {
          maxMag = mag;
          dominantFreqHz = freq;
        }
      }
    }

    const cardiacPowerRatio = totalPower > 0 ? cardiacPower / totalPower : 0;

    return {
      dominantFreqHz: dominantFreqHz > 0 ? clamp(dominantFreqHz, 0, fs / 2) : 0,
      cardiacPowerRatio,
      bandPower0_5_4Hz: cardiacPower,
      totalPower,
    };
  }

  private analyzeMorphology(
    signal: number[],
    peakIndices: number[],
  ): MorphologyFeatures {
    if (peakIndices.length < 2 || signal.length < this.TEMPLATE_LENGTH) {
      return { beatConsistency: 0, beatCorrelation: 0, templateMatch: 0 };
    }

    const beats: number[][] = [];
    for (let i = 1; i < peakIndices.length; i++) {
      const start = peakIndices[i - 1] ?? 0;
      const end = peakIndices[i] ?? signal.length - 1;
      const beat = this.resampleSignal(signal.slice(start, end + 1), this.TEMPLATE_LENGTH);
      if (beat.length === this.TEMPLATE_LENGTH) {
        beats.push(beat);
        this.beatBuffer.push(beat);
        if (this.beatBuffer.length > this.BUFFER_MAX) {
          this.beatBuffer.shift();
        }
      }
    }

    if (this.beatBuffer.length < 2) {
      return { beatConsistency: 0, beatCorrelation: 0, templateMatch: 0 };
    }

    this.templateBuffer = this.buildTemplate(this.beatBuffer);

    let totalConsistency = 0;
    let pairs = 0;
    for (let i = 1; i < beats.length; i++) {
      const corr = this.crossCorrelation(beats[i]!, beats[i - 1]!);
      totalConsistency += corr;
      pairs++;
    }
    const beatConsistency = pairs > 0 ? totalConsistency / pairs : 0;

    const latestBeat = beats[beats.length - 1];
    const templateMatch = latestBeat && this.templateBuffer
      ? this.crossCorrelation(latestBeat, this.templateBuffer)
      : 0;

    return {
      beatConsistency: clamp(beatConsistency, 0, 1),
      beatCorrelation: clamp(beatConsistency, 0, 1),
      templateMatch: clamp(templateMatch, 0, 1),
    };
  }

  private analyzeCrossChannel(
    rgbData?: { r: number[]; g: number[]; b: number[] },
  ): CrossChannelFeatures {
    if (!rgbData || rgbData.r.length < 10) {
      return { rChannelCorrelation: 0, gChannelCorrelation: 0, bChannelCorrelation: 0 };
    }

    const minLen = Math.min(rgbData.r.length, rgbData.g.length, rgbData.b.length);
    const r = rgbData.r.slice(0, minLen);
    const g = rgbData.g.slice(0, minLen);
    const b = rgbData.b.slice(0, minLen);

    const rg = this.crossCorrelation(r, g);
    const rb = this.crossCorrelation(r, b);
    const gb = this.crossCorrelation(g, b);

    return {
      rChannelCorrelation: clamp(rg, -1, 1),
      gChannelCorrelation: clamp(rb, -1, 1),
      bChannelCorrelation: clamp(gb, -1, 1),
    };
  }

  beatTemplate(): number[] | null {
    return this.templateBuffer;
  }

  private findTroughBetween(signal: number[], start: number, end: number): number {
    let minIdx = start;
    let minVal = signal[start] ?? Infinity;
    for (let i = start; i <= end && i < signal.length; i++) {
      if ((signal[i] ?? 0) < minVal) {
        minVal = signal[i] ?? 0;
        minIdx = i;
      }
    }
    return minIdx;
  }

  private findNextTrough(signal: number[], start: number): number | null {
    for (let i = start + 1; i < signal.length - 1; i++) {
      if ((signal[i] ?? 0) <= (signal[i - 1] ?? 0) && (signal[i] ?? 0) <= (signal[i + 1] ?? 0)) {
        return i;
      }
    }
    return null;
  }

  private detectDicroticNotch(signal: number[], peakIdx: number, endIdx: number): number {
    const searchStart = Math.min(peakIdx, signal.length - 1);
    const searchEnd = Math.min(endIdx, signal.length - 1);
    if (searchEnd - searchStart < 3) return -1;

    let bestIdx = -1;
    let bestScore = 0;
    for (let i = searchStart + 1; i < searchEnd - 1; i++) {
      const leftSlope = (signal[i] ?? 0) - (signal[i - 1] ?? 0);
      const rightSlope = (signal[i + 1] ?? 0) - (signal[i] ?? 0);
      const concavity = rightSlope - leftSlope;
      if (concavity > bestScore) {
        bestScore = concavity;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private resampleSignal(signal: number[], targetLen: number): number[] {
    const n = signal.length;
    if (n === 0) return [];
    if (n === targetLen) return [...signal];
    const result: number[] = [];
    for (let i = 0; i < targetLen; i++) {
      const pos = (i / (targetLen - 1)) * (n - 1);
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = signal[idx] ?? 0;
      const b = idx + 1 < n ? signal[idx + 1] ?? 0 : a;
      result.push(a + frac * (b - a));
    }
    return result;
  }

  private buildTemplate(beats: number[][]): number[] {
    const n = beats.length;
    if (n === 0) return [];
    const len = beats[0]?.length ?? 0;
    if (len === 0) return [];
    const template = new Array(len).fill(0);
    for (let i = 0; i < len; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        sum += beats[j]?.[i] ?? 0;
      }
      template[i] = sum / n;
    }
    return template;
  }

  private crossCorrelation(a: number[], b: number[]): number {
    const n = Math.min(a.length, b.length);
    if (n < 3) return 0;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i] ?? 0; mb += b[i] ?? 0; }
    ma /= n; mb /= n;

    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const ad = (a[i] ?? 0) - ma;
      const bd = (b[i] ?? 0) - mb;
      num += ad * bd;
      da += ad * ad;
      db += bd * bd;
    }
    const denom = Math.sqrt(da * db);
    return denom > 1e-10 ? num / denom : 0;
  }
}

function fallbackWaveform(): WaveformFeatures {
  return { riseTimeMs: 0, fallTimeMs: 0, asymmetryRatio: 0, hasNotch: false, notchPosition: -1, systolicSlope: 0, diastolicSlope: 0 };
}

function fallbackPerfusion(): PerfusionFeatures {
  return { acDcRatio: 0, perfusionIndex: 0, acAmplitude: 0, dcLevel: 0 };
}

function fallbackFrequency(): FrequencyFeatures {
  return { dominantFreqHz: 0, cardiacPowerRatio: 0, bandPower0_5_4Hz: 0, totalPower: 0 };
}
