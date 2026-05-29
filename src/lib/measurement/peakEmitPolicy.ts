/**
 * Política única de emisión de picos PPG.
 *
 * Diseño arritmia-tolerante (validado: detectores PPG en tiempo real detectan
 * latidos por umbral adaptativo + refractario, SIN asumir regularidad RR):
 *   - Refractario FIJO (~300 ms) contra doble conteo / muesca dícrota.
 *   - Sin gate de regularidad RR (permite arritmias y evita el bloqueo
 *     permanente tras un latido perdido).
 *   - La genuinidad del pico la dan Elgendi (umbral + cuadrado + rechazo de
 *     amplitud), el refractario y la confianza del ensemble.
 *
 * Anti-micromovimiento (literatura 2024–2026):
 *   - Skewness mínima de ventana (Elgendi 2016: SQI más fuerte).
 *   - Concordancia mínima del detector durante warm-up (NeuroKit2 ho2025:
 *     doble-detector concordance reduce falsos positivos).
 *   - Warm-up estricto: primeros N picos exigen `weightedScore` alto.
 */
import type { PeakDetectionResult } from '@/types/measurements';
import { PEAK_DETECTION_DEFAULTS } from '@/config/signalProcessing';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { rrMedianMs, scorePeakCandidate } from './peakScoring';

export interface PeakEmitDecision {
  emit: boolean;
  peakTimeMs: number;
  reason: string;
  weightedScore?: number;
}

export interface PeakEmitPolicyInput {
  ens: PeakDetectionResult;
  lastEmittedPeakMs: number;
  minPeakConf: number;
  sampleRateHz: number;
  windowSamples: number;
  fingerContactConfirmed?: boolean;
  nowMs?: number;
  emittedPeakCount?: number;
  /** Tiempo desde el último pico emitido (ms). */
  peakStallMs?: number;
  /** Tras stall prolongado: relajar arranque y ventana viva. */
  reacquireMode?: boolean;
  recentRrMs?: number[];
  sqi?: number;
  perfusionIndex?: number;
  /**
   * Skewness de la ventana de señal — SQI Elgendi 2016. Si < umbral, la ventana
   * está corrupta por movimiento (rechaza emisión). Opcional → si no se provee,
   * el gate no actúa (retro-compatible).
   */
  signalSkewness?: number;
  /**
   * Acuerdo Elgendi (fracción de candidatos consensuados / candidatos totales).
   * Durante warm-up se exige ≥ umbral para emitir.
   */
  elgendiAgreement?: number;
}

export function decidePeakEmit(input: PeakEmitPolicyInput): PeakEmitDecision {
  const {
    ens,
    lastEmittedPeakMs,
    minPeakConf,
    sampleRateHz,
    windowSamples,
    fingerContactConfirmed = true,
    nowMs,
    emittedPeakCount = 0,
    peakStallMs = 0,
    reacquireMode = false,
    recentRrMs = [],
    sqi = 0,
    perfusionIndex = 0,
    signalSkewness,
    elgendiAgreement,
  } = input;

  // ── Gates de arranque (anti-errático): rechazan emisión si la ventana es de
  // baja calidad o el consenso del detector aún no es firme. Solo se activan
  // durante warm-up para no recortar arritmias ya establecidas.
  const inWarmup = emittedPeakCount < PEAK_DETECTION_DEFAULTS.peakEmitWarmupCount;
  // ── Gates de arranque (anti-errático) y asimetría continua (anti-micromovimiento):
  // Rechazan emisión si la ventana está distorsionada (Elgendi 2016).
  if (
    typeof signalSkewness === 'number' &&
    Number.isFinite(signalSkewness)
  ) {
    const minSkew = inWarmup
      ? PEAK_DETECTION_DEFAULTS.peakEmitMinSkewness // 0.18
      : 0.05; // Más tolerante en régimen estable pero bloquea ruido simétrico/tremor
    if (signalSkewness < minSkew) {
      return { emit: false, peakTimeMs: 0, reason: 'LOW_SKEWNESS' };
    }
  }

  if (inWarmup) {
    if (
      typeof elgendiAgreement === 'number' &&
      Number.isFinite(elgendiAgreement) &&
      elgendiAgreement < PEAK_DETECTION_DEFAULTS.peakEmitMinAgreementWarmup
    ) {
      return { emit: false, peakTimeMs: 0, reason: 'LOW_AGREEMENT' };
    }
  }

  const stallReacquire =
    reacquireMode ||
    (fingerContactConfirmed && peakStallMs >= 1500);

  const elConf = (ens.diagnostics as { elgendiConfidence?: number }).elgendiConfidence ?? 0;

  // Refractario FIJO (~300 ms, validado): bloquea doble conteo y muesca dícrota
  // por tiempo SIN escalar con la mediana RR. Así no bloquea latidos prematuros
  // (arritmias) ni se alarga hasta frenar la detección. La dícrota de baja
  // amplitud la filtra Elgendi (cuadrado + rechazo de amplitud relativa).
  const minGap = PEAK_DETECTION_DEFAULTS.peakEmitRefractoryMinMs;

  // Guard "latido imposiblemente temprano" (anti-dícrota a HR baja / doble conteo):
  // sólo por el lado bajo del RR → no recorta HR altas ni bloquea arritmias.
  const prevRrMed = rrMedianMs(recentRrMs);
  const minRrAbs =
    prevRrMed > 0 ? prevRrMed * PEAK_DETECTION_DEFAULTS.peakEmitMinRrFrac : 0;

  const liveEdgeMs = stallReacquire
    ? PEAK_DETECTION_DEFAULTS.peakEmitWindowMs * 1.25
    : PEAK_DETECTION_DEFAULTS.peakEmitWindowMs;
  const liveEdgeSamples = Math.max(6, Math.round(sampleRateHz * (liveEdgeMs / 1000)));

  let bestT = 0;
  let bestScore = 0;

  for (let i = 0; i < ens.peakTimes.length; i++) {
    const t = ens.peakTimes[i] ?? 0;
    // Refractario: única restricción temporal (no asume regularidad → arritmias OK).
    if (t <= 0 || t < lastEmittedPeakMs + minGap) continue;
    // Latido imposiblemente temprano vs ritmo establecido (dícrota/doble conteo).
    // Sólo lado bajo: un RR largo (re-sync tras latido perdido) y los PVC pasan.
    if (minRrAbs > 0 && lastEmittedPeakMs > 0 && t - lastEmittedPeakMs < minRrAbs) continue;
    // Recencia respecto a "ahora" (borde vivo).
    if (nowMs != null && t < nowMs - liveEdgeMs) continue;
    const idx = ens.peaks[i] ?? -1;
    if (nowMs == null) {
      const samplesFromLive = idx >= 0 ? windowSamples - 1 - idx : 999;
      if (samplesFromLive > liveEdgeSamples) continue;
    }
    if (!fingerContactConfirmed) continue;
    // Confianza mínima del ensemble (calidad de señal) — NO regularidad RR.
    if (ens.confidence < minPeakConf) continue;

    const weightedScore =
      ens.peakScores?.[i] ??
      scorePeakCandidate({ elConf, ensConf: ens.confidence, sqi, perfusionIndex });

    // Emite el pico genuino más reciente fuera del refractario.
    if (bestT === 0 || t > bestT || (t === bestT && weightedScore > bestScore)) {
      bestT = t;
      bestScore = weightedScore;
    }
  }

  if (bestT > 0) {
    // Warm-up: exigir score alto sobre el mejor candidato (anti errático inicial).
    if (
      inWarmup &&
      bestScore < PEAK_DETECTION_DEFAULTS.peakEmitWarmupMinScore
    ) {
      return { emit: false, peakTimeMs: 0, reason: 'WARMUP_LOW_SCORE' };
    }
    return { emit: true, peakTimeMs: bestT, reason: 'PEAK_DETECTED', weightedScore: bestScore };
  }

  return { emit: false, peakTimeMs: 0, reason: 'NO_NEW_PEAK' };
}

/** BPM desde RR emitidos con mediana recortada (menos falsos por un outlier). */
export function bpmFromEmittedRr(rrMs: number[]): number {
  if (rrMs.length < 1) return 0;
  const tail = rrMs.slice(-5).filter(
    (d) =>
      d >= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS &&
      d <= VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MAX_MS,
  );
  if (!tail.length) return 0;
  const sorted = [...tail].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] ?? sorted[0]!;
  const trimmed =
    tail.length >= 3
      ? tail.filter((d) => Math.abs(d - med) / med <= 0.22)
      : tail;
  const use = trimmed.length >= 2 ? trimmed : tail;
  const sortedUse = [...use].sort((a, b) => a - b);
  const finalMed = sortedUse[Math.floor(sortedUse.length / 2)] ?? sortedUse[0]!;
  return 60000 / finalMed;
}
