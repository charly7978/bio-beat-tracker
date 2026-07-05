import type { ProcessedSignal } from '@/types/signal';
import type {
  FingerPlacementState,
  FingerPlacementDecision,
  PlacementGuidance,
  GuidanceAction,
  GuidanceSeverity,
  PlacementMetrics,
} from './types';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const guidanceTemplates: Record<string, { text: string[]; action: GuidanceAction; severity: GuidanceSeverity }[]> = {
  NO_FINGER: [
    { text: ['Apoyá la yema del dedo sobre la cámara y el flash'], action: 'center', severity: 'info' },
    { text: ['Colocá el dedo cubriendo completamente el lente'], action: 'center', severity: 'info' },
    { text: ['Tapá la cámara con la parte ancha del dedo'], action: 'center', severity: 'hint' },
  ],
  PARTIAL_COVERAGE: [
    { text: ['Desplazá el dedo un poco hacia el centro del lente'], action: 'center', severity: 'hint' },
    { text: ['El dedo no cubre toda la lente, movelo suavemente'], action: 'center', severity: 'hint' },
    { text: ['Acomodá la yema para que cubra bien el flash y la cámara'], action: 'center', severity: 'hint' },
    { text: ['Casi ahí, mové el dedo apenas hacia el centro'], action: 'center', severity: 'info' },
  ],
  CENTERED_LOW_PRESSURE: [
    { text: ['Presioná un poco más firme sobre el lente'], action: 'more_pressure', severity: 'hint' },
    { text: ['Hacé un poco más de contacto con la cámara'], action: 'more_pressure', severity: 'info' },
    { text: ['Aumentá apenas la presión del dedo'], action: 'more_pressure', severity: 'hint' },
  ],
  CENTERED_GOOD: [
    { text: ['Posición perfecta, mantené el dedo así'], action: 'none', severity: 'info' },
    { text: ['Bien colocado, sostené firme y sin mover'], action: 'none', severity: 'info' },
    { text: ['Excelente, quedate quieto que ya estamos midiendo'], action: 'none', severity: 'info' },
  ],
  CENTERED_HIGH_PRESSURE: [
    { text: ['Aflojá un poco la presión, estás tapando el flujo'], action: 'less_pressure', severity: 'warn' },
    { text: ['Presionás muy fuerte, soltá un toque'], action: 'less_pressure', severity: 'warn' },
    { text: ['La sangre no circula bien con tanta presión, aflojá'], action: 'less_pressure', severity: 'warn' },
  ],
  MOVEMENT: [
    { text: ['Sostené el dedo quieto, sin temblar'], action: 'steady', severity: 'warn' },
    { text: ['Estás moviendo el dedo, mantenelo firme'], action: 'steady', severity: 'warn' },
    { text: ['Tranqui, sostén el dedo sin mover'], action: 'steady', severity: 'hint' },
  ],
  UNKNOWN: [
    { text: ['Acomodá el dedo sobre la cámara y el flash'], action: 'center', severity: 'info' },
  ],
};

function generateGuidance(state: FingerPlacementState, metrics: PlacementMetrics): PlacementGuidance {
  const templates = guidanceTemplates[state] ?? guidanceTemplates.UNKNOWN;
  const chosen = pick(templates);
  return {
    text: pick(chosen.text),
    action: chosen.action,
    severity: chosen.severity,
  };
}

function classifyPlacement(metrics: PlacementMetrics): {
  state: FingerPlacementState;
  confidence: number;
  explanation: string;
} {
  const { coverage, perfusion, motion, pressure, fingerDetected, contactState } = metrics;

  if (!fingerDetected || contactState === 'NO_CONTACT') {
    return {
      state: 'NO_FINGER',
      confidence: clamp01(coverage < 0.15 ? 0.95 : 0.7),
      explanation: `No se detecta contacto. Cobertura: ${(coverage * 100).toFixed(0)}%, presión: ${pressure}. El dedo no está sobre la cámara o no hay suficiente presión.`,
    };
  }

  if (motion > 0.55) {
    return {
      state: 'MOVEMENT',
      confidence: clamp01(motion),
      explanation: `Movimiento alto (${(motion * 100).toFixed(0)}%). La señal varía por encima del umbral de temblor.`,
    };
  }

  if (coverage < 0.50) {
    return {
      state: 'PARTIAL_COVERAGE',
      confidence: clamp01(1 - coverage / 0.5),
      explanation: `Cobertura parcial: ${(coverage * 100).toFixed(0)}%. El dedo no cubre suficiente área del lente. Presión: ${pressure}.`,
    };
  }

  if (pressure === 'HEAVY' || (coverage > 0.88 && perfusion < 0.0006)) {
    return {
      state: 'CENTERED_HIGH_PRESSURE',
      confidence: 0.8,
      explanation: `Presión excesiva (${pressure}, perfusión ${(perfusion * 10000).toFixed(1)}×10⁻⁴). Alta cobertura (${(coverage * 100).toFixed(0)}%) pero perfusión colapsada.`,
    };
  }

  if (perfusion < 0.0005 || pressure === 'LIGHT') {
    return {
      state: 'CENTERED_LOW_PRESSURE',
      confidence: clamp01(0.8 - perfusion * 500),
      explanation: `Presión baja (${pressure}) o perfusión insuficiente (${(perfusion * 10000).toFixed(1)}×10⁻⁴). Cobertura: ${(coverage * 100).toFixed(0)}%.`,
    };
  }

  if (coverage >= 0.55 && perfusion >= 0.0005 && motion <= 0.4) {
    return {
      state: 'CENTERED_GOOD',
      confidence: clamp01(0.5 + coverage * 0.3 + perfusion * 100),
      explanation: `Colocación correcta. Cobertura: ${(coverage * 100).toFixed(0)}%, perfusión: ${(perfusion * 10000).toFixed(1)}×10⁻⁴, movimiento: ${(motion * 100).toFixed(0)}%.`,
    };
  }

  return {
    state: 'PARTIAL_COVERAGE',
    confidence: 0.5,
    explanation: `Condición mixta. Cobertura: ${(coverage * 100).toFixed(0)}%, perfusión: ${(perfusion * 10000).toFixed(1)}×10⁻⁴, presión: ${pressure}.`,
  };
}

function readMetrics(signal: ProcessedSignal): PlacementMetrics {
  const d = signal.diagnostics;
  return {
    coverage: d?.coverageRatio ?? 0,
    perfusion: signal.perfusionIndex ?? 0,
    motion: d?.sqm?.motionScore ?? 0,
    pressure: d?.fingerPressure ?? 'LIGHT',
    placementMode: signal.placementMode ?? 'hybrid',
    redCv: d?.pulsatilityValue ?? 0,
    fingerDetected: signal.fingerDetected,
    contactState: signal.contactState,
    quality: signal.quality,
  };
}

export class FingerPlacementAgent {
  private lastDecision: FingerPlacementDecision | null = null;

  process(signal: ProcessedSignal): FingerPlacementDecision {
    const metrics = readMetrics(signal);
    const { state, confidence, explanation } = classifyPlacement(metrics);
    const guidance = generateGuidance(state, metrics);

    const see = `Frame #${signal.timestamp}: cobertura ${(metrics.coverage * 100).toFixed(0)}%, R/G/B crudo (${signal.rawRed?.toFixed(0) ?? '?'}, ${signal.rawGreen?.toFixed(0) ?? '?'}, ${signal.rawBlue?.toFixed(0) ?? '?'})`;
    const analyze = `Estado: ${state}. ${explanation}`;
    const check = `Confianza: ${(confidence * 100).toFixed(0)}%. Contacto: ${metrics.contactState}. Huella hemoglobina: ${metrics.coverage > 0.11 ? 'detectable' : 'no detectable'}.`;
    const reason = `El usuario necesita: "${guidance.text}". Acción: ${guidance.action}. Severidad: ${guidance.severity}.`;
    const decide = `Decisión: ${state}. Guía: ${guidance.action}.`;

    const decision: FingerPlacementDecision = {
      state,
      confidence,
      guidance,
      metrics,
      reasoning: explanation,
      stages: { see, analyze, check, reason, decide },
    };

    this.lastDecision = decision;
    return decision;
  }

  getLastDecision(): FingerPlacementDecision | null {
    return this.lastDecision;
  }

  reset(): void {
    this.lastDecision = null;
  }
}
