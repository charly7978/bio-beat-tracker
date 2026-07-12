/**
 * REASONING NARRATIVE — traza de razonamiento legible del motor.
 *
 * Convierte el estado inferido en una explicación en lenguaje natural. No es
 * decorativo: expone POR QUÉ el motor cree lo que cree (qué evidencia apoya o
 * contradice la presencia de un pulso real), lo que hace el sistema auditable y
 * transparente para el usuario y el desarrollo.
 */
import type { CardiovascularRegime, CvsiState, GenerativePulseDiagnostics } from './types';

const REGIME_LABEL: Record<CardiovascularRegime, string> = {
  NO_PERFUSION: 'Sin señal cardiovascular',
  SINUS_NORMAL: 'Ritmo sinusal normal',
  TACHYCARDIA: 'Taquicardia (ritmo acelerado)',
  BRADYCARDIA: 'Bradicardia (ritmo lento)',
  IRREGULAR: 'Ritmo irregular',
  ECTOPIC: 'Latidos prematuros (ectopia)',
  MOTION: 'Señal contaminada por movimiento',
};

export function regimeLabel(regime: CardiovascularRegime): string {
  return REGIME_LABEL[regime];
}

function describeExplanation(gen: GenerativePulseDiagnostics): string {
  if (gen.explainedVariance >= 0.6) return 'la señal se explica bien como un pulso repetible';
  if (gen.explainedVariance >= 0.3) return 'la señal se explica parcialmente como pulso';
  return 'la señal NO es explicable como un pulso cardíaco';
}

export function buildNarrative(
  state: Omit<CvsiState, 'narrative'>,
): string {
  const { mostLikelyRegime, perfusionProbability, heartRate, generative, bvpCoherence } = state;

  if (perfusionProbability < 0.35) {
    const reasons: string[] = [];
    if (generative.explainedVariance < 0.3) reasons.push('sin estructura de pulso predecible');
    if (generative.morphologyLikelihood < 0.3) reasons.push('morfología no cardíaca');
    if (bvpCoherence < 0.2) reasons.push('sin firma pulsátil multi-longitud de onda');
    const why = reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
    return `${REGIME_LABEL[mostLikelyRegime]}: no se detecta un latido real${why}.`;
  }

  const hrPart =
    heartRate.bpm > 0
      ? `Predigo ~${Math.round(heartRate.bpm)} bpm (IC ${Math.round(heartRate.low)}–${Math.round(
          heartRate.high,
        )}${heartRate.converged ? ', convergido' : ''})`
      : 'Estimando frecuencia';
  const explain = describeExplanation(generative);
  const bvpPart = bvpCoherence >= 0.4 ? '; firma multi-λ confirma perfusión' : '';

  return `${REGIME_LABEL[mostLikelyRegime]}. ${hrPart}; ${explain} (var. explicada ${(
    generative.explainedVariance * 100
  ).toFixed(0)}%, creencia ${(perfusionProbability * 100).toFixed(0)}%)${bvpPart}.`;
}
