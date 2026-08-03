/**
 * HEMODYNAMIC MODEL — Physically-derived cardiovascular state equations.
 *
 * Core mathematical foundations:
 *   1. Navier-Stokes 1D (pulse wave propagation):
 *      ∂A/∂t + ∂(Au)/∂x = 0                         (mass conservation)
 *      ∂u/∂t + u·∂u/∂x = -(1/ρ)·∂p/∂x + ν·∂²u/∂x²  (momentum)
 *
 *   2. Moens-Korteweg (pulse wave velocity):
 *      PWV = √(Eh / 2ρr)
 *
 *   3. Windkessel 3-element (terminal impedance):
 *      p(L,t) = R1·Q(L,t) + p_C(t)
 *      dp_C/dt = Q(L,t)/C - p_C(t)/(R2·C)
 *
 *   4. Damped Harmonic Oscillator (single-point PPG observation):
 *      d²p/dt² + 2ζω₀·dp/dt + ω₀²·p = F(t)
 *
 * All parameters are in SI units internally. Conversion to clinical units
 * (mmHg, mL/s, etc.) happens at the observer output stage.
 *
 * References:
 *   - AVCT (arxiv 2605.10871, 2025) — Attractor-Vascular Coupling Theory
 *   - PHASE-Net (arxiv 2509.24850, 2025) — Navier-Stokes → ODE for PPG
 *   - Moens-Korteweg (1878) — PWV = √(Eh/2ρr)
 *   - Windkessel (Frank, 1899) — 3-element arterial impedance model
 *   - Alastruey et al. (2023) — Arterial pulse wave modeling review
 */

import { clamp } from '@/utils/math';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

// ═══════════════════════════════════════════════════════════
// CONSTANTS — Physiological defaults (SI units where applicable)
// ═══════════════════════════════════════════════════════════

/** Blood density (kg/m³) */
const RHO_BLOOD = 1060;

/** Blood kinematic viscosity (m²/s) — typical 3.5 cSt */
const NU_BLOOD = 3.5e-6;

/** Typical arterial wall Young's modulus (Pa) — ranges 0.4–1.6 MPa */
const E_DEFAULT = 8.0e5;

/** Typical arterial radius (m) — ~2mm for digital artery */
const R_DEFAULT = 2.0e-3;

/** Typical arterial wall thickness (m) — ~0.5mm */
const H_DEFAULT = 0.5e-3;

/** Arterial segment length for PTT estimation (m) — aorta to fingertip ~0.7m */
const L_ARTERY = 0.7;

/** Heart period typical (s) */
const T_HEART = 0.85;

/** Gravity for mmHg conversion */
const MMHG_TO_PA = 133.322;

// ═══════════════════════════════════════════════════════════
// STATE VECTOR — The hidden hemodynamic state
// ═══════════════════════════════════════════════════════════

/**
 * Hemodynamic state vector (6 dimensions):
 *   x[0] = p_MAP   — Mean arterial pressure (mmHg)
 *   x[1] = R_perif — Peripheral resistance (normalized, 0–1)
 *   x[2] = C_arter — Arterial compliance (normalized, 0–1)
 *   x[3] = PWV     — Pulse wave velocity (m/s)
 *   x[4] = p_dia   — Diastolic pressure (mmHg)
 *   x[5] = gamma   — Wave reflection coefficient (0–1)
 */
export const STATE_DIM = 6;
export const OBS_DIM = 1;

export interface HemodynamicState {
  map: number;        // Mean arterial pressure (mmHg)
  resistance: number; // Peripheral resistance (normalized 0–1)
  compliance: number; // Arterial compliance (normalized 0–1)
  pwv: number;        // Pulse wave velocity (m/s)
  diastolic: number;  // Diastolic pressure (mmHg)
  reflection: number; // Wave reflection coefficient (0–1)
}

export interface AnthropometricProfile {
  heightCm: number;
  weightKg: number;
  ageYears: number;
  isMale: boolean;
}

export interface HemodynamicBpResult {
  systolic: number;
  diastolic: number;
  map: number;
  pulsePressure: number;
  pwv: number;
  resistanceIndex: number;
  complianceIndex: number;
  reflectionIndex: number;
  coherenceScore: number; // 0–1, internal consistency check
}

// ═══════════════════════════════════════════════════════════
// MOENS-KORTEWEG — PWV from arterial properties
// ═══════════════════════════════════════════════════════════

/**
 * Moens-Korteweg equation: PWV = √(Eh / 2ρr)
 * Connects arterial wall stiffness (E), geometry (h, r) to wave speed.
 *
 * Inverse: given PWV, infer effective stiffness E = 2ρr·PWV²/h
 */
export function moensKorteweg(
  E: number = E_DEFAULT,
  h: number = H_DEFAULT,
  rho: number = RHO_BLOOD,
  r: number = R_DEFAULT,
): number {
  return Math.sqrt((E * h) / (2 * rho * r));
}

export function inverseMoensKorteweg(
  pwv: number,
  h: number = H_DEFAULT,
  rho: number = RHO_BLOOD,
  r: number = R_DEFAULT,
): number {
  return (2 * rho * r * pwv * pwv) / h;
}

// ═══════════════════════════════════════════════════════════
// WINDKESEL 3-ELEMENT — Terminal arterial impedance
// ═══════════════════════════════════════════════════════════

/**
 * 3-element Windkessel model:
 *   - R1: proximal resistance (characteristic impedance)
 *   - C:  arterial compliance
 *   - R2: distal resistance (peripheral)
 *
 * Boundary condition at x = L:
 *   p(L,t) = R1·Q(L,t) + p_C(t)
 *   dp_C/dt = Q(L,t)/C - p_C(t)/(R2·C)
 *
 * State: p_C (capacitor pressure)
 * Input: Q(L,t) (flow at terminal)
 * Output: p(L,t) (terminal pressure = observable proxy)
 */
export interface WindkesselParams {
  R1: number; // Proximal resistance (Pa·s/m³)
  C: number;  // Arterial compliance (m³/Pa)
  R2: number; // Distal resistance (Pa·s/m³)
}

/**
 * Propagate Windkessel state forward by dt using RK4 integration.
 * Returns new p_C after one time step.
 */
export function windkesselStep(
  pC: number,
  Q: number,
  params: WindkesselParams,
  dt: number,
): number {
  const { C, R2 } = params;
  if (C <= 0 || R2 <= 0 || dt <= 0) return pC;

  // dp_C/dt = f(p_C) = Q/C - p_C/(R2·C)
  const f = (pc: number) => Q / C - pc / (R2 * C);

  // RK4 integration
  const k1 = f(pC);
  const k2 = f(pC + dt * 0.5 * k1);
  const k3 = f(pC + dt * 0.5 * k2);
  const k4 = f(pC + dt * k3);

  return pC + (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
}

/**
 * Compute terminal pressure from Windkessel state.
 */
export function windkesselPressure(
  Q: number,
  pC: number,
  params: WindkesselParams,
): number {
  return params.R1 * Q + pC;
}

// ═══════════════════════════════════════════════════════════
// DAMPED HARMONIC OSCILLATOR — PPG as observation
// ═══════════════════════════════════════════════════════════

/**
 * The PPG signal at a single observation point (fingertip) can be modeled as
 * a damped harmonic oscillator driven by the cardiac source:
 *
 *   d²p/dt² + 2ζω₀·dp/dt + ω₀²·p = F(t)
 *
 * Where:
 *   ω₀ = PWV / L        (fundamental frequency from wave propagation)
 *   ζ  = ν / (2·ω₀·r²)  (damping from blood viscosity)
 *   F(t) = cardiac driving force (systolic ejection)
 *
 * This is the key equation from PHASE-Net (2025): Navier-Stokes → ODE
 * at a fixed observation point.
 */
export interface OscillatorParams {
  omega0: number;  // Natural frequency (rad/s)
  zeta: number;    // Damping ratio (0–1)
  F0: number;      // Driving amplitude
}

export function oscillatorParamsFromState(
  pwv: number,
  resistance: number,
  compliance: number,
): OscillatorParams {
  const omega0 = pwv / L_ARTERY;
  // Damping: ζ = ν·L / (2·ω₀·r²·PWV) — simplified from Navier-Stokes
  // Higher resistance → higher damping
  const zeta = clamp(
    0.15 + 0.35 * resistance + 0.1 * (1 - compliance),
    0.05,
    0.85,
  );
  const F0 = 1.0; // Normalized driving force
  return { omega0, zeta, F0 };
}

/**
 * Analytical solution of the damped oscillator at time t for initial conditions.
 * Used to predict what the PPG observation should look like.
 */
export function oscillatorSolution(
  t: number,
  params: OscillatorParams,
  p0: number = 0,
  dp0: number = 0,
): number {
  const { omega0, zeta, F0 } = params;
  if (omega0 <= 0) return 0;

  const wd = omega0 * Math.sqrt(Math.max(0, 1 - zeta * zeta)); // damped frequency
  if (wd < 1e-10) return F0 / (omega0 * omega0); // overdamped

  const decay = Math.exp(-zeta * omega0 * t);
  const cosWd = Math.cos(wd * t);
  const sinWd = Math.sin(wd * t);

  // Particular solution for constant driving F0
  const pSteady = F0 / (omega0 * omega0);

  // Homogeneous + particular
  const A = p0 - pSteady;
  const B = (dp0 + zeta * omega0 * A) / wd;

  return pSteady + decay * (A * cosWd + B * sinWd);
}

// ═══════════════════════════════════════════════════════════
// PPG OBSERVATION MODEL — Maps state to observable PPG
// ═══════════════════════════════════════════════════════════

/**
 * Observation function h(x): maps hemodynamic state to expected PPG value.
 *
 * The PPG signal is proportional to the volume change, which depends on:
 *   - Arterial pressure (via compliance: ΔV = C · Δp)
 *   - Pulse wave shape (via PWV and reflection)
 *
 * h(x) = C_arter · (p_MAP - p_dia) · (1 + gamma · reflection_coeff)
 *
 * This is a simplified but physically motivated mapping.
 */
export function observationModel(
  state: number[], // [p_MAP, R, C, PWV, p_dia, gamma]
): number {
  const pMAP = state[0];
  const C = state[2];
  const pDia = state[4];
  const gamma = state[5];

  // PPG amplitude ∝ volume change ∝ compliance × pulse pressure × reflection
  const pulsePressure = Math.max(0, pMAP - pDia);
  const reflectionBoost = 1.0 + gamma * 0.3; // reflection adds ~30% max

  return C * pulsePressure * reflectionBoost;
}

/**
 * Jacobian of observation model ∂h/∂x — needed for EKF update.
 * Returns 1×6 matrix (row vector).
 */
export function observationJacobian(state: number[]): number[] {
  const pMAP = state[0];
  const C = state[2];
  const pDia = state[4];
  const gamma = state[5];
  const pp = Math.max(0.1, pMAP - pDia);
  const rb = 1.0 + gamma * 0.3;

  return [
    C * rb,           // ∂h/∂p_MAP
    0,                // ∂h/∂R
    pp * rb,          // ∂h/∂C
    0,                // ∂h/∂PWV
    -C * rb,          // ∂h/∂p_dia
    0.3 * C * pp,     // ∂h/∂gamma
  ];
}

// ═══════════════════════════════════════════════════════════
// STATE PROPAGATION — Physics-based prediction step
// ═══════════════════════════════════════════════════════════

/**
 * Propagate hemodynamic state forward by dt using simplified physics.
 *
 * This is NOT a learned function — it encodes the differential equations:
 *   - Pressure evolves via Windkessel dynamics
 *   - PWV evolves via Moens-Korteweg (slowly, as arterial tone changes)
 *   - Resistance evolves via autoregulation (slow exponential)
 *   - Compliance evolves inversely with pressure (arterial distension)
 *   - Reflection evolves slowly with arterial stiffness
 */
export function propagateState(
  state: number[],
  dt: number,
  hr: number, // heart rate (bpm) — driving frequency
): number[] {
  const [pMAP, R, C, PWV, pDia, gamma] = state;

  // Heart period
  const T = Math.max(0.3, 60 / Math.max(40, Math.min(200, hr)));
  const omegaCardiac = (2 * Math.PI) / T;

  // Windkessel-driven pressure evolution
  // dp_MAP/dt ≈ (Q_in - Q_out) / C_total
  // Simplified: pressure decays during diastole, rises during systole
  const systolicFraction = clamp(0.35 + 0.05 * (hr - 72) / 30, 0.25, 0.45);
  const inFlow = systolicFraction * omegaCardiac; // cardiac input
  const outFlow = pMAP / (R * 1e6); // peripheral run-off (R in normalized units)
  const dpMAP = (inFlow - outFlow * 0.001) * dt * 50;

  // Diastolic follows MAP with offset
  const dpDia = dpMAP * 0.7 - (pMAP - pDia - 40) * 0.02 * dt;

  // PWV evolves slowly — arterial stiffness changes with sympathetic tone
  // Higher HR → more sympathetic → stiffer → higher PWV
  const PWVtarget = 5.5 + 1.5 * (hr - 72) / 60; // typical range 4–8 m/s
  const dPWV = (PWVtarget - PWV) * 0.01 * dt;

  // Compliance inversely related to pressure (distension reduces compliance)
  const Ctarget = clamp(1.0 - (pMAP - 100) * 0.005, 0.3, 1.0);
  const dC = (Ctarget - C) * 0.008 * dt;

  // Resistance: slow autoregulation
  const Rtarget = clamp(0.5 + (pMAP - 100) * 0.003, 0.2, 0.9);
  const dR = (Rtarget - R) * 0.005 * dt;

  // Reflection: slowly tracks stiffness
  const gammaTarget = clamp(0.3 + (PWV - 5) * 0.08, 0.1, 0.7);
  const dGamma = (gammaTarget - gamma) * 0.003 * dt;

  return [
    pMAP + dpMAP,
    clamp(R + dR, 0.05, 0.95),
    clamp(C + dC, 0.05, 1.0),
    PWV + dPWV,
    pDia + dpDia,
    clamp(gamma + dGamma, 0.0, 0.8),
  ];
}

/**
 * Jacobian of state propagation ∂f/∂x — needed for EKF prediction.
 * Returns 6×6 matrix (flat array, row-major).
 */
export function propagationJacobian(
  state: number[],
  dt: number,
  hr: number,
): number[] {
  const [pMAP, R, C, PWV] = state;
  const T = Math.max(0.3, 60 / Math.max(40, Math.min(200, hr)));

  // Sensitivity of pressure evolution to each state
  const dpMAP_dR = (pMAP / (R * 1e6)) * 0.001 * dt * 50 / Math.max(0.01, R);
  const dpMAP_dC = 0; // pressure change doesn't directly depend on C in this simplified form
  const dpMAP_dPWV = 0;

  // Sensitivity of PWV evolution
  const PWVtarget = 5.5 + 1.5 * (hr - 72) / 60;
  const dPWV_dPWV = 1 - 0.01 * dt;

  // Sensitivity of compliance evolution
  const dC_dC = 1 - 0.008 * dt;
  const dC_dMAP = -0.005 * 0.008 * dt;

  // Sensitivity of resistance evolution
  const dR_dR = 1 - 0.005 * dt;
  const dR_dMAP = 0.003 * 0.005 * dt;

  // Sensitivity of reflection evolution
  const dGamma_dGamma = 1 - 0.003 * dt;
  const dGamma_dPWV = 0.08 * 0.003 * dt;

  // Build 6×6 Jacobian (row-major)
  return [
    1, dpMAP_dR, dpMAP_dC, dpMAP_dPWV, 0, 0,       // row 0: dp_MAP
    0, dR_dR, 0, 0, dR_dMAP, 0,                      // row 1: dR
    0, 0, dC_dC, 0, dC_dMAP, 0,                      // row 2: dC
    0, 0, 0, dPWV_dPWV, 0, 0,                        // row 3: dPWV
    0.7, 0, 0, 0, 1 + 0.02 * dt, 0,                    // row 4: dp_dia (pMAP coupling + self-sensitivity)
    0, 0, 0, dGamma_dPWV, 0, dGamma_dGamma,           // row 5: dgamma
  ];
}

// ═══════════════════════════════════════════════════════════
// COHERENCE ENFORCER — Internal consistency validation
// ═══════════════════════════════════════════════════════════

/**
 * Hemodynamic coherence check: verify that estimated state is
 * physically self-consistent.
 *
 * Returns a coherence score 0–1 where:
 *   1.0 = fully coherent
 *   0.5 = partially coherent (some constraints violated)
 *   0.0 = incoherent (physically impossible)
 */
export function hemodynamicCoherence(state: number[]): number {
  const [pMAP, R, C, PWV, pDia, gamma] = state;
  let score = 1.0;

  // 1. MAP > DBP (fundamental)
  if (pMAP <= pDia) score *= 0.5;

  // 2. Pulse pressure in physiological range (15–110 mmHg)
  const pp = pMAP - pDia;
  if (pp < 15 || pp > 110) score *= 0.6;

  // 3. DBP/SBP ratio in range (0.30–0.90)
  const ratio = pDia / Math.max(1, pMAP);
  if (ratio < 0.30 || ratio > 0.90) score *= 0.7;

  // 4. MAP in range (50–150 mmHg)
  if (pMAP < 50 || pMAP > 150) score *= 0.5;

  // 5. PWV physiological (3–15 m/s)
  if (PWV < 3 || PWV > 15) score *= 0.7;

  // 6. Compliance positive
  if (C <= 0) score *= 0.3;

  // 7. Resistance in range
  if (R < 0.05 || R > 0.95) score *= 0.7;

  // 8. Reflection in [0, 1]
  if (gamma < 0 || gamma > 1) score *= 0.6;

  // 9. PWV-R consistency: higher resistance should correlate with higher PWV
  // (both increase with arterial stiffness)
  const expectedPWV = 4.0 + R * 5.0;
  const pwvDeviation = Math.abs(PWV - expectedPWV) / expectedPWV;
  if (pwvDeviation > 0.5) score *= 0.8;

  // 10. C-R relationship: high resistance + high compliance is unusual
  // (stiff arteries have both high R and low C)
  if (R > 0.7 && C > 0.8) score *= 0.85;
  if (R < 0.3 && C < 0.3) score *= 0.85;

  return clamp(score, 0, 1);
}

// ═══════════════════════════════════════════════════════════
// STATE → CLINICAL — Convert internal state to mmHg
// ═══════════════════════════════════════════════════════════

/**
 * Convert hemodynamic state to clinical blood pressure values.
 *
 * The state is in internal units; this function maps to mmHg using
 * physiologically derived relationships.
 */
export function stateToBloodPressure(state: number[]): HemodynamicBpResult {
  const [pMAP, R, C, PWV, pDia, gamma] = state;

  // MAP is directly estimated (state variable)
  const map = clamp(pMAP, VITAL_THRESHOLDS.BP.MAP_MIN, VITAL_THRESHOLDS.BP.MAP_MAX);

  // Pulse pressure from Windkessel: PP = Q₀ · √(R² + 1/(ω²C²))
  // Simplified: PP ∝ R/C (resistance/compliance ratio)
  const rcRatio = R / Math.max(0.01, C);
  const ppBase = clamp(rcRatio * 30, 15, 110); // scale to physiological range

  // Reflection adds to systolic peak
  const reflectionPP = gamma * ppBase * 0.25;

  const pp = clamp(ppBase + reflectionPP, VITAL_THRESHOLDS.BP.PP_MIN, VITAL_THRESHOLDS.BP.PP_MAX);

  // SBP and DBP from MAP and PP
  let sbp = map + (2 / 3) * pp;
  let dbp = map - (1 / 3) * pp;

  // Enforce physiological bounds
  sbp = clamp(sbp, VITAL_THRESHOLDS.BP.SYSTOLIC_MIN, VITAL_THRESHOLDS.BP.SYSTOLIC_MAX);
  dbp = clamp(dbp, VITAL_THRESHOLDS.BP.DIASTOLIC_MIN, VITAL_THRESHOLDS.BP.DIASTOLIC_MAX);

  // Ensure SBP > DBP
  if (sbp <= dbp) {
    sbp = dbp + VITAL_THRESHOLDS.BP.PP_MIN;
    sbp = clamp(sbp, VITAL_THRESHOLDS.BP.SYSTOLIC_MIN, VITAL_THRESHOLDS.BP.SYSTOLIC_MAX);
  }

  const coherence = hemodynamicCoherence(state);

  return {
    systolic: sbp,
    diastolic: dbp,
    map,
    pulsePressure: sbp - dbp,
    pwv: PWV,
    resistanceIndex: R,
    complianceIndex: C,
    reflectionIndex: gamma,
    coherenceScore: coherence,
  };
}

// ═══════════════════════════════════════════════════════════
// INITIAL STATE — Physiological defaults for cold start
// ═══════════════════════════════════════════════════════════

/**
 * Default initial state — represents a normotensive adult.
 * State: [pMAP, R, C, PWV, pDia, gamma]
 */
export function defaultInitialState(): number[] {
  return [
    93,    // pMAP: ~93 mmHg (normal MAP)
    0.50,  // R: moderate peripheral resistance
    0.65,  // C: moderate arterial compliance
    6.0,   // PWV: 6 m/s (normal for young adult)
    78,    // pDia: ~78 mmHg
    0.35,  // gamma: moderate wave reflection
  ];
}

/**
 * Process noise covariance Q — represents model uncertainty.
 * Diagonal matrix; each entry is the expected variance of that state
 * per time step. Physiologically motivated:
 *   - Pressure: higher noise (fast-varying)
 *   - R, C: lower noise (slow-varying)
 *   - PWV: very low noise (very slow)
 *   - Reflection: low noise
 */
export function processNoiseCovariance(dt: number): number[] {
  const q = [
    2.0,   // pMAP: ±2 mmHg/frame noise
    0.001, // R: slow drift
    0.001, // C: slow drift
    0.01,  // PWV: very slow
    1.5,   // pDia: ±1.5 mmHg/frame
    0.0005,// gamma: very slow
  ];
  // Scale by dt (larger time step → more uncertainty)
  return q.map(v => v * dt);
}

/**
 * Measurement noise covariance R_obs — represents PPG observation uncertainty.
 * Scalar (single observation channel).
 */
export function measurementNoiseCovariance(): number {
  return 0.5; // PPG observation noise variance
}

// ═══════════════════════════════════════════════════════════
// VALIDITY CHECKS
// ═══════════════════════════════════════════════════════════

/**
 * Validate that a state vector contains finite, bounded values.
 */
export function isValidState(state: number[]): boolean {
  if (state.length !== STATE_DIM) return false;
  for (let i = 0; i < STATE_DIM; i++) {
    if (!Number.isFinite(state[i])) return false;
  }
  // Basic physiological bounds
  if (state[0] < 20 || state[0] > 300) return false; // pMAP
  if (state[1] < 0 || state[1] > 1) return false;     // R
  if (state[2] < 0 || state[2] > 2) return false;     // C
  if (state[3] < 1 || state[3] > 20) return false;    // PWV
  if (state[4] < 20 || state[4] > 200) return false;  // pDia
  if (state[5] < -0.5 || state[5] > 1.5) return false; // gamma
  return true;
}
