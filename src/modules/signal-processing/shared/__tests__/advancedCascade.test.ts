import { describe, it, expect } from 'vitest';
import { SignalResampler } from '../SignalResampler';
import { MovingAverageDetrending } from '../MovingAverageDetrending';
import { ButterworthFilter, ButterworthBandpass } from '../ButterworthFilter';

describe('SignalResampler', () => {
  it('resamples irregular timestamps to perfect target intervals', () => {
    const resampler = new SignalResampler(30, 'cubic');

    // Simulate 30 Hz with small timestamp jitter (+-5ms)
    const dtBase = 1000 / 30; // 33.333 ms
    let time = 1000.0;
    
    // Push 10 irregular samples
    for (let i = 0; i < 10; i++) {
      const jitter = (Math.random() - 0.5) * 10; // -5 to +5 ms
      const currentVal = Math.sin(2 * Math.PI * 1.0 * (time / 1000)); // 1 Hz wave
      resampler.push(
        time + jitter,
        currentVal, // r
        currentVal, // g
        currentVal, // b
        1.0,        // coverage
        0.95,       // fingerScore
        25,         // fingerTileCount
        0.02        // centroidMotion
      );
      time += dtBase;
    }

    const pending = resampler.getPendingSamples();
    expect(pending.length).toBeGreaterThan(0);
    
    // Ensure spacing between resampled frames is EXACTLY 33.333333333333336 ms
    for (let i = 1; i < pending.length; i++) {
      const diff = pending[i].time - pending[i - 1].time;
      expect(diff).toBeCloseTo(dtBase, 5);
    }
  });

  it('falls back to linear interpolation when points are fewer than 4', () => {
    const resampler = new SignalResampler(30, 'cubic');
    
    resampler.push(1000, 10, 10, 10, 1.0, 1.0, 25, 0);
    resampler.push(1040, 20, 20, 20, 1.0, 1.0, 25, 0);
    
    const pending = resampler.getPendingSamples();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].g).toBeGreaterThanOrEqual(10);
    expect(pending[0].g).toBeLessThanOrEqual(20);
  });
});

describe('MovingAverageDetrending', () => {
  it('cancels baseline drift', () => {
    const detrend = new MovingAverageDetrending(10);
    
    // Input is a flat line at 100 with a linear drift (+5 per step)
    // The detrended signal should return to around 0 once initialized
    let lastVal = 0;
    for (let i = 0; i < 30; i++) {
      const val = 100 + i * 5;
      lastVal = detrend.filter(val);
    }
    
    // Drift is constant, MA(10) lags behind by 5 * 4.5 = 22.5.
    // The filter outputs value - MA(value).
    // For i=29, val=245. The window has [200, 205, ..., 245], mean=222.5.
    // val - mean = 245 - 222.5 = 22.5.
    // This removes the massive 100 offset and the long-term trend, keeping it stable around the local diff.
    expect(lastVal).toBeCloseTo(22.5, 1);
  });
});

describe('ButterworthFilter', () => {
  it('attenuates high-frequency noise', () => {
    const fs = 30;
    const bandpass = new ButterworthBandpass(4, 0.75, 3.33, fs);

    // 1. Generate clean cardiac signal (1.5 Hz = 90 BPM)
    // 2. Generate high-frequency noise (10 Hz)
    // 3. Verify that the ratio of HF noise to Cardiac signal is heavily reduced after filtering.
    let cardiacSum = 0;
    let noiseSum = 0;

    // Warm up filter
    for (let i = 0; i < 60; i++) {
      bandpass.filter(0);
    }

    // Measure gain at 1.5 Hz (within passband)
    let cardiacMaxOut = 0;
    for (let i = 0; i < 60; i++) {
      const input = Math.sin(2 * Math.PI * 1.5 * (i / fs));
      const out = bandpass.filter(input);
      cardiacMaxOut = Math.max(cardiacMaxOut, Math.abs(out));
    }

    bandpass.reset();
    for (let i = 0; i < 100; i++) bandpass.filter(0);

    // Measure gain at 10 Hz (stopband)
    let noiseMaxOut = 0;
    for (let i = 0; i < 100; i++) {
      const input = Math.sin(2 * Math.PI * 10 * (i / fs));
      const out = bandpass.filter(input);
      noiseMaxOut = Math.max(noiseMaxOut, Math.abs(out));
    }

    // Bandpass should transmit 1.5 Hz well but heavily attenuate 10 Hz
    expect(cardiacMaxOut).toBeGreaterThan(0.3);
    expect(noiseMaxOut).toBeLessThan(0.08);
    expect(cardiacMaxOut / noiseMaxOut).toBeGreaterThan(5.0);
  });
});
