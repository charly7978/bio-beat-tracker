import { describe, expect, it } from 'vitest';
import {
  generateValidatedBeatMorphology,
  VALIDATED_BEAT_MORPHOLOGY,
} from '../validatedBeatMorphology';

describe('generateValidatedBeatMorphology', () => {
  it('rests on baseline without usable contact or accepted peak', () => {
    expect(generateValidatedBeatMorphology({
      nowMs: 1000,
      lastPeakTimestampMs: 0,
      amplitudeScale: 1,
      hasUsableContact: true,
    })).toBe(0);

    expect(generateValidatedBeatMorphology({
      nowMs: 1000,
      lastPeakTimestampMs: 1000,
      amplitudeScale: 1,
      hasUsableContact: false,
    })).toBe(0);
  });

  it('draws the requested validated beat cycle: apex, whip descent, negative valley, rebound, rest', () => {
    const peakMs = 1000;
    const apex = generateValidatedBeatMorphology({ nowMs: peakMs, lastPeakTimestampMs: peakMs, amplitudeScale: 1, hasUsableContact: true });
    const downstroke = generateValidatedBeatMorphology({ nowMs: peakMs + 48, lastPeakTimestampMs: peakMs, amplitudeScale: 1, hasUsableContact: true });
    const valley = generateValidatedBeatMorphology({ nowMs: peakMs + 90, lastPeakTimestampMs: peakMs, amplitudeScale: 1, hasUsableContact: true });
    const shoulder = generateValidatedBeatMorphology({ nowMs: peakMs + 180, lastPeakTimestampMs: peakMs, amplitudeScale: 1, hasUsableContact: true });
    const notch = generateValidatedBeatMorphology({ nowMs: peakMs + 250, lastPeakTimestampMs: peakMs, amplitudeScale: 1, hasUsableContact: true });
    const rest = generateValidatedBeatMorphology({ nowMs: peakMs + VALIDATED_BEAT_MORPHOLOGY.CYCLE_MS + 1, lastPeakTimestampMs: peakMs, amplitudeScale: 1, hasUsableContact: true });

    expect(apex).toBeGreaterThan(8);
    expect(downstroke).toBeLessThan(apex);
    expect(valley).toBeLessThan(-2);
    expect(shoulder).toBeGreaterThan(0);
    expect(notch).toBeLessThan(0);
    expect(rest).toBe(0);
  });

  it('clamps amplitude scale so display variation stays robust', () => {
    const peakMs = 500;
    const tiny = generateValidatedBeatMorphology({ nowMs: peakMs, lastPeakTimestampMs: peakMs, amplitudeScale: 0.01, hasUsableContact: true });
    const huge = generateValidatedBeatMorphology({ nowMs: peakMs, lastPeakTimestampMs: peakMs, amplitudeScale: 10, hasUsableContact: true });

    expect(tiny).toBeCloseTo(VALIDATED_BEAT_MORPHOLOGY.SYSTOLIC_APEX * VALIDATED_BEAT_MORPHOLOGY.MIN_AMP_SCALE, 5);
    expect(huge).toBeCloseTo(VALIDATED_BEAT_MORPHOLOGY.SYSTOLIC_APEX * VALIDATED_BEAT_MORPHOLOGY.MAX_AMP_SCALE, 5);
  });
});
