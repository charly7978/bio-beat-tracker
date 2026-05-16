import { describe, expect, it } from 'vitest';
import { shouldEmitMetronomeBeat } from '../beatMetronome';

describe('beatMetronome', () => {
  it('emite tras el intervalo refractario del BPM', () => {
    const bpm = 60;
    const refractory = (60000 / bpm) * 0.78;
    expect(
      shouldEmitMetronomeBeat({
        nowMs: 1000 + refractory + 1,
        lastEmittedPeakMs: 1000,
        displayBpm: bpm,
        consecutivePeaks: 3,
        lastGoodBpmAgeMs: 100,
        minBpm: 35,
        maxBpm: 200,
      }),
    ).toBe(true);
  });

  it('no emite si el BPM está fuera de rango', () => {
    expect(
      shouldEmitMetronomeBeat({
        nowMs: 5000,
        lastEmittedPeakMs: 0,
        displayBpm: 20,
        consecutivePeaks: 5,
        lastGoodBpmAgeMs: 0,
        minBpm: 35,
        maxBpm: 200,
      }),
    ).toBe(false);
  });
});
