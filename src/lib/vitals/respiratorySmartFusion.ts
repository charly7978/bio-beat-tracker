/**
 * Respiratory Rate — Multi-Modality "Smart Fusion"
 * ================================================
 * Implementa el estimador de frecuencia respiratoria de Karlen et al. (2013,
 * IEEE Trans. Biomed. Eng., "Multiparameter Respiratory Rate Estimation From
 * the Photoplethysmogram"), el método derivado-de-PPG más citado de la
 * literatura. La respiración modula el PPG por tres mecanismos fisiológicos
 * independientes; se estima la frecuencia respiratoria de CADA uno y se fusiona
 * solo cuando concuerdan — lo que da alta especificidad (rechaza ventanas
 * ambiguas en vez de inventar un número):
 *
 *   - RIAV (Respiratory-Induced Amplitude Variation): la amplitud del pulso
 *     sube y baja con la respiración → envolvente del PPG pulsátil.
 *   - RIIV (Respiratory-Induced Intensity Variation): el baseline/DC se desplaza
 *     con la presión intratorácica → canal LP en banda respiratoria.
 *   - RIFV (Respiratory-Induced Frequency Variation): la arritmia sinusal
 *     respiratoria (RSA) modula el intervalo entre latidos → serie RR.
 *
 * Cada modalidad se lleva a una serie uniforme y se estima su frecuencia
 * dominante por autocorrelación dentro de la banda respiratoria. La "Smart
 * Fusion" promedia (ponderado por calidad) las estimaciones SOLO si su
 * desviación estándar es baja; si discrepan, baja drásticamente la confianza.
 *
 * Módulo PURO y sin estado (testeable de forma determinista). No toca el path
 * de detección de latidos.
 */
import {
  bandLimitedDominantFreq,
  detrendLinear,
  movingAverage,
  resampleToUniformTimeline,
} from '@/modules/signal-processing/shared/dsp';
import { RESP_SMART_FUSION } from '@/config/signalProcessing';
import { clamp } from '@/utils/math';

export interface RespModalityEstimate {
  available: boolean;
  /** Respiraciones por minuto estimadas por esta modalidad */
  rpm: number;
  /** Calidad 0–1 (concentración espectral del periodograma) */
  quality: number;
}

export interface RespModalities {
  riav: RespModalityEstimate;
  riiv: RespModalityEstimate;
  rifv: RespModalityEstimate;
  /** ACC: respiración derivada del acelerómetro (IMU) — modalidad no-óptica. */
  acc: RespModalityEstimate;
}

export interface RespSmartFusionResult {
  available: boolean;
  /** Frecuencia respiratoria fusionada (rpm) */
  rpm: number;
  /** Confianza 0–1 del valor fusionado */
  confidence: number;
  /** Concordancia 0–1 entre las modalidades disponibles (1 = idénticas) */
  agreement: number;
  /** Cuántas modalidades participaron en la fusión */
  fusedCount: number;
  modalities: RespModalities;
}

const EMPTY_MODALITY: RespModalityEstimate = { available: false, rpm: 0, quality: 0 };

/**
 * Estima la frecuencia respiratoria (rpm) de una serie uniformemente muestreada
 * con un periodograma band-limitado (ver `bandLimitedDominantFreq`): elige el
 * fundamental por energía espectral → sin ambigüedad de sub-armónico (Karlen
 * 2013 usa FFT). La calidad es la concentración espectral del pico (0–1).
 */
export function estimateRespRateFromSeries(
  series: number[],
  fsHz: number,
  minRpm: number,
  maxRpm: number,
): RespModalityEstimate {
  const n = series.length;
  if (n < RESP_SMART_FUSION.MIN_SERIES_SAMPLES || fsHz < 1 || maxRpm <= minRpm) {
    return EMPTY_MODALITY;
  }

  // Detrend (quita tendencia lineal) antes del periodograma, que además centra.
  const det = detrendLinear(series);
  const { freqHz, quality } = bandLimitedDominantFreq(det, fsHz, minRpm / 60, maxRpm / 60);
  if (freqHz <= 0 || quality < RESP_SMART_FUSION.MIN_MODALITY_QUALITY) return EMPTY_MODALITY;

  const rpm = freqHz * 60;
  if (rpm < minRpm || rpm > maxRpm) return EMPTY_MODALITY;
  return { available: true, rpm, quality };
}

/**
 * RIAV — envolvente de amplitud del PPG pulsátil. Se rectifica la señal
 * detrended y se suaviza con una ventana ≈ un periodo de pulso; lo que queda
 * oscilando es la modulación respiratoria de la amplitud.
 */
export function extractRiavEnvelope(
  pulseSeries: number[],
  fsHz: number,
  approxBpm: number,
): number[] {
  const n = pulseSeries.length;
  if (n < RESP_SMART_FUSION.MIN_SERIES_SAMPLES) return [];
  const det = detrendLinear(pulseSeries);
  const periodSamples =
    approxBpm > 30
      ? Math.max(3, Math.round((60 / approxBpm) * fsHz))
      : Math.max(3, Math.round(0.8 * fsHz));
  const rectified = det.map((v) => Math.abs(v));
  return movingAverage(rectified, periodSamples);
}

/**
 * RIFV — convierte intervalos RR (ms) en una serie uniforme: ubica cada RR en el
 * tiempo (suma acumulada) y re-muestrea a `targetFsHz`. La serie resultante
 * oscila a la frecuencia respiratoria por la RSA.
 */
export function buildRifvSeries(
  rrIntervalsMs: number[],
  targetFsHz: number,
): { series: number[]; fsHz: number } {
  const n = rrIntervalsMs.length;
  if (n < RESP_SMART_FUSION.RIFV_MIN_RR) return { series: [], fsHz: targetFsHz };

  const t = new Array<number>(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += rrIntervalsMs[i];
    t[i] = acc;
  }
  const durationMs = t[n - 1] - t[0];
  if (durationMs <= 0) return { series: [], fsHz: targetFsHz };

  const targetCount = clamp(Math.round((durationMs / 1000) * targetFsHz), 8, 256);
  const r = resampleToUniformTimeline(rrIntervalsMs, t, targetCount);
  return { series: r.y, fsHz: r.fs };
}

/**
 * Smart Fusion (Karlen 2013): fusiona las estimaciones por modalidad.
 *   - 0 disponibles → no hay estimación.
 *   - 1 disponible  → se usa con confianza reducida.
 *   - ≥2 que concuerdan (std ≤ AGREEMENT_STD_RPM) → media ponderada por calidad,
 *     alta confianza.
 *   - ≥2 que discrepan → se reporta la de mayor calidad con confianza muy baja
 *     (la fusión NO promedia ruido; preserva la especificidad del método).
 */
export function smartFuseRespiration(modalities: RespModalities): RespSmartFusionResult {
  const list = [modalities.riav, modalities.riiv, modalities.rifv, modalities.acc].filter(
    (m) => m.available,
  );

  if (list.length === 0) {
    return { available: false, rpm: 0, confidence: 0, agreement: 0, fusedCount: 0, modalities };
  }

  if (list.length === 1) {
    const m = list[0];
    return {
      available: true,
      rpm: m.rpm,
      confidence: clamp(m.quality * RESP_SMART_FUSION.SINGLE_MODALITY_CONF_SCALE, 0, 1),
      agreement: 0,
      fusedCount: 1,
      modalities,
    };
  }

  const rpms = list.map((m) => m.rpm);
  const mean = rpms.reduce((a, b) => a + b, 0) / rpms.length;
  const variance = rpms.reduce((a, b) => a + (b - mean) ** 2, 0) / rpms.length;
  const std = Math.sqrt(variance);
  const agreement = clamp(1 - std / RESP_SMART_FUSION.AGREEMENT_STD_RPM, 0, 1);

  if (std > RESP_SMART_FUSION.AGREEMENT_STD_RPM) {
    const best = list.reduce((a, b) => (b.quality > a.quality ? b : a));
    return {
      available: true,
      rpm: best.rpm,
      confidence: clamp(best.quality * RESP_SMART_FUSION.DISAGREEMENT_CONF_SCALE, 0, 1),
      agreement,
      fusedCount: list.length,
      modalities,
    };
  }

  // Concuerdan: media ponderada por calidad.
  let wSum = 0;
  let vSum = 0;
  for (const m of list) {
    wSum += m.quality;
    vSum += m.quality * m.rpm;
  }
  const rpm = wSum > 1e-6 ? vSum / wSum : mean;
  const avgQuality = list.reduce((a, b) => a + b.quality, 0) / list.length;
  // Más modalidades concordantes + mayor calidad + mayor concordancia → más confianza.
  const confidence = clamp(
    avgQuality * (0.6 + 0.4 * agreement) * (1 + 0.15 * (list.length - 2)),
    0,
    1,
  );

  return { available: true, rpm, confidence, agreement, fusedCount: list.length, modalities };
}

/**
 * Orquestador de alto nivel: extrae las modalidades ÓPTICAS (RIAV/RIIV/RIFV) de
 * las señales de cámara y las fusiona con la modalidad NO-óptica del acelerómetro
 * (ACC, ya estimada en el procesador de señal porque vive con el sensor IMU).
 *
 * @param pulseSeries   PPG pulsátil uniformemente muestreado (para RIAV)
 * @param respBandSeries canal LP en banda respiratoria (para RIIV)
 * @param fsHz          frecuencia de muestreo de pulseSeries y respBandSeries
 * @param rrIntervalsMs intervalos RR recientes en ms (para RIFV)
 * @param approxBpm     HR aproximada (ventana de envolvente RIAV)
 * @param minRpm/maxRpm banda respiratoria fisiológica
 * @param accModality   estimación respiratoria del acelerómetro (opcional)
 */
export function estimateRespiratorySmartFusion(input: {
  pulseSeries: number[];
  respBandSeries: number[];
  fsHz: number;
  rrIntervalsMs: number[];
  approxBpm: number;
  minRpm: number;
  maxRpm: number;
  accModality?: RespModalityEstimate;
}): RespSmartFusionResult {
  const { pulseSeries, respBandSeries, fsHz, rrIntervalsMs, approxBpm, minRpm, maxRpm } = input;

  const riavEnv = extractRiavEnvelope(pulseSeries, fsHz, approxBpm);
  const riav = estimateRespRateFromSeries(riavEnv, fsHz, minRpm, maxRpm);
  const riiv = estimateRespRateFromSeries(respBandSeries, fsHz, minRpm, maxRpm);

  const rifvBuilt = buildRifvSeries(rrIntervalsMs, RESP_SMART_FUSION.RIFV_RESAMPLE_HZ);
  const rifv =
    rifvBuilt.series.length >= RESP_SMART_FUSION.MIN_SERIES_SAMPLES
      ? estimateRespRateFromSeries(rifvBuilt.series, rifvBuilt.fsHz, minRpm, maxRpm)
      : EMPTY_MODALITY;

  const acc = input.accModality ?? EMPTY_MODALITY;

  return smartFuseRespiration({ riav, riiv, rifv, acc });
}
