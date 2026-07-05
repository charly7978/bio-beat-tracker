export type ReasoningStage = 'see' | 'analyze' | 'check' | 'reason' | 'decide';

export interface CortexStage {
  stage: ReasoningStage;
  content: string;
  timestamp: number;
}

export interface CortexDecision {
  bpm: number;
  bpmConfidence: number;
  spo2: number | null;
  spo2Confidence: number | null;
  systolic: number | null;
  diastolic: number | null;
  bpConfidence: number | null;
  respirationRate: number | null;
  arrhythmiaRisk: number | null;
  pulsePhase: 'systole' | 'diastole' | 'unknown';
  recommendedChannel: 'red' | 'green' | 'blue' | 'rg_diff' | 'pos';
  actions: string[];
  signalQuality: number;
  hemodynamicState: 'normal' | 'hypoperfusion' | 'hyperdynamic' | 'arrhythmic' | 'motion_artifact' | 'contact_pressure' | 'unstable';
}

export interface CortexFrame {
  timestamp: number;
  stages: CortexStage[];
  decision: CortexDecision;
  rawMetrics: {
    perfusionIndex: number;
    snr: number;
    periodicity: number;
    motionLevel: number;
    contactPressure: number;
    acRatio: number;
  };
}

export interface CortexSession {
  sessionId: string;
  startTime: number;
  frames: CortexFrame[];
  deviceProfile: string;
  userProfile: string | null;
}
