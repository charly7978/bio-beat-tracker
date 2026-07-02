/**
 * Motor fisiológico de presión arterial desde PPG/PWA.
 *
 * Combina tres capas de evidencia para estimar SBP/DBP con un comportamiento más
 * cercano a la literatura contemporánea en estimación no invasiva de PA:
 * 1) un regresor MLP sobre morfología de onda (PPG/PWA),
 * 2) un modelo físico de Windkessel con índices de resistencia/compliancia/reflexión,
 * 3) un ajuste antropométrico y calibración de referencia cuando está disponible.
 *
 * El diseño prioriza estabilidad, coherencia hemodinámica y compatibilidad con
 * perfiles tanto modernos como simplificados (edad/género) para facilitar pruebas y
 * uso incremental en producción.
 */
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { clamp } from '@/utils/math';
import { MLP_WEIGHTS } from './mlpWeights';

export interface PwaMedianFeatures {
  bDivA: number;
  dDivA: number;
  agi: number;
  sutMs: number;
  diastolicPhaseMs: number;
  stiffnessIndex: number;
  augmentationIndex: number;
  dicroticDepth: number;
  areaRatio: number;
  pw50Ms: number;
  kValue: number;
  vMax: number;
  harmonicDistortion?: number;
}

export interface PwaBpContext {
  hr: number;
  rmssd: number;
  cyclePeriodMs: number;
}

export interface AnthropometricProfile {
  heightCm: number;
  weightKg: number;
  ageYears?: number;
  age?: number;
  isMale?: boolean;
  gender?: 'male' | 'female' | 'other';
}

export interface PwaBpRaw {
  systolic: number;
  diastolic: number;
  map: number;
  pulsePressure: number;
  resistanceIndex: number;
  complianceIndex: number;
  reflectionIndex: number;
}

function safeNumber(value: number | null | undefined, fallback: number): number {
  return Number.isFinite(value as number) ? (value as number) : fallback;
}

function norm01(value: number | null | undefined, low: number, high: number): number {
  const n = safeNumber(value as number | null | undefined, 0);
  if (!Number.isFinite(n) || high <= low) return 0.5;
  return clamp((n - low) / (high - low), 0, 1);
}

function decayLambda(f: PwaMedianFeatures): number {
  if (f.diastolicPhaseMs <= 0 || f.dicroticDepth <= 0) return 0;
  const tail = clamp(1 - f.dicroticDepth, 0.08, 0.95);
  return -Math.log(tail) / f.diastolicPhaseMs;
}

function normalizeAnthropometricProfile(profile?: AnthropometricProfile | null) {
  const heightCm = safeNumber(profile?.heightCm, 172);
  const weightKg = safeNumber(profile?.weightKg, 70);
  const ageYears = safeNumber(profile?.ageYears ?? profile?.age, 35);
  const gender = profile?.gender;
  const isMale = profile?.isMale ?? (gender === 'male' ? true : gender === 'female' ? false : true);
  const bmi = heightCm > 0 ? weightKg / ((heightCm / 100) ** 2) : 23;
  return { heightCm, weightKg, ageYears, isMale, bmi };
}

function relu(x: number): number {
  return Math.max(0, x);
}

function dotProduct(inputs: number[], weightsRow: number[]): number {
  let sum = 0;
  const len = inputs.length;
  for (let i = 0; i < len; i++) {
    sum += inputs[i] * weightsRow[i];
  }
  return sum;
}

export function runMlpBpModel(inputs: number[]): { sbp: number; dbp: number } {
  const h1: number[] = [];
  const fc1 = MLP_WEIGHTS.fc1;
  const len1 = fc1.bias.length;
  for (let neuron = 0; neuron < len1; neuron++) {
    const sum = dotProduct(inputs, fc1.weights[neuron]) + fc1.bias[neuron];
    h1.push(relu(sum));
  }

  const h2: number[] = [];
  const fc2 = MLP_WEIGHTS.fc2;
  const len2 = fc2.bias.length;
  for (let neuron = 0; neuron < len2; neuron++) {
    const sum = dotProduct(h1, fc2.weights[neuron]) + fc2.bias[neuron];
    h2.push(relu(sum));
  }

  const fc3 = MLP_WEIGHTS.fc3;
  const sbp = dotProduct(h2, fc3.weights[0]) + fc3.bias[0];
  const dbp = dotProduct(h2, fc3.weights[1]) + fc3.bias[1];

  return { sbp, dbp };
}

function assessFeatureQualityLocal(f: PwaMedianFeatures, ctx?: PwaBpContext): number {
  let score = 28;
  if (f.sutMs > 40 && f.sutMs < 400) score += 16;
  if (f.diastolicPhaseMs > 50 && f.diastolicPhaseMs < 800) score += 14;
  if (f.stiffnessIndex > 0.5 && f.stiffnessIndex < 24) score += 12;
  if (f.augmentationIndex > 2 && f.augmentationIndex < 45) score += 9;
  if (f.dicroticDepth > 0 && f.dicroticDepth < 0.8) score += 8;
  if (f.pw50Ms > 60 && f.pw50Ms < 600) score += 7;
  if (ctx) {
    if (ctx.hr >= 50 && ctx.hr <= 110) score += 6;
    if (ctx.rmssd >= 10 && ctx.rmssd <= 120) score += 4;
  }
  return Math.min(100, score);
}

/** Índices hemodinámicos 0–1 derivados únicamente de la morfología de la onda. */
export function computePhysiologicalIndices(
  f: PwaMedianFeatures,
  ctx: PwaBpContext,
  profile?: AnthropometricProfile | null,
): Pick<PwaBpRaw, 'resistanceIndex' | 'complianceIndex' | 'reflectionIndex'> {
  const N = VITAL_THRESHOLDS.BP.FEATURE_NORM;
  const cycleMs = Math.max(280, safeNumber(ctx.cyclePeriodMs, 830));
  const p = normalizeAnthropometricProfile(profile);
  const heightFactor = p.heightCm > 0 ? p.heightCm / 100 : 1.72;
  const stiffnessIndex = f.stiffnessIndex * heightFactor;

  const kNorm = norm01(f.kValue, N.K_VALUE[0], N.K_VALUE[1]);
  const ipaNorm = norm01(f.areaRatio, N.AREA_RATIO[0], N.AREA_RATIO[1]);
  const decayNorm = norm01(decayLambda(f), N.DECAY_LAMBDA[0], N.DECAY_LAMBDA[1]);

  const ageFactor = clamp((p.ageYears - 30) / 45, -0.2, 0.8);
  const bmiFactor = clamp((p.bmi - 22) / 15, -0.3, 0.7);
  const hrScore = norm01(ctx.hr, VITAL_THRESHOLDS.HR.MIN, 110);
  const hrvScore = norm01(ctx.rmssd, N.RMSSD[0], N.RMSSD[1]);
  const wR = VITAL_THRESHOLDS.BP.WEIGHTS.RESISTANCE;
  let resistanceIndex = wR.k * kNorm + wR.ipa * ipaNorm + wR.decay * decayNorm;
  resistanceIndex = clamp(resistanceIndex + ageFactor * 0.08 + bmiFactor * 0.07 + hrScore * 0.04 + (1 - hrvScore) * 0.03, 0, 1);

  const sutRatio = f.sutMs / cycleMs;
  const stiffNorm = norm01(-f.bDivA, N.B_DIV_A[0], N.B_DIV_A[1]);
  const siNorm = norm01(stiffnessIndex, N.STIFFNESS_INDEX[0], N.STIFFNESS_INDEX[1]);
  const aixNorm = norm01(f.augmentationIndex, N.AUGMENTATION_INDEX[0], N.AUGMENTATION_INDEX[1]);
  const vNorm = norm01(f.vMax, N.V_MAX[0], N.V_MAX[1]);
  const hdNorm = norm01(f.harmonicDistortion, N.HARMONIC_DISTORTION[0], N.HARMONIC_DISTORTION[1]);

  const complianceAgeFactor = Math.exp(-0.008 * Math.max(0, p.ageYears - 25));
  const wC = VITAL_THRESHOLDS.BP.WEIGHTS.COMPLIANCE;
  let complianceIndex =
    1 -
    (wC.stiff * stiffNorm +
      wC.si * siNorm +
      wC.aix * aixNorm +
      wC.vMax * vNorm +
      wC.sutRatio * norm01(sutRatio, N.SUT_CYCLE_RATIO[0], N.SUT_CYCLE_RATIO[1]) +
      hdNorm * 0.15);
  complianceIndex = clamp(complianceIndex * complianceAgeFactor, 0.05, 1);

  const wRef = VITAL_THRESHOLDS.BP.WEIGHTS.REFLECTION;
  const reflectionIndex = clamp(
    wRef.dDivA * norm01(-f.dDivA, N.D_DIV_A[0], N.D_DIV_A[1]) +
      wRef.agi * norm01(f.agi, N.AGI[0], N.AGI[1]) +
      wRef.dicroticDepth * norm01(f.dicroticDepth, N.DICROTIC_DEPTH[0], N.DICROTIC_DEPTH[1]) +
      wRef.stiffnessIndex * norm01(stiffnessIndex, N.STIFFNESS_INDEX[0], N.STIFFNESS_INDEX[1]),
    0,
    1,
  );

  return { resistanceIndex, complianceIndex, reflectionIndex };
}

/** Mapa morfológico de presión que conserva un rango fisiológico razonable. */
export function morphologyPressures(
  f: PwaMedianFeatures,
  ctx: PwaBpContext,
  profile?: AnthropometricProfile | null,
): { sbp: number; dbp: number } {
  const cfg = VITAL_THRESHOLDS.BP;
  const N = cfg.FEATURE_NORM;
  const cycleMs = Math.max(280, safeNumber(ctx.cyclePeriodMs, 830));
  const spanS = cfg.SYSTOLIC_MAX - cfg.SYSTOLIC_MIN;
  const spanD = cfg.DIASTOLIC_MAX - cfg.DIASTOLIC_MIN;
  const M = cfg.WEIGHTS.MORPHOLOGY;
  const p = normalizeAnthropometricProfile(profile);

  const sutScore = norm01(f.sutMs / cycleMs, N.SUT_CYCLE_RATIO[0], N.SUT_CYCLE_RATIO[1]);
  const diaScore = norm01(f.diastolicPhaseMs / cycleMs, N.DIA_PHASE_RATIO[0], N.DIA_PHASE_RATIO[1]);
  const pw50Score = norm01(f.pw50Ms / cycleMs, N.PW50_CYCLE_RATIO[0], N.PW50_CYCLE_RATIO[1]);
  const hrScore = norm01(ctx.hr, VITAL_THRESHOLDS.HR.MIN, VITAL_THRESHOLDS.HR.MAX);
  const hrvScore = norm01(ctx.rmssd, N.RMSSD[0], N.RMSSD[1]);

  const sbpUnit =
    M.sbp.sut * (1 - sutScore) +
    M.sbp.stiff * norm01(-f.bDivA, N.B_DIV_A[0], N.B_DIV_A[1]) +
    M.sbp.dicrotic * norm01(f.dicroticDepth, N.DICROTIC_DEPTH[0], N.DICROTIC_DEPTH[1]) +
    M.sbp.aix * norm01(f.augmentationIndex, N.AUGMENTATION_INDEX[0], N.AUGMENTATION_INDEX[1]) +
    M.sbp.hr * hrScore;

  const dbpUnit =
    M.dbp.pw50 * pw50Score +
    M.dbp.diaPhase * diaScore +
    M.dbp.decay * norm01(decayLambda(f), N.DECAY_LAMBDA[0], N.DECAY_LAMBDA[1]) +
    M.dbp.dicrotic * norm01(f.dicroticDepth, N.DICROTIC_DEPTH[0], N.DICROTIC_DEPTH[1]) +
    M.dbp.hrv * (1 - hrvScore) +
    M.dbp.ipa * norm01(f.areaRatio, N.AREA_RATIO[0], N.AREA_RATIO[1]);

  const ageSbpLift = clamp((p.ageYears - 35) * 0.08, -3, 5);
  const bmiSbpLift = clamp((p.bmi - 22) * 0.35, -3, 4);
  const ageDbpLift = clamp((p.ageYears - 35) * 0.05, -2, 3);
  const bmiDbpLift = clamp((p.bmi - 22) * 0.18, -2, 2);

  return {
    sbp: cfg.SYSTOLIC_MIN + clamp(sbpUnit + ageSbpLift + bmiSbpLift + (p.isMale ? 0.4 : -0.2), 0, 1) * spanS,
    dbp: cfg.DIASTOLIC_MIN + clamp(dbpUnit + ageDbpLift + bmiDbpLift + (p.isMale ? 0.2 : -0.1), 0, 1) * spanD,
  };
}

/** Estimación híbrida MLP + física + ajustes antropométricos. */
export function estimatePhysiologicalBp(
  f: PwaMedianFeatures,
  ctx: PwaBpContext,
  profile?: AnthropometricProfile | null,
  calibrationOffsets?: { sbpOffset: number; dbpOffset: number } | null,
): PwaBpRaw {
  const p = normalizeAnthropometricProfile(profile);
  const heightFactor = p.heightCm > 0 ? p.heightCm / 100 : 1.72;
  const bmi = p.bmi;
  const cycleMs = Math.max(280, safeNumber(ctx.cyclePeriodMs, 830));
  const hr = clamp(safeNumber(ctx.hr, 72), VITAL_THRESHOLDS.HR.MIN, VITAL_THRESHOLDS.HR.MAX);
  const rmssd = clamp(safeNumber(ctx.rmssd, 35), 0, 180);

  const sutRatio = f.sutMs / cycleMs;
  const diaPhaseRatio = f.diastolicPhaseMs / cycleMs;
  const pw50Ratio = f.pw50Ms / cycleMs;
  const stiffnessIndex = f.stiffnessIndex * heightFactor;

  const N = VITAL_THRESHOLDS.BP.FEATURE_NORM;
  const normInputs = [
    clamp(sutRatio, N.SUT_CYCLE_RATIO[0], N.SUT_CYCLE_RATIO[1]),
    clamp(diaPhaseRatio, N.DIA_PHASE_RATIO[0], N.DIA_PHASE_RATIO[1]),
    clamp(pw50Ratio, N.PW50_CYCLE_RATIO[0], N.PW50_CYCLE_RATIO[1]),
    clamp(f.areaRatio, N.AREA_RATIO[0], N.AREA_RATIO[1]),
    clamp(f.dicroticDepth, 0, N.DICROTIC_DEPTH[1]),
    clamp(stiffnessIndex, 0, N.STIFFNESS_INDEX[1]) / 10.0,
    clamp(f.augmentationIndex, 0, N.AUGMENTATION_INDEX[1]) / 20.0,
    clamp(f.kValue, N.K_VALUE[0], N.K_VALUE[1]),
    clamp(f.vMax, N.V_MAX[0], N.V_MAX[1]) / 50.0,
    clamp(f.agi, N.AGI[0], N.AGI[1]),
    clamp(f.bDivA, N.B_DIV_A[0], N.B_DIV_A[1]),
    clamp(f.dDivA, N.D_DIV_A[0], N.D_DIV_A[1]),
    hr / 100.0,
    clamp(p.ageYears, 18, 90) / 50.0,
    clamp(bmi, 15, 45) / 25.0,
    p.isMale ? 1.0 : 0.0,
  ];

  const mlp = runMlpBpModel(normInputs);
  const sbpMlp = mlp.sbp;
  const dbpMlp = mlp.dbp;

  const indices = computePhysiologicalIndices(f, { hr, rmssd, cyclePeriodMs: cycleMs }, profile);
  const resistanceIndex = indices.resistanceIndex;
  const complianceIndex = indices.complianceIndex;
  const reflectionIndex = indices.reflectionIndex;

  const mapPhys = VITAL_THRESHOLDS.BP.MAP_MIN + resistanceIndex * (VITAL_THRESHOLDS.BP.MAP_MAX - VITAL_THRESHOLDS.BP.MAP_MIN);
  const ppPhys =
    VITAL_THRESHOLDS.BP.PP_MIN +
    (1 - complianceIndex) * (VITAL_THRESHOLDS.BP.PP_MAX - VITAL_THRESHOLDS.BP.PP_MIN) +
    reflectionIndex * (VITAL_THRESHOLDS.BP.PP_MAX - VITAL_THRESHOLDS.BP.PP_MIN) * VITAL_THRESHOLDS.BP.REFLECTION_PP_FRAC;

  const sbpWindkessel = mapPhys + (2 / 3) * ppPhys;
  const dbpWindkessel = mapPhys - (1 / 3) * ppPhys;

  const fq = assessFeatureQualityLocal(f, { hr, rmssd, cyclePeriodMs: cycleMs });
  const wMlp = clamp((fq - 40) / 40, 0.25, 0.85);

  let sbp = sbpMlp * wMlp + sbpWindkessel * (1.0 - wMlp);
  let dbp = dbpMlp * wMlp + dbpWindkessel * (1.0 - wMlp);

  if (calibrationOffsets) {
    sbp += calibrationOffsets.sbpOffset;
    dbp += calibrationOffsets.dbpOffset;
  }

  const ageInfluenceSbp = clamp((p.ageYears - 35) * 0.08, -4, 6);
  const bmiInfluenceSbp = clamp((bmi - 22) * 0.35, -3, 4);
  const ageInfluenceDbp = clamp((p.ageYears - 35) * 0.04, -2, 3);
  const bmiInfluenceDbp = clamp((bmi - 22) * 0.18, -1.5, 2.5);
  sbp += ageInfluenceSbp + bmiInfluenceSbp + (p.isMale ? 0.3 : -0.7);
  dbp += ageInfluenceDbp + bmiInfluenceDbp + (p.isMale ? 0.15 : -0.25);

  const coherent = enforceHemodynamicCoherence(sbp, dbp);
  sbp = coherent.sbp;
  dbp = coherent.dbp;

  const map = dbp + (sbp - dbp) / 3;

  return {
    systolic: sbp,
    diastolic: dbp,
    map,
    pulsePressure: sbp - dbp,
    resistanceIndex,
    complianceIndex,
    reflectionIndex,
  };
}

export function enforceHemodynamicCoherence(
  sbp: number,
  dbp: number,
): { sbp: number; dbp: number } {
  const cfg = VITAL_THRESHOLDS.BP;
  let s = safeNumber(sbp, cfg.SYSTOLIC_MIN);
  let d = safeNumber(dbp, cfg.DIASTOLIC_MIN);
  let pp = s - d;

  if (pp > cfg.PP_MAX) {
    const excess = pp - cfg.PP_MAX;
    s -= excess * 0.6;
    d += excess * 0.25;
    pp = s - d;
  }
  if (pp < cfg.PP_MIN) {
    const deficit = cfg.PP_MIN - pp;
    s += deficit * 0.5;
    d -= deficit * 0.5;
    pp = s - d;
  }
  if (d >= s) {
    d = s - cfg.PP_MIN;
  }
  return { sbp: s, dbp: d };
}

export function isPhysiologicalBp(sbp: number, dbp: number): boolean {
  const cfg = VITAL_THRESHOLDS.BP;
  if (!Number.isFinite(sbp) || !Number.isFinite(dbp)) return false;
  if (sbp < cfg.SYSTOLIC_MIN || sbp > cfg.SYSTOLIC_MAX) return false;
  if (dbp < cfg.DIASTOLIC_MIN || dbp > cfg.DIASTOLIC_MAX) return false;
  const pp = sbp - dbp;
  if (pp < cfg.PP_MIN || pp > cfg.PP_MAX) return false;
  const ratio = dbp / sbp;
  if (ratio < cfg.DIA_SYS_RATIO_MIN || ratio > cfg.DIA_SYS_RATIO_MAX) return false;
  const map = dbp + pp / 3;
  if (map < cfg.MAP_MIN || map > cfg.MAP_MAX) return false;
  return true;
}
