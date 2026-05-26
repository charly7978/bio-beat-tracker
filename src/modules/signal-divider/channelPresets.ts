import type { VisualTransform } from '../signal-processing/visualTransform';

/**
 * Parámetros AGC (Automatic Gain Control) especializados por canal.
 * Diferentes vitales requieren targets y ventanas distintas:
 *   - HR/HRV: target moderado, ventana media (pulso periódico)
 *   - SpO2: target bajo, ventana larga (anti-saturación para ratio Beer-Lambert)
 *   - BP: target alto, ventana corta (preservar transients morfológicos)
 *   - RESP: target alto, ventana muy larga (señal lenta, evita oscilación AGC)
 */
export interface ChannelAgcParams {
  /** Amplitud objetivo en cuentas (típico 30-55 según vital) */
  target: number;
  /** Tail/ventana del RMS para estimar amplitud actual (frames) */
  tail: number;
  /** Rango del escalado: [min, max] */
  scaleMin: number;
  scaleMax: number;
  /** Smoothing del AGC (alpha EMA): bajo=lento/estable, alto=rápido/inestable */
  smoothAlpha: number;
}

/** Preprocesamiento visual + filtros + AGC + stride para cada canal */
export interface SignalChannelPreset {
  name: string;
  label: string;
  visual: VisualTransform;
  pixelStride: number;
  bandpassLow: number;
  bandpassHigh: number;
  bandpassOrder: number;
  zeroPhase: boolean;
  sharpen?: number;
  dominantChannel: 'R' | 'G' | 'B' | 'RG';
  /** Cómo tratar la DC: 'preserve' para SpO2, 'remove' para HR, 'partial' para BP */
  dcMode: 'preserve' | 'remove' | 'partial';
  /** AGC especializado por vital (target/tail/range/smoothing) */
  agc: ChannelAgcParams;
}

// ─────────────────────────────────────────────────────────────────
// AGC presets — derivados de literatura PPG smartphone
// ─────────────────────────────────────────────────────────────────

/** HR/HRV: target 0.5, ventana media (~1.6s @30fps)
 *  Satura la escala máxima en señales muy débiles y regula cuando el bandpass
 *  supera target/scaleMax = 0.05. */
const AGC_HR_LIKE: ChannelAgcParams = {
  target: 0.5, tail: 48, scaleMin: 0.5, scaleMax: 10.0, smoothAlpha: 0.20,
};

/** SpO2: target bajo (preserva rango dinámico para Beer-Lambert), ventana larga */
const AGC_SPO2: ChannelAgcParams = {
  target: 0.3, tail: 72, scaleMin: 0.3, scaleMax: 8.0, smoothAlpha: 0.12,
};

/** HRV: igual que HR pero ventana mayor para estabilidad temporal de RR */
const AGC_HRV: ChannelAgcParams = {
  target: 0.5, tail: 64, scaleMin: 0.5, scaleMax: 10.0, smoothAlpha: 0.18,
};

/** RESP: target 0.5, ventana MUY larga (señal lenta 0.1-0.5Hz) */
const AGC_RESP: ChannelAgcParams = {
  target: 0.5, tail: 120, scaleMin: 0.4, scaleMax: 10.0, smoothAlpha: 0.08,
};

/** BP: target 0.5, ventana CORTA (preserva morfología/dicrotic notch viva) */
const AGC_BP: ChannelAgcParams = {
  target: 0.5, tail: 32, scaleMin: 0.5, scaleMax: 10.0, smoothAlpha: 0.28,
};

export const HR_CHANNEL: SignalChannelPreset = {
  name: 'hr',
  label: 'Heart Rate',
  visual: { rScale: 0.7, gScale: 1.5, bScale: 0.5, brightness: 5, gamma: 0.8, contrast: 1.2, clampMin: 10, clampMax: 245 },
  pixelStride: 3,
  bandpassLow: 0.8,
  bandpassHigh: 3.0,
  bandpassOrder: 4,
  zeroPhase: false,
  dominantChannel: 'G',
  dcMode: 'remove',
  agc: AGC_HR_LIKE,
};

export const SPO2_CHANNEL: SignalChannelPreset = {
  name: 'spo2',
  label: 'SpO₂',
  visual: { rScale: 1.3, gScale: 1.0, bScale: 0.7, brightness: -3, gamma: 1.2, contrast: 1.0, clampMin: 20, clampMax: 240 },
  pixelStride: 3,
  bandpassLow: 0.5,
  bandpassHigh: 5.0,
  bandpassOrder: 2,
  zeroPhase: false,
  dominantChannel: 'R',
  dcMode: 'preserve',
  agc: AGC_SPO2,
};

export const HRV_CHANNEL: SignalChannelPreset = {
  name: 'hrv',
  label: 'HRV',
  visual: { rScale: 1.3, gScale: 1.3, bScale: 0.6, brightness: 0, gamma: 1.0, contrast: 1.1, clampMin: 5, clampMax: 250 },
  pixelStride: 3,
  bandpassLow: 0.5,
  bandpassHigh: 3.0,
  bandpassOrder: 4,
  zeroPhase: true,
  dominantChannel: 'G',
  dcMode: 'remove',
  agc: AGC_HRV,
};

export const RESP_CHANNEL: SignalChannelPreset = {
  name: 'resp',
  label: 'Respiración',
  visual: { rScale: 1.2, gScale: 1.2, bScale: 0.8, brightness: 2, gamma: 0.9, contrast: 0.9, clampMin: 20, clampMax: 250 },
  pixelStride: 3,
  bandpassLow: 0.1,
  bandpassHigh: 0.5,
  bandpassOrder: 2,
  zeroPhase: false,
  dominantChannel: 'G',
  dcMode: 'remove',
  agc: AGC_RESP,
};

export const BP_CHANNEL: SignalChannelPreset = {
  name: 'bp',
  label: 'Presión Arterial',
  visual: { rScale: 1.4, gScale: 0.8, bScale: 0.5, brightness: 8, gamma: 0.7, contrast: 1.4, clampMin: 15, clampMax: 250 },
  pixelStride: 2,
  bandpassLow: 0.5,
  bandpassHigh: 8.0,
  bandpassOrder: 4,
  zeroPhase: false,
  sharpen: 0.3,
  dominantChannel: 'R',
  dcMode: 'partial',
  agc: AGC_BP,
};

export const ALL_CHANNELS: SignalChannelPreset[] = [
  HR_CHANNEL, SPO2_CHANNEL, HRV_CHANNEL, RESP_CHANNEL, BP_CHANNEL,
];
