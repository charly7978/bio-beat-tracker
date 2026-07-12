/**
 * PHYSIOLOGICAL PRIORS — evidencias físicas de perfusión de tejido vivo.
 *
 * Firma de volumen sanguíneo multi-longitud de onda (BVP signature, de Haan):
 * en tejido perfundido, la pulsatilidad (AC/DC) existe en el canal rojo y guarda
 * una relación característica con la del verde porque ambas provienen del MISMO
 * cambio de volumen sanguíneo. Un objeto rojo iluminado por el flash no produce
 * pulsatilidad dependiente de longitud de onda con esa relación → discriminador
 * robusto de "tejido vivo" que un color plano no puede falsear.
 *
 * Además provee coherencia RR↔HR (plausibilidad hemodinámica básica) como prior
 * para el modelo de emisión del régimen.
 */
import { clamp } from '../../utils/math';
import { VITAL_THRESHOLDS } from '../../config/vitalThresholds';
import { smoothstep, plateau, softAnd } from './scoring';
import type { CvsiInput } from './types';

/** Piso de pulsatilidad (AC/DC) por debajo del cual no hay perfusión creíble. */
const PERFUSION_FLOOR = 0.0006;
const PERFUSION_REF = 0.01;
/** Banda fisiológica del ratio-of-ratios rojo/verde (proxy del R de SpO2). */
const R_LO = VITAL_THRESHOLDS.SPO2.R_VALUE_MIN; // 0.1
const R_HI = VITAL_THRESHOLDS.SPO2.R_VALUE_MAX; // 2.5
const R_SIGMA = 0.35;

/**
 * Coherencia pulsátil multi-longitud de onda (0–1). Alta = ambos canales
 * pulsan con una relación fisiológica (tejido perfundido); baja = pulsatilidad
 * ausente o sin relación coherente (objeto / ruido óptico).
 */
export function computeBvpCoherence(channels: CvsiInput['spo2Channels']): number {
  if (!channels) return 0;
  const { acRed, dcRed, acGreen, dcGreen } = channels;
  const perfRed = dcRed > 1e-6 ? Math.abs(acRed) / dcRed : 0;
  const perfGreen = dcGreen > 1e-6 ? Math.abs(acGreen) / dcGreen : 0;

  // Ambos canales deben mostrar pulsatilidad real.
  const presenceRed = smoothstep(PERFUSION_FLOOR, PERFUSION_REF, perfRed);
  const presenceGreen = smoothstep(PERFUSION_FLOOR, PERFUSION_REF, perfGreen);

  // El ratio-of-ratios debe caer en banda fisiológica.
  const ratio = perfGreen > 1e-9 ? perfRed / perfGreen : 0;
  const ratioPlausibility = ratio > 0 ? plateau(R_LO, R_HI, R_SIGMA, ratio) : 0;

  return clamp(softAnd(presenceRed, presenceGreen, ratioPlausibility), 0, 1);
}

/**
 * Coeficiente de variación de una serie de intervalos RR (irregularidad del
 * ritmo). Alto → ritmo irregular (fibrilación-like); bajo → ritmo regular.
 */
export function computeRrCv(rrIntervalsMs: number[]): number {
  if (rrIntervalsMs.length < 3) return 0;
  let sum = 0;
  for (const rr of rrIntervalsMs) sum += rr;
  const m = sum / rrIntervalsMs.length;
  if (m < 1e-6) return 0;
  let varSum = 0;
  for (const rr of rrIntervalsMs) {
    const d = rr - m;
    varSum += d * d;
  }
  const sd = Math.sqrt(varSum / rrIntervalsMs.length);
  return clamp(sd / m, 0, 2);
}

/**
 * Evidencia de latidos prematuros (ectopia): firma "acoplamiento corto + pausa
 * compensatoria" (un RR corto seguido de uno largo cuya suma ≈ 2× la mediana).
 * Devuelve un score 0–1 según la fracción de pares corto-largo detectados.
 */
export function computeEctopyScore(rrIntervalsMs: number[]): number {
  if (rrIntervalsMs.length < 4) return 0;
  const sorted = [...rrIntervalsMs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median < 1e-6) return 0;
  let prematurePairs = 0;
  let candidates = 0;
  for (let i = 0; i < rrIntervalsMs.length - 1; i++) {
    const short = rrIntervalsMs[i]!;
    const next = rrIntervalsMs[i + 1]!;
    candidates++;
    const isShort = short < 0.85 * median;
    const isCompensatory = next > 1.1 * median;
    const pairSum = short + next;
    const nearDouble = Math.abs(pairSum - 2 * median) < 0.4 * median;
    if (isShort && isCompensatory && nearDouble) prematurePairs++;
  }
  if (candidates === 0) return 0;
  return clamp((prematurePairs / candidates) * 3, 0, 1);
}
