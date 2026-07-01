/**
 * Validated cardiac beat morphology for the PPG monitor canvas.
 *
 * IMPORTANT: this is a display-only morphology emitted after the runtime
 * peak detector has accepted a real PPG beat. It must never feed BPM, HRV,
 * arrhythmia, SpO2, BP, save-policy, or AI analysis. Those computations stay
 * on the real filtered PPG/RR stream.
 *
 * Rationale:
 * - Elgendi-style PPG peak detection remains the beat backbone.
 * - pyPPG/Aboy++ style pipelines separate beat detection/fiducials from the
 *   downstream biomarker computations.
 * - SQI-driven systems should avoid showing a confident beat morphology when
 *   contact/quality does not support a beat event.
 */

export interface ValidatedBeatMorphologyInput {
  /** Current monotonic timestamp, ideally performance.now(). */
  nowMs: number;
  /** Last accepted PPG peak timestamp from the detector. 0 means no accepted peak. */
  lastPeakTimestampMs: number;
  /** Relative beat amplitude derived from recent real PPG amplitude. */
  amplitudeScale: number;
  /** True only while the contact gate accepts the finger/camera signal. */
  hasUsableContact: boolean;
}

export const VALIDATED_BEAT_MORPHOLOGY = {
  /** After this age the trace intentionally rests on the baseline until the next accepted peak. */
  CYCLE_MS: 520,
  /** Positive systolic crest drawn exactly when the detector accepts the peak. */
  SYSTOLIC_APEX: 8.8,
  /** Negative whip/valley after the fast descent. */
  NEGATIVE_VALLEY: -3.9,
  /** Small dicrotic/elastic shoulder. */
  DICROTIC_SHOULDER: 1.25,
  /** Secondary notch below baseline before full recovery. */
  RECOVERY_NOTCH: -0.65,
  /** Keeps legitimate device/contact amplitude variation visible without giant false spikes. */
  MIN_AMP_SCALE: 0.70,
  MAX_AMP_SCALE: 1.35,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function easeOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * Builds the display-only beat shape requested for the central monitor:
 * baseline rest -> immediate validated systolic apex -> whip-like descent
 * below baseline -> negative valley/mesa -> dicrotic shoulder/notch -> baseline rest.
 */
export function generateValidatedBeatMorphology(input: ValidatedBeatMorphologyInput): number {
  const { nowMs, lastPeakTimestampMs, hasUsableContact } = input;
  if (!hasUsableContact || lastPeakTimestampMs <= 0) return 0;

  const elapsed = nowMs - lastPeakTimestampMs;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > VALIDATED_BEAT_MORPHOLOGY.CYCLE_MS) {
    return 0;
  }

  const ampScale = clamp(
    Number.isFinite(input.amplitudeScale) ? input.amplitudeScale : 1,
    VALIDATED_BEAT_MORPHOLOGY.MIN_AMP_SCALE,
    VALIDATED_BEAT_MORPHOLOGY.MAX_AMP_SCALE,
  );
  const apex = VALIDATED_BEAT_MORPHOLOGY.SYSTOLIC_APEX * ampScale;
  const valley = VALIDATED_BEAT_MORPHOLOGY.NEGATIVE_VALLEY * ampScale;
  const shoulder = VALIDATED_BEAT_MORPHOLOGY.DICROTIC_SHOULDER * ampScale;
  const notch = VALIDATED_BEAT_MORPHOLOGY.RECOVERY_NOTCH * ampScale;

  // 0-16 ms: systolic crest is already reached by the accepted Elgendi peak.
  // This creates the visible immediate ascent/rayo from the previous baseline sample.
  if (elapsed <= 16) return apex;

  // 16-72 ms: fast whip-like downstroke, crossing baseline into a negative trough.
  if (elapsed <= 72) {
    const t = easeOutCubic((elapsed - 16) / 56);
    return lerp(apex, valley, t);
  }

  // 72-118 ms: short negative valley/mesa to make the below-baseline trough readable.
  if (elapsed <= 118) {
    const t = smoothstep((elapsed - 72) / 46);
    return lerp(valley, valley * 0.78, t);
  }

  // 118-190 ms: elastic rebound toward a small dicrotic shoulder above baseline.
  if (elapsed <= 190) {
    const t = smoothstep((elapsed - 118) / 72);
    return lerp(valley * 0.78, shoulder, t);
  }

  // 190-270 ms: shallow secondary notch below baseline.
  if (elapsed <= 270) {
    const t = smoothstep((elapsed - 190) / 80);
    return lerp(shoulder, notch, t);
  }

  // 270-410 ms: final recovery to baseline with a soft plateau-like tail.
  if (elapsed <= 410) {
    const t = smoothstep((elapsed - 270) / 140);
    return lerp(notch, 0, t);
  }

  // 410-520 ms: true electrical/visual rest on the baseline until a new accepted beat.
  return 0;
}
