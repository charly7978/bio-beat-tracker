/**
 * Motor PWA (Pulse Wave Analysis) — presión arterial desde morfología PPG.
 * Sin interceptos poblacionales ni offsets de cámara: solo índices de la señal
 * mapeados a mmHg mediante rangos fisiológicos (vitalThresholds).
 */
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { clamp } from '@/utils/math';

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
}

export interface PwaBpContext {
  hr: number;
  rmssd: number;
  cyclePeriodMs: number;
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

function norm01(value: number, low: number, high: number): number {
  if (!Number.isFinite(value) || high <= low) return 0.5;
  return clamp((value - low) / (high - low), 0, 1);
}

function decayLambda(f: PwaMedianFeatures): number {
  if (f.diastolicPhaseMs <= 0 || f.dicroticDepth <= 0) return 0;
  const tail = clamp(1 - f.dicroticDepth, 0.08, 0.95);
  return -Math.log(tail) / f.diastolicPhaseMs;
}

/** Índices hemodinámicos 0–1 derivados exclusivamente de la forma de onda. */
export function computePhysiologicalIndices(
  f: PwaMedianFeatures,
  ctx: PwaBpContext,
): Pick<PwaBpRaw, 'resistanceIndex' | 'complianceIndex' | 'reflectionIndex'> {
  const N = VITAL_THRESHOLDS.BP.FEATURE_NORM;
  const cycleMs = Math.max(280, ctx.cyclePeriodMs);

  const kNorm = norm01(f.kValue, N.K_VALUE[0], N.K_VALUE[1]);
  const ipaNorm = norm01(f.areaRatio, N.AREA_RATIO[0], N.AREA_RATIO[1]);
  const decayNorm = norm01(decayLambda(f), N.DECAY_LAMBDA[0], N.DECAY_LAMBDA[1]);
  const wR = VITAL_THRESHOLDS.BP.WEIGHTS.RESISTANCE;
  const resistanceIndex = clamp(
    wR.k * kNorm + wR.ipa * ipaNorm + wR.decay * decayNorm,
    0,
    1,
  );

  const sutRatio = f.sutMs / cycleMs;
  const stiffNorm = norm01(-f.bDivA, N.B_DIV_A[0], N.B_DIV_A[1]);
  const siNorm = norm01(f.stiffnessIndex, N.STIFFNESS_INDEX[0], N.STIFFNESS_INDEX[1]);
  const aixNorm = norm01(f.augmentationIndex, N.AUGMENTATION_INDEX[0], N.AUGMENTATION_INDEX[1]);
  const vNorm = norm01(f.vMax, N.V_MAX[0], N.V_MAX[1]);
  const wC = VITAL_THRESHOLDS.BP.WEIGHTS.COMPLIANCE;
  const complianceIndex = clamp(
    1 -
      (wC.stiff * stiffNorm +
        wC.si * siNorm +
        wC.aix * aixNorm +
        wC.vMax * vNorm +
        wC.sutRatio * norm01(sutRatio, N.SUT_CYCLE_RATIO[0], N.SUT_CYCLE_RATIO[1])),
    0,
    1,
  );

  const wRef = VITAL_THRESHOLDS.BP.WEIGHTS.REFLECTION;
  const reflectionIndex = clamp(
    wRef.dDivA * norm01(-f.dDivA, N.D_DIV_A[0], N.D_DIV_A[1]) +
      wRef.agi * norm01(f.agi, N.AGI[0], N.AGI[1]),
    0,
    1,
  );

  return { resistanceIndex, complianceIndex, reflectionIndex };
}

/** PWA morfológica: cada predictor normalizado → contribución a SBP/DBP dentro del rango fisiológico. */
function morphologyPressures(
  f: PwaMedianFeatures,
  ctx: PwaBpContext,
): { sbp: number; dbp: number } {
  const cfg = VITAL_THRESHOLDS.BP;
  const N = cfg.FEATURE_NORM;
  const cycleMs = Math.max(280, ctx.cyclePeriodMs);
  const spanS = cfg.SYSTOLIC_MAX - cfg.SYSTOLIC_MIN;
  const spanD = cfg.DIASTOLIC_MAX - cfg.DIASTOLIC_MIN;
  const M = cfg.WEIGHTS.MORPHOLOGY;

  const sutScore = norm01(f.sutMs / cycleMs, N.SUT_CYCLE_RATIO[0], N.SUT_CYCLE_RATIO[1]);
  const diaScore = norm01(
    f.diastolicPhaseMs / cycleMs,
    N.DIA_PHASE_RATIO[0],
    N.DIA_PHASE_RATIO[1],
  );
  const pw50Score = norm01(f.pw50Ms / cycleMs, N.PW50_CYCLE_RATIO[0], N.PW50_CYCLE_RATIO[1]);
  const hrScore = norm01(ctx.hr, VITAL_THRESHOLDS.HR.MIN, VITAL_THRESHOLDS.HR.MAX);
  const hrvScore = norm01(ctx.rmssd, N.RMSSD[0], N.RMSSD[1]);

  const sbpUnit =
    M.sbp.sut * (1 - sutScore) +
    M.sbp.stiff * norm01(-f.bDivA, N.B_DIV_A[0], N.B_DIV_A[1]) +
    M.sbp.reflection * norm01(-f.dDivA, N.D_DIV_A[0], N.D_DIV_A[1]) +
    M.sbp.aix * norm01(f.augmentationIndex, N.AUGMENTATION_INDEX[0], N.AUGMENTATION_INDEX[1]) +
    M.sbp.hr * hrScore;

  const dbpUnit =
    M.dbp.pw50 * pw50Score +
    M.dbp.diaPhase * diaScore +
    M.dbp.decay * norm01(decayLambda(f), N.DECAY_LAMBDA[0], N.DECAY_LAMBDA[1]) +
    M.dbp.dicrotic * norm01(f.dicroticDepth, N.DICROTIC_DEPTH[0], N.DICROTIC_DEPTH[1]) +
    M.dbp.hrv * (1 - hrvScore) +
    M.dbp.ipa * norm01(f.areaRatio, N.AREA_RATIO[0], N.AREA_RATIO[1]);

  return {
    sbp: cfg.SYSTOLIC_MIN + clamp(sbpUnit, 0, 1) * spanS,
    dbp: cfg.DIASTOLIC_MIN + clamp(dbpUnit, 0, 1) * spanD,
  };
}

/** Windkessel: MAP y PP desde índices → SBP/DBP (relación física MAP = DBP + PP/3). */
function windkesselPressures(
  indices: Pick<PwaBpRaw, 'resistanceIndex' | 'complianceIndex' | 'reflectionIndex'>,
): { sbp: number; dbp: number; map: number; pulsePressure: number } {
  const cfg = VITAL_THRESHOLDS.BP;
  const map =
    cfg.MAP_MIN + indices.resistanceIndex * (cfg.MAP_MAX - cfg.MAP_MIN);
  const pp =
    cfg.PP_MIN +
    (1 - indices.complianceIndex) * (cfg.PP_MAX - cfg.PP_MIN) +
    indices.reflectionIndex * (cfg.PP_MAX - cfg.PP_MIN) * cfg.REFLECTION_PP_FRAC;
  const sbp = map + (2 / 3) * pp;
  const dbp = map - (1 / 3) * pp;
  return { sbp, dbp, map, pulsePressure: pp };
}

/** Estimación cruda fusionada (sin EMA ni recorte a pisos). */
export function estimatePhysiologicalBp(
  f: PwaMedianFeatures,
  ctx: PwaBpContext,
): PwaBpRaw {
  const indices = computePhysiologicalIndices(f, ctx);
  const hemo = windkesselPressures(indices);
  const morph = morphologyPressures(f, ctx);
  const fuse = VITAL_THRESHOLDS.BP.WEIGHTS.FUSION;

  const sbp = hemo.sbp * fuse.hemodynamic + morph.sbp * fuse.morphology;
  const dbp = hemo.dbp * fuse.hemodynamic + morph.dbp * fuse.morphology;
  const map = dbp + (sbp - dbp) / 3;

  return {
    systolic: sbp,
    diastolic: dbp,
    map,
    pulsePressure: sbp - dbp,
    ...indices,
  };
}

export function enforceHemodynamicCoherence(
  sbp: number,
  dbp: number,
): { sbp: number; dbp: number } {
  const cfg = VITAL_THRESHOLDS.BP;
  let s = sbp;
  let d = dbp;
  let pp = s - d;

  if (pp > cfg.MAX_PP) {
    const excess = pp - cfg.MAX_PP;
    s -= excess * 0.6;
    d += excess * 0.25;
    pp = s - d;
  }
  if (pp < cfg.MIN_PP) {
    const deficit = cfg.MIN_PP - pp;
    s += deficit * 0.5;
    d -= deficit * 0.5;
    pp = s - d;
  }
  if (d >= s) {
    d = s - cfg.MIN_PP;
  }
  return { sbp: s, dbp: d };
}

/** Valida contra rangos fisiológicos; no sustituye valores inválidos por pisos. */
export function isPhysiologicalBp(sbp: number, dbp: number): boolean {
  const cfg = VITAL_THRESHOLDS.BP;
  if (!Number.isFinite(sbp) || !Number.isFinite(dbp)) return false;
  if (sbp < cfg.SYSTOLIC_MIN || sbp > cfg.SYSTOLIC_MAX) return false;
  if (dbp < cfg.DIASTOLIC_MIN || dbp > cfg.DIASTOLIC_MAX) return false;
  const pp = sbp - dbp;
  if (pp < cfg.MIN_PP || pp > cfg.MAX_PP) return false;
  const ratio = dbp / sbp;
  if (ratio < cfg.DIA_SYS_RATIO_MIN || ratio > cfg.DIA_SYS_RATIO_MAX) return false;
  const map = dbp + pp / 3;
  if (map < cfg.MAP_MIN || map > cfg.MAP_MAX) return false;
  return true;
}
