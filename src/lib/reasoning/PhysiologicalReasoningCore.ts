/**
 * PHYSIOLOGICAL REASONING CORE
 *
 * Modelo causal continuo para interpretar qué fenómeno explica mejor la escena
 * óptica. No decide "dedo sí/no" y no reemplaza el razonamiento por un único
 * umbral. Mantiene hipótesis rivales, predice la evolución de la señal, estima
 * incertidumbre y determina por separado qué variables son observables.
 *
 * La memoria adaptativa es auto-supervisada: solo aprende cuando varias familias
 * de evidencia independientes coinciden (óptica, pulsatilidad, temporalidad,
 * consistencia multicanal y baja probabilidad de artefacto). No necesita valores
 * de referencia de otro dispositivo para construir el perfil óptico-fisiológico
 * de este teléfono, esta persona y sus distintas sesiones.
 */

export type PhysiologicalHypothesis =
  | 'PERFUSED_HUMAN_TISSUE'
  | 'POORLY_COUPLED_TISSUE'
  | 'MOTION_DOMINATED_SCENE'
  | 'ILLUMINATION_ARTIFACT'
  | 'STATIC_OR_INERT_SCENE'
  | 'FILTER_RESIDUAL_OR_RINGING'
  | 'UNKNOWN';

export interface VitalObservability {
  heartRate: number;
  rhythm: number;
  morphology: number;
  oxygenation: number;
  pressure: number;
  respiration: number;
}

export interface PhysiologicalReasoningInput {
  timestampMs: number;
  rawRed: number;
  rawGreen: number;
  rawBlue: number;
  coverageRatio: number;
  perfusionIndex: number;
  periodicity: number;
  sqi: number;
  pulseStrength: number;
  filteredValue: number;
  morphologyValue: number;
  motionScore: number;
  signalMotionScore: number;
  centroidMotion?: number;
  saturationRatio: number;
  underexposureRatio: number;
  frameDropRatio?: number;
  timestampJitterMs?: number;
  spo2Channels?: {
    acRed: number;
    dcRed: number;
    acGreen: number;
    dcGreen: number;
    acBlue?: number;
    dcBlue?: number;
  };
}

export interface LearnedFeatureStats {
  mean: number;
  variance: number;
}

export interface LearnedPhysiologyProfile {
  version: 1;
  revision: number;
  acceptedSamples: number;
  confidence: number;
  updatedAtMs: number;
  features: {
    logRg: LearnedFeatureStats;
    logRb: LearnedFeatureStats;
    coverage: LearnedFeatureStats;
    logPi: LearnedFeatureStats;
    periodicity: LearnedFeatureStats;
    sqi: LearnedFeatureStats;
    multiChannelConsistency: LearnedFeatureStats;
    predictionConsistency: LearnedFeatureStats;
  };
}

export interface PhysiologicalEvidenceSnapshot {
  opticalTissueCompatibility: number;
  exposureQuality: number;
  pulsatileDynamics: number;
  temporalCoherence: number;
  multiChannelConsistency: number;
  predictionConsistency: number;
  couplingStability: number;
  motionDominance: number;
  illuminationArtifact: number;
  residualOrRinging: number;
  learnedProfileSimilarity: number;
  commonModeRgbChange: number;
}

export interface PhysiologicalReasoningState {
  timestampMs: number;
  modelVersion: 'physio-reasoner-v1';
  dominantHypothesis: PhysiologicalHypothesis;
  beliefs: Record<PhysiologicalHypothesis, number>;
  perfusedTissueBelief: number;
  observability: VitalObservability;
  evidence: PhysiologicalEvidenceSnapshot;
  uncertainty: number;
  learnedProfileConfidence: number;
  learningAccepted: boolean;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  expectedNextObservation: string;
}

interface FeatureVector {
  logRg: number;
  logRb: number;
  coverage: number;
  logPi: number;
  periodicity: number;
  sqi: number;
  multiChannelConsistency: number;
  predictionConsistency: number;
}

interface DynamicState {
  initialized: boolean;
  previousTimestampMs: number;
  previousRed: number;
  previousGreen: number;
  previousBlue: number;
  previousFiltered: number;
  previousFiltered2: number;
  signalScaleEma: number;
  rgbChangeEma: number;
  recentPerfusedBelief: number;
}

const HYPOTHESES: PhysiologicalHypothesis[] = [
  'PERFUSED_HUMAN_TISSUE',
  'POORLY_COUPLED_TISSUE',
  'MOTION_DOMINATED_SCENE',
  'ILLUMINATION_ARTIFACT',
  'STATIC_OR_INERT_SCENE',
  'FILTER_RESIDUAL_OR_RINGING',
  'UNKNOWN',
];

const EPS = 1e-9;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function smoothstepDown(edge0: number, edge1: number, value: number): number {
  return 1 - smoothstep(edge0, edge1, value);
}

function geometricMean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += Math.log(Math.max(EPS, clamp01(value)));
  return Math.exp(sum / values.length);
}

function softmax(logits: Record<PhysiologicalHypothesis, number>): Record<PhysiologicalHypothesis, number> {
  let maxLogit = -Infinity;
  for (const hypothesis of HYPOTHESES) maxLogit = Math.max(maxLogit, logits[hypothesis]);
  let total = 0;
  const output = {} as Record<PhysiologicalHypothesis, number>;
  for (const hypothesis of HYPOTHESES) {
    const value = Math.exp(logits[hypothesis] - maxLogit);
    output[hypothesis] = value;
    total += value;
  }
  for (const hypothesis of HYPOTHESES) output[hypothesis] /= Math.max(EPS, total);
  return output;
}

function normalizedEntropy(beliefs: Record<PhysiologicalHypothesis, number>): number {
  let entropy = 0;
  for (const hypothesis of HYPOTHESES) {
    const p = beliefs[hypothesis];
    if (p > EPS) entropy -= p * Math.log(p);
  }
  return clamp01(entropy / Math.log(HYPOTHESES.length));
}

function createStats(mean = 0, variance = 1): LearnedFeatureStats {
  return { mean, variance };
}

export function createEmptyPhysiologyProfile(): LearnedPhysiologyProfile {
  return {
    version: 1,
    revision: 0,
    acceptedSamples: 0,
    confidence: 0,
    updatedAtMs: 0,
    features: {
      logRg: createStats(),
      logRb: createStats(),
      coverage: createStats(0.2, 0.04),
      logPi: createStats(-6.5, 2),
      periodicity: createStats(0.5, 0.1),
      sqi: createStats(0.5, 0.1),
      multiChannelConsistency: createStats(0.5, 0.1),
      predictionConsistency: createStats(0.5, 0.1),
    },
  };
}

function validStats(value: unknown): value is LearnedFeatureStats {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as LearnedFeatureStats;
  return Number.isFinite(candidate.mean) && Number.isFinite(candidate.variance) && candidate.variance >= 0;
}

export function isValidPhysiologyProfile(value: unknown): value is LearnedPhysiologyProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as LearnedPhysiologyProfile;
  if (profile.version !== 1 || !profile.features) return false;
  if (!Number.isFinite(profile.acceptedSamples) || profile.acceptedSamples < 0) return false;
  if (!Number.isFinite(profile.confidence) || profile.confidence < 0 || profile.confidence > 1) return false;
  return Object.values(profile.features).every(validStats);
}

function cloneProfile(profile: LearnedPhysiologyProfile): LearnedPhysiologyProfile {
  return {
    ...profile,
    features: {
      logRg: { ...profile.features.logRg },
      logRb: { ...profile.features.logRb },
      coverage: { ...profile.features.coverage },
      logPi: { ...profile.features.logPi },
      periodicity: { ...profile.features.periodicity },
      sqi: { ...profile.features.sqi },
      multiChannelConsistency: { ...profile.features.multiChannelConsistency },
      predictionConsistency: { ...profile.features.predictionConsistency },
    },
  };
}

function updateStats(stats: LearnedFeatureStats, value: number, alpha: number): void {
  if (!Number.isFinite(value)) return;
  const delta = value - stats.mean;
  stats.mean += alpha * delta;
  const nextVariance = (1 - alpha) * (stats.variance + alpha * delta * delta);
  stats.variance = Math.max(1e-5, nextVariance);
}

function profileSimilarity(profile: LearnedPhysiologyProfile, features: FeatureVector): number {
  if (profile.confidence < 0.05 || profile.acceptedSamples < 8) return 0.5;
  const keys = Object.keys(features) as Array<keyof FeatureVector>;
  let squaredDistance = 0;
  for (const key of keys) {
    const stats = profile.features[key];
    const z = (features[key] - stats.mean) / Math.sqrt(Math.max(1e-4, stats.variance));
    squaredDistance += Math.min(9, z * z);
  }
  const normalized = squaredDistance / keys.length;
  return clamp01(Math.exp(-0.5 * normalized));
}

function multiChannelConsistency(input: PhysiologicalReasoningInput): number {
  const channels = input.spo2Channels;
  if (!channels) return 0;
  const perfRed = channels.dcRed > EPS ? Math.abs(channels.acRed) / Math.abs(channels.dcRed) : 0;
  const perfGreen = channels.dcGreen > EPS ? Math.abs(channels.acGreen) / Math.abs(channels.dcGreen) : 0;
  const presence = geometricMean([
    smoothstep(0.00015, 0.003, perfRed),
    smoothstep(0.00015, 0.003, perfGreen),
  ]);
  const ratioAgreement = Math.min(perfRed, perfGreen) / Math.max(EPS, Math.max(perfRed, perfGreen));
  return clamp01(presence * (0.35 + 0.65 * ratioAgreement));
}

function selectDominantHypothesis(
  beliefs: Record<PhysiologicalHypothesis, number>,
): PhysiologicalHypothesis {
  let best: PhysiologicalHypothesis = 'UNKNOWN';
  let bestValue = -Infinity;
  for (const hypothesis of HYPOTHESES) {
    if (beliefs[hypothesis] > bestValue) {
      best = hypothesis;
      bestValue = beliefs[hypothesis];
    }
  }
  return best;
}

function buildReasons(
  evidence: PhysiologicalEvidenceSnapshot,
  beliefs: Record<PhysiologicalHypothesis, number>,
): { supporting: string[]; contradictory: string[] } {
  const supporting: Array<[number, string]> = [
    [evidence.pulsatileDynamics, 'dinámica AC/DC y fuerza pulsátil compatibles'],
    [evidence.temporalCoherence, 'periodicidad cardiovascular sostenida'],
    [evidence.multiChannelConsistency, 'consistencia pulsátil entre canales'],
    [evidence.predictionConsistency, 'la evolución observada coincide con la predicción temporal'],
    [evidence.opticalTissueCompatibility, 'respuesta óptica compatible con tejido iluminado'],
    [evidence.learnedProfileSimilarity, 'coincide con el perfil aprendido en sesiones anteriores'],
    [evidence.couplingStability, 'acoplamiento óptico estable'],
  ];
  const contradictory: Array<[number, string]> = [
    [evidence.motionDominance, 'el movimiento explica una parte importante de la variación'],
    [evidence.illuminationArtifact, 'la exposición o iluminación puede explicar la señal'],
    [evidence.residualOrRinging, 'la salida puede provenir de memoria de filtros o ringing'],
    [1 - evidence.multiChannelConsistency, 'falta consistencia pulsátil suficiente entre canales'],
    [1 - evidence.temporalCoherence, 'la estructura temporal no es suficientemente coherente'],
    [1 - evidence.exposureQuality, 'la escena está fuera del rango óptico útil'],
  ];

  supporting.sort((a, b) => b[0] - a[0]);
  contradictory.sort((a, b) => b[0] - a[0]);

  const supportText = supporting.filter(([score]) => score >= 0.55).slice(0, 4).map(([, text]) => text);
  const contradictText = contradictory.filter(([score]) => score >= 0.55).slice(0, 4).map(([, text]) => text);

  if (beliefs.PERFUSED_HUMAN_TISSUE >= 0.5 && supportText.length === 0) {
    supportText.push('la combinación global favorece perfusión observable');
  }
  if (contradictText.length === 0 && beliefs.UNKNOWN > 0.35) {
    contradictText.push('la evidencia todavía es insuficiente para una explicación dominante');
  }

  return { supporting: supportText, contradictory: contradictText };
}

export class PhysiologicalReasoningCore {
  private profile: LearnedPhysiologyProfile = createEmptyPhysiologyProfile();
  private readonly dynamic: DynamicState = {
    initialized: false,
    previousTimestampMs: 0,
    previousRed: 0,
    previousGreen: 0,
    previousBlue: 0,
    previousFiltered: 0,
    previousFiltered2: 0,
    signalScaleEma: 1,
    rgbChangeEma: 0,
    recentPerfusedBelief: 0,
  };

  importProfile(profile: unknown): boolean {
    if (!isValidPhysiologyProfile(profile)) return false;
    this.profile = cloneProfile(profile);
    return true;
  }

  exportProfile(): LearnedPhysiologyProfile {
    return cloneProfile(this.profile);
  }

  resetSession(preserveLearnedProfile = true): void {
    this.dynamic.initialized = false;
    this.dynamic.previousTimestampMs = 0;
    this.dynamic.previousRed = 0;
    this.dynamic.previousGreen = 0;
    this.dynamic.previousBlue = 0;
    this.dynamic.previousFiltered = 0;
    this.dynamic.previousFiltered2 = 0;
    this.dynamic.signalScaleEma = 1;
    this.dynamic.rgbChangeEma = 0;
    this.dynamic.recentPerfusedBelief = 0;
    if (!preserveLearnedProfile) this.profile = createEmptyPhysiologyProfile();
  }

  update(input: PhysiologicalReasoningInput): PhysiologicalReasoningState {
    const r = Math.max(1, input.rawRed);
    const g = Math.max(1, input.rawGreen);
    const b = Math.max(1, input.rawBlue);
    const total = r + g + b;
    const logRg = Math.log(r / g);
    const logRb = Math.log(r / b);
    const redDominance = r / Math.max(EPS, total);

    let commonModeRgbChange = 0;
    let predictionConsistency = 0.5;
    if (this.dynamic.initialized) {
      const dr = Math.abs(r - this.dynamic.previousRed) / Math.max(8, this.dynamic.previousRed);
      const dg = Math.abs(g - this.dynamic.previousGreen) / Math.max(8, this.dynamic.previousGreen);
      const db = Math.abs(b - this.dynamic.previousBlue) / Math.max(8, this.dynamic.previousBlue);
      const minChange = Math.min(dr, dg, db);
      const maxChange = Math.max(dr, dg, db);
      const sameDirection =
        Math.sign(r - this.dynamic.previousRed) === Math.sign(g - this.dynamic.previousGreen) &&
        Math.sign(g - this.dynamic.previousGreen) === Math.sign(b - this.dynamic.previousBlue);
      commonModeRgbChange = clamp01((sameDirection ? minChange : 0) / Math.max(0.01, maxChange));
      commonModeRgbChange *= smoothstep(0.008, 0.08, maxChange);

      const predicted = this.dynamic.previousFiltered +
        0.65 * (this.dynamic.previousFiltered - this.dynamic.previousFiltered2);
      const residual = Math.abs(input.filteredValue - predicted);
      const observedScale = Math.max(
        Math.abs(input.filteredValue),
        Math.abs(this.dynamic.previousFiltered),
        0.05,
      );
      this.dynamic.signalScaleEma =
        this.dynamic.signalScaleEma * 0.94 + observedScale * 0.06;
      const normalizedResidual = residual / Math.max(0.05, this.dynamic.signalScaleEma * 2.5);
      predictionConsistency = clamp01(Math.exp(-normalizedResidual));
    }

    this.dynamic.rgbChangeEma =
      this.dynamic.rgbChangeEma * 0.88 + commonModeRgbChange * 0.12;

    const exposureQuality = geometricMean([
      smoothstep(18, 75, total),
      smoothstepDown(680, 755, total),
      1 - clamp01(input.saturationRatio),
      1 - clamp01(input.underexposureRatio),
    ]);

    const chromaticCompatibility = geometricMean([
      smoothstep(0.02, 0.45, logRg),
      smoothstep(0.04, 0.55, logRb),
      smoothstep(0.36, 0.58, redDominance),
    ]);
    const spatialCoverage = smoothstep(0.04, 0.32, input.coverageRatio);
    const opticalTissueCompatibility = geometricMean([
      exposureQuality,
      chromaticCompatibility,
      0.2 + 0.8 * spatialCoverage,
    ]);

    const normalizedSqi = clamp01(input.sqi / 100);
    const normalizedPeriodicity = clamp01(input.periodicity);
    const piEvidence = smoothstep(0.00012, 0.004, Math.max(0, input.perfusionIndex));
    const strengthEvidence = smoothstep(0.04, 0.75, Math.max(0, input.pulseStrength));
    const pulsatileDynamics = geometricMean([
      piEvidence,
      0.25 + 0.75 * normalizedPeriodicity,
      0.25 + 0.75 * normalizedSqi,
      0.2 + 0.8 * strengthEvidence,
    ]);

    const channelConsistency = multiChannelConsistency(input);
    const temporalCoherence = geometricMean([
      normalizedPeriodicity,
      predictionConsistency,
      smoothstep(0.15, 0.65, normalizedSqi),
    ]);

    const combinedMotion = clamp01(Math.max(
      input.motionScore,
      input.signalMotionScore,
      input.centroidMotion ?? 0,
    ));
    const motionDominance = clamp01(
      0.55 * combinedMotion +
      0.30 * this.dynamic.rgbChangeEma +
      0.15 * commonModeRgbChange,
    );

    const illuminationArtifact = clamp01(
      0.50 * (1 - exposureQuality) +
      0.35 * commonModeRgbChange * (1 - channelConsistency) +
      0.15 * smoothstep(8, 28, input.timestampJitterMs ?? 0),
    );

    const couplingStability = clamp01(
      geometricMean([
        1 - 0.75 * combinedMotion,
        1 - 0.65 * this.dynamic.rgbChangeEma,
        0.3 + 0.7 * spatialCoverage,
        exposureQuality,
      ]),
    );

    const filteredEnergy = smoothstep(
      0.08,
      1.5,
      Math.max(Math.abs(input.filteredValue), Math.abs(input.morphologyValue)),
    );
    const sourceEvidenceNow = geometricMean([
      opticalTissueCompatibility,
      pulsatileDynamics,
      0.25 + 0.75 * channelConsistency,
    ]);
    const residualOrRinging = clamp01(
      filteredEnergy *
      (1 - sourceEvidenceNow) *
      (0.35 + 0.65 * this.dynamic.recentPerfusedBelief),
    );

    const features: FeatureVector = {
      logRg,
      logRb,
      coverage: clamp01(input.coverageRatio),
      logPi: Math.log(Math.max(1e-7, input.perfusionIndex)),
      periodicity: normalizedPeriodicity,
      sqi: normalizedSqi,
      multiChannelConsistency: channelConsistency,
      predictionConsistency,
    };
    const learnedProfileSimilarity = profileSimilarity(this.profile, features);

    const perfusedEvidence = geometricMean([
      opticalTissueCompatibility,
      pulsatileDynamics,
      temporalCoherence,
      0.15 + 0.85 * channelConsistency,
      0.25 + 0.75 * couplingStability,
      0.3 + 0.7 * learnedProfileSimilarity,
    ]);

    const logits: Record<PhysiologicalHypothesis, number> = {
      PERFUSED_HUMAN_TISSUE:
        -0.5 + 4.2 * perfusedEvidence - 1.9 * motionDominance -
        2.0 * illuminationArtifact - 2.2 * residualOrRinging,
      POORLY_COUPLED_TISSUE:
        -0.4 + 2.1 * opticalTissueCompatibility + 1.3 * pulsatileDynamics +
        1.6 * (1 - couplingStability) - 0.8 * illuminationArtifact,
      MOTION_DOMINATED_SCENE:
        -0.3 + 3.8 * motionDominance + 1.1 * commonModeRgbChange -
        1.2 * temporalCoherence - 0.6 * channelConsistency,
      ILLUMINATION_ARTIFACT:
        -0.4 + 4.0 * illuminationArtifact + 0.9 * commonModeRgbChange -
        0.8 * channelConsistency,
      STATIC_OR_INERT_SCENE:
        -0.2 + 1.7 * exposureQuality + 1.4 * (1 - pulsatileDynamics) +
        1.0 * (1 - temporalCoherence) - 0.8 * combinedMotion,
      FILTER_RESIDUAL_OR_RINGING:
        -0.6 + 4.4 * residualOrRinging + 0.7 * filteredEnergy -
        0.6 * sourceEvidenceNow,
      UNKNOWN:
        0.2 + 1.4 * (1 - Math.max(
          perfusedEvidence,
          motionDominance,
          illuminationArtifact,
          residualOrRinging,
        )),
    };

    const beliefs = softmax(logits);
    const dominantHypothesis = selectDominantHypothesis(beliefs);
    const perfusedTissueBelief = beliefs.PERFUSED_HUMAN_TISSUE +
      0.45 * beliefs.POORLY_COUPLED_TISSUE;

    const heartRate = clamp01(
      perfusedTissueBelief *
      geometricMean([
        pulsatileDynamics,
        0.25 + 0.75 * normalizedPeriodicity,
        1 - 0.45 * motionDominance,
        1 - 0.55 * residualOrRinging,
      ]),
    );
    const morphology = clamp01(
      perfusedTissueBelief *
      geometricMean([
        temporalCoherence,
        normalizedSqi,
        predictionConsistency,
        couplingStability,
        1 - 0.7 * motionDominance,
      ]),
    );
    const rhythm = clamp01(heartRate * geometricMean([
      temporalCoherence,
      predictionConsistency,
      1 - 0.45 * motionDominance,
    ]));
    const oxygenation = clamp01(
      perfusedTissueBelief *
      geometricMean([
        channelConsistency,
        exposureQuality,
        couplingStability,
        1 - 0.55 * motionDominance,
      ]),
    );
    const pressure = clamp01(
      perfusedTissueBelief *
      geometricMean([
        morphology,
        couplingStability,
        temporalCoherence,
        0.35 + 0.65 * this.profile.confidence,
      ]),
    );
    const respiration = clamp01(
      perfusedTissueBelief * geometricMean([
        0.25 + 0.75 * normalizedSqi,
        couplingStability,
        1 - 0.5 * motionDominance,
      ]),
    );

    const observability: VitalObservability = {
      heartRate,
      rhythm,
      morphology,
      oxygenation,
      pressure,
      respiration,
    };

    const maxArtifact = Math.max(motionDominance, illuminationArtifact, residualOrRinging);
    const consensus = geometricMean([
      opticalTissueCompatibility,
      pulsatileDynamics,
      temporalCoherence,
      0.2 + 0.8 * channelConsistency,
      1 - maxArtifact,
    ]);
    const learningAccepted =
      beliefs.PERFUSED_HUMAN_TISSUE >= 0.42 &&
      perfusedEvidence >= 0.68 &&
      consensus >= 0.68 &&
      channelConsistency >= 0.45 &&
      maxArtifact <= 0.30 &&
      predictionConsistency >= 0.50;

    if (learningAccepted) this.learn(features, input.timestampMs, consensus);

    const uncertainty = clamp01(
      0.72 * normalizedEntropy(beliefs) +
      0.18 * (1 - this.profile.confidence) +
      0.10 * maxArtifact,
    );

    const evidence: PhysiologicalEvidenceSnapshot = {
      opticalTissueCompatibility,
      exposureQuality,
      pulsatileDynamics,
      temporalCoherence,
      multiChannelConsistency: channelConsistency,
      predictionConsistency,
      couplingStability,
      motionDominance,
      illuminationArtifact,
      residualOrRinging,
      learnedProfileSimilarity,
      commonModeRgbChange,
    };

    const reasons = buildReasons(evidence, beliefs);
    const expectedNextObservation = dominantHypothesis === 'PERFUSED_HUMAN_TISSUE'
      ? 'la próxima ventana debería conservar frecuencia, relación multicanal y morfología con error predictivo bajo'
      : dominantHypothesis === 'MOTION_DOMINATED_SCENE'
        ? 'al compensar el movimiento debería caer la variación común RGB; solo una componente residual coherente apoyaría perfusión'
        : dominantHypothesis === 'FILTER_RESIDUAL_OR_RINGING'
          ? 'la energía filtrada debería extinguirse rápidamente si no reaparece evidencia óptica y multicanal de perfusión'
          : dominantHypothesis === 'ILLUMINATION_ARTIFACT'
            ? 'la variación debería seguir a exposición y brillo común, no a una morfología vascular estable'
            : 'se necesitan nuevas observaciones para separar perfusión, artefacto y escena inerte';

    this.dynamic.recentPerfusedBelief =
      this.dynamic.recentPerfusedBelief * 0.90 + perfusedTissueBelief * 0.10;
    this.dynamic.previousTimestampMs = input.timestampMs;
    this.dynamic.previousRed = r;
    this.dynamic.previousGreen = g;
    this.dynamic.previousBlue = b;
    this.dynamic.previousFiltered2 = this.dynamic.previousFiltered;
    this.dynamic.previousFiltered = input.filteredValue;
    this.dynamic.initialized = true;

    return {
      timestampMs: input.timestampMs,
      modelVersion: 'physio-reasoner-v1',
      dominantHypothesis,
      beliefs,
      perfusedTissueBelief: clamp01(perfusedTissueBelief),
      observability,
      evidence,
      uncertainty,
      learnedProfileConfidence: this.profile.confidence,
      learningAccepted,
      supportingEvidence: reasons.supporting,
      contradictoryEvidence: reasons.contradictory,
      expectedNextObservation,
    };
  }

  private learn(features: FeatureVector, timestampMs: number, consensus: number): void {
    const n = this.profile.acceptedSamples;
    const alpha = n < 20 ? 0.12 : n < 100 ? 0.045 : 0.012;
    const weightedAlpha = alpha * (0.55 + 0.45 * clamp01(consensus));
    const keys = Object.keys(features) as Array<keyof FeatureVector>;
    for (const key of keys) updateStats(this.profile.features[key], features[key], weightedAlpha);
    this.profile.acceptedSamples++;
    this.profile.confidence = clamp01(1 - Math.exp(-this.profile.acceptedSamples / 70));
    this.profile.updatedAtMs = timestampMs;
    if (this.profile.acceptedSamples % 6 === 0) this.profile.revision++;
  }
}
