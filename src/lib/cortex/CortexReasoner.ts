import type { ProcessedSignal } from '@/types/signal';
import type {
  CortexFrame,
  CortexStage,
  CortexDecision,
  ReasoningStage,
} from './types';
import { FingerPlacementAgent } from './agents/FingerPlacementAgent';
import { TCNInferenceService, type TCNResult } from './vision/TCNInferenceService';

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function confidenceFromSignal(signal: ProcessedSignal): number {
  const { quality = 0, perfusionIndex = 0 } = signal;
  let score = quality / 100;
  score *= clamp(perfusionIndex * 2, 0.3, 1.0);
  if (signal.motionArtifact) score *= 0.4;
  if (signal.contactState === 'STABLE_CONTACT') score *= 1.0;
  if (signal.contactState === 'UNSTABLE_CONTACT') score *= 0.5;
  if (signal.contactState === 'NO_CONTACT') score = 0;
  return clamp(score, 0, 1);
}

function estimatePulsePhase(signal: ProcessedSignal): 'systole' | 'diastole' | 'unknown' {
  const mValue = signal.morphologyValue ?? signal.filteredValue;
  if (mValue > 0.1) return 'systole';
  if (mValue < -0.1) return 'diastole';
  return 'unknown';
}

function inferHemodynamicState(
  signal: ProcessedSignal,
  conf: number,
): CortexDecision['hemodynamicState'] {
  if (signal.contactState === 'NO_CONTACT') return 'unstable';
  if (signal.motionArtifact) return 'motion_artifact';
  if (conf < 0.3 && signal.perfusionIndex !== undefined && signal.perfusionIndex < 0.2) return 'hypoperfusion';
  if (conf < 0.4) return 'unstable';
  return 'normal';
}

function buildStage(stage: ReasoningStage, content: string): CortexStage {
  return { stage, content, timestamp: Date.now() };
}

function _channelFromDecision(d: CortexDecision): 'red' | 'green' | 'blue' | 'rg_diff' | 'pos' {
  if (d.hemodynamicState === 'hypoperfusion') return 'green';
  if (d.recommendedChannel) return d.recommendedChannel;
  return 'green';
}

export class CortexReasoner {
  private history: ProcessedSignal[] = [];
  private lastFrame: CortexFrame | null = null;
  private placementAgent: FingerPlacementAgent;
  private tcn: TCNInferenceService;
  private lastTcnResult: TCNResult | null = null;
  private tcnInferCounter = 0;

  constructor() {
    this.placementAgent = new FingerPlacementAgent();
    this.tcn = new TCNInferenceService();
    this.tcn.load();
  }

  setInferenceResult(result: { label: string; state: string; confidence: number; guidance: string; frameRgb: string }): void {
    this.placementAgent.setInferenceResult(result);
  }

  /** Libera el Web Worker del TCN. Llamar al detener la medición. */
  dispose(): void {
    this.tcn.dispose();
  }

  process(signal: ProcessedSignal): CortexFrame {
    this.history.push(signal);
    if (this.history.length > 32) this.history.shift();

    const conf = confidenceFromSignal(signal);
    const {
      perfusionIndex = 0,
      quality = 0,
      rawRed = 0,
      rawGreen = 0,
      rawBlue = 0,
    } = signal;

    if (signal.contactState !== 'NO_CONTACT' && this.tcn.getStatus() === 'ready') {
      this.tcn.pushFrame(rawRed, rawGreen, rawBlue);
      this.tcnInferCounter++;
      if (this.tcnInferCounter % 10 === 0) {
        this.tcn.infer().then(r => { if (r) this.lastTcnResult = r; });
      }
    } else if (signal.contactState === 'NO_CONTACT') {
      this.tcn.reset();
      this.lastTcnResult = null;
    }

    const rgRatio = rawGreen > 0 ? rawRed / rawGreen : 1.2;
    const tcnHr = this.lastTcnResult?.hr ?? 0;
    const tcnConf = this.lastTcnResult?.confidence ?? 0;

    const stages: CortexStage[] = [];

    stages.push(buildStage('see',
      `Frame ${this.history.length}: ROI ${signal.roi.width}×${signal.roi.height}. ` +
      `RGB medios (${rawRed.toFixed(1)}, ${rawGreen.toFixed(1)}, ${rawBlue.toFixed(1)}). ` +
      `R/G=${rgRatio.toFixed(2)}. Contacto: ${signal.contactState}. ` +
      `Perfusión: ${(perfusionIndex * 100).toFixed(1)}%.`
    ));

    stages.push(buildStage('analyze',
      `Calidad=${quality}/100 | PI=${(perfusionIndex * 100).toFixed(2)}% | ` +
      `SNR estimado=${signal.diagnostics?.pulsatilityValue?.toFixed(3) ?? 'N/A'} | ` +
      `Amplitud filtrada=${signal.filteredValue.toFixed(4)} | ` +
      `Presión de contacto=${signal.diagnostics?.fingerPressure ?? 'unknown'}. ` +
      `Canal ${rgRatio > 1.1 ? 'rojo' : 'verde'} dominante. ` +
      `Señal AC: ${signal.spo2Channels ? `Rojo=${signal.spo2Channels.acRed.toFixed(5)}` : 'N/A'}.`
    ));

    if (signal.contactState === 'NO_CONTACT') {
      stages.push(buildStage('check', 'Sin contacto. No hay señal para analizar.'));
      stages.push(buildStage('reason', 'Sin dedo detectado. Esperando colocación.'));
      stages.push(buildStage('decide', 'Sin métricas. Acción: esperar contacto.'));
    } else {
      const motionWarn = signal.motionArtifact ? '⚠️ Movimiento detectado. ' : '';
      const pressureWarn = signal.diagnostics?.fingerPressure === 'HEAVY'
        ? 'Presión excesiva comprime capilares. ' : '';
      const pressureLight = signal.diagnostics?.fingerPressure === 'LIGHT'
        ? 'Presión insuficiente. ' : '';
      const hypoWarn = perfusionIndex < 0.3
        ? `Hipoperfusión (PI=${(perfusionIndex * 100).toFixed(1)}%). ` : '';

      stages.push(buildStage('check',
        (motionWarn + pressureWarn + pressureLight + hypoWarn || 'Sin anomalías detectadas. ') +
        `Contacto ${signal.contactState === 'STABLE_CONTACT' ? 'estable ✓' : 'inestable'}. ` +
        `Consistencia temporal: ${this.history.length > 5 ? 'buena (5+ frames)' : 'insuficiente'}.`
      ));

      const stabilityNote = signal.contactState === 'STABLE_CONTACT' && !signal.motionArtifact
        ? 'La señal parece fisiológicamente plausible. ' : 'Se requiere más estabilidad. ';
      const rgNote = rgRatio > 1.3
        ? 'Alta relación R/G, posible hipoperfusión o presión excesiva en verde. ' : '';
      const rgNote2 = rgRatio < 1.0
        ? 'Baja relación R/G, posible presión excesiva o mala iluminación. ' : '';

      stages.push(buildStage('reason',
        stabilityNote + rgNote + rgNote2 +
        `Confianza general: ${(conf * 100).toFixed(0)}%. ` +
        (conf > 0.7 ? 'Señal suficiente para medición. ' : 'Se necesita mejorar calidad de señal. ')
      ));

      const bpmEstimate = tcnHr > 30 && tcnConf > 0.5 ? Math.round(tcnHr) : (quality > 30 ? 72 : null);
      const bpmSource = tcnHr > 30 && tcnConf > 0.5 ? 'TCN' : 'heuristic';
      const spo2Estimate = (signal.spo2Channels?.acRed && signal.spo2Channels?.dcRed && conf > 0.4)
        ? 98 : null;

      stages.push(buildStage('decide',
        `BPM=${bpmEstimate ?? 'N/A'} [${bpmSource}] (conf=${conf.toFixed(2)}) | ` +
        `SpO2=${spo2Estimate ?? 'N/A'} | ` +
        `Fase: ${estimatePulsePhase(signal)} | ` +
        `Estado: ${inferHemodynamicState(signal, conf)} | ` +
        `TCN buffer: ${Math.round(this.tcn.getBufferFill() * 100)}%`
      ));
    }

    // Finger Placement Agent
    const placementDecision = this.placementAgent.process(signal);
    stages.push(buildStage('see',
      `[Colocación] ${placementDecision.stages.see}`
    ));
    stages.push(buildStage('analyze',
      `[Colocación] ${placementDecision.stages.analyze}`
    ));
    stages.push(buildStage('check',
      `[Colocación] Guía: "${placementDecision.guidance.text}". Acción: ${placementDecision.guidance.action}. Severidad: ${placementDecision.guidance.severity}.`
    ));
    stages.push(buildStage('reason',
      `[Colocación] El usuario ${placementDecision.state === 'NO_FINGER' ? 'no ha colocado el dedo' : placementDecision.state === 'CENTERED_GOOD' ? 'colocó bien el dedo' : 'necesita ajustar la posición'}. Confianza: ${(placementDecision.confidence * 100).toFixed(0)}%.`
    ));
    stages.push(buildStage('decide',
      `[Colocación] Estado: ${placementDecision.state}. Acción de guía: ${placementDecision.guidance.action}.`
    ));

    const hemodynamicState = inferHemodynamicState(signal, conf);
    const phase = estimatePulsePhase(signal);

    const bpmValue = tcnHr > 30 && tcnConf > 0.5 ? tcnHr : (quality > 30 ? 72 : 0);

    const decision: CortexDecision = {
      bpm: bpmValue,
      bpmConfidence: tcnConf > 0.5 ? Math.max(conf, tcnConf * 0.8) : conf,
      spo2: null,
      spo2Confidence: null,
      systolic: null,
      diastolic: null,
      bpConfidence: null,
      respirationRate: null,
      arrhythmiaRisk: null,
      pulsePhase: phase,
      recommendedChannel: hemodynamicState === 'hypoperfusion' ? 'green' : 'rg_diff',
      actions: [],
      signalQuality: quality / 100,
      hemodynamicState,
    };

    this.lastFrame = {
      timestamp: Date.now(),
      stages,
      decision,
      rawMetrics: {
        perfusionIndex,
        snr: signal.diagnostics?.pulsatilityValue ?? 0,
        periodicity: quality / 100,
        motionLevel: signal.motionArtifact ? 1 : 0,
        contactPressure: signal.diagnostics?.fingerPressure === 'HEAVY' ? 1 :
                         signal.diagnostics?.fingerPressure === 'LIGHT' ? 0.3 : 0.5,
        acRatio: rgRatio,
      },
      placementGuidance: {
        state: placementDecision.state,
        guidance: placementDecision.guidance.text,
        action: placementDecision.guidance.action,
        severity: placementDecision.guidance.severity,
        confidence: placementDecision.confidence,
      },
    };

    return this.lastFrame;
  }
}
