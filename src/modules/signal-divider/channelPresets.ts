import type { VisualTransform } from '../signal-processing/visualTransform';

/** Preprocesamiento visual + filtros + stride para cada canal */
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
}

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
};

export const ALL_CHANNELS: SignalChannelPreset[] = [
  HR_CHANNEL, SPO2_CHANNEL, HRV_CHANNEL, RESP_CHANNEL, BP_CHANNEL,
];
