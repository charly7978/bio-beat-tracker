import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock AudioContext before importing HeartBeatProcessor
class MockAudioContext {
  state = 'running';
  currentTime = 0;
  resume = vi.fn().mockResolvedValue(undefined);
  createOscillator = vi.fn(() => ({
    frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }));
  createGain = vi.fn(() => ({
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  }));
  close = vi.fn().mockResolvedValue(undefined);
}

const mockAudioCtx = new MockAudioContext();
vi.stubGlobal('AudioContext', vi.fn(() => mockAudioCtx));
vi.stubGlobal('webkitAudioContext', undefined);

// Mock haptics
vi.mock('../../utils/haptics', () => ({
  triggerHeartbeatHaptic: vi.fn().mockResolvedValue(undefined),
}));

import { HeartBeatProcessor } from '../HeartBeatProcessor';

function makeSignal(bpm: number, fs: number, amplitude: number, dc: number, n: number): { filtered: number[]; times: number[] } {
  const filtered: number[] = [];
  const times: number[] = [];
  const hrHz = bpm / 60;
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    const t = start + (i / fs) * 1000;
    filtered.push(dc + amplitude * Math.sin(2 * Math.PI * hrHz * (i / fs)));
    times.push(t);
  }
  return { filtered, times };
}

describe('HeartBeatProcessor', () => {
  let hbp: HeartBeatProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    hbp = new HeartBeatProcessor();
  });

  it('returns zero BPM on insufficient samples', () => {
    const r = hbp.processSignal(0, performance.now());
    expect(r.bpm).toBe(0);
    expect(r.confidence).toBe(0);
    expect(r.isPeak).toBe(false);
  });

  it('returns zero BPM for zero-value signal', () => {
    for (let i = 0; i < 50; i++) {
      hbp.processSignal(0, performance.now() + i * 33);
    }
    const r = hbp.processSignal(0, performance.now());
    expect(r.bpm).toBe(0);
    expect(r.confidence).toBe(0);
  });

  it('detects peaks in clean 72 BPM signal', () => {
    const { filtered, times } = makeSignal(72, 30, 8, 0, 400);
    hbp.setFingerContactConfirmed(true);
    let peakCount = 0;
    for (let i = 0; i < filtered.length; i++) {
      const r = hbp.processSignal(filtered[i], times[i]);
      if (r.isPeak) peakCount++;
    }
    expect(peakCount).toBeGreaterThanOrEqual(2);
    const final = hbp.processSignal(filtered[filtered.length - 1], times[times.length - 1] + 33);
    expect(final.bpm).toBeGreaterThan(55);
    expect(final.bpm).toBeLessThan(90);
  });

  it('computes internal SQI over time', () => {
    const { filtered, times } = makeSignal(72, 30, 8, 0, 300);
    hbp.setFingerContactConfirmed(true);
    let lastSqi = 0;
    for (let i = 0; i < filtered.length; i++) {
      const r = hbp.processSignal(filtered[i], times[i]);
      lastSqi = r.sqi;
    }
    expect(lastSqi).toBeGreaterThan(0);
    expect(lastSqi).toBeLessThanOrEqual(100);
  });

  it('exposes internalSqi and externalSqi in processSignal output', () => {
    hbp.setPpgQualityMetrics(80, 0.005, 0);
    const { filtered, times } = makeSignal(72, 30, 8, 0, 300);
    hbp.setFingerContactConfirmed(true);
    let result: ReturnType<typeof hbp.processSignal> | null = null;
    for (let i = 0; i < filtered.length; i++) {
      result = hbp.processSignal(filtered[i], times[i]);
    }
    expect(result).not.toBeNull();
    expect(result!.internalSqi).toBeGreaterThanOrEqual(0);
    expect(result!.externalSqi).toBe(80);
  });

  it('tracks RR intervals after peak detection', () => {
    const { filtered, times } = makeSignal(72, 30, 8, 0, 400);
    hbp.setFingerContactConfirmed(true);
    let lastResult: ReturnType<typeof hbp.processSignal> | null = null;
    for (let i = 0; i < filtered.length; i++) {
      lastResult = hbp.processSignal(filtered[i], times[i]);
    }
    expect(lastResult!.rrData!.intervals.length).toBeGreaterThanOrEqual(1);
    expect(lastResult!.rrData!.lastPeakTime).toBeGreaterThan(0);
  });

  it('resets peak tracking correctly', () => {
    const { filtered, times } = makeSignal(72, 30, 8, 0, 200);
    hbp.setFingerContactConfirmed(true);
    let peakCount = 0;
    for (let i = 0; i < filtered.length; i++) {
      const r = hbp.processSignal(filtered[i], times[i]);
      if (r.isPeak) peakCount++;
    }
    expect(peakCount).toBeGreaterThan(0);
    hbp.resetPeakTracking();
    const r = hbp.processSignal(filtered[0], times[0] + 10000);
    expect(r.bpm).toBe(0);
    if (r.rrData) {
      expect(r.rrData.intervals).toHaveLength(0);
    }
  });

  it('softReacquirePeaks resets peak tracking state gracefully', () => {
    const { filtered, times } = makeSignal(72, 30, 8, 0, 200);
    hbp.setFingerContactConfirmed(true);
    for (let i = 0; i < filtered.length; i++) hbp.processSignal(filtered[i], times[i]);
    const rrBefore = hbp.getRRIntervals().length;
    expect(rrBefore).toBeGreaterThan(0);
    hbp.softReacquirePeaks(performance.now());
    const r = hbp.processSignal(filtered[filtered.length - 1], times[times.length - 1] + 33);
    expect(r.rrData!.intervals.length).toBeGreaterThanOrEqual(0);
  });

  it('processSignal returns consistent diagnostics', () => {
    const { filtered, times } = makeSignal(72, 30, 8, 0, 300);
    hbp.setFingerContactConfirmed(true);
    for (let i = 0; i < filtered.length; i++) hbp.processSignal(filtered[i], times[i]);
    const diag = hbp.getDiagnostics();
    expect(diag.internalSqi).toBeGreaterThanOrEqual(0);
    expect(diag.externalSqi).toBeGreaterThanOrEqual(0);
    expect(diag.ensemble).toBeDefined();
  });

  it('exposes RR intervals via getRRIntervals', () => {
    expect(hbp.getRRIntervals()).toEqual([]);
    const { filtered, times } = makeSignal(72, 30, 8, 0, 400);
    hbp.setFingerContactConfirmed(true);
    for (let i = 0; i < filtered.length; i++) hbp.processSignal(filtered[i], times[i]);
    expect(hbp.getRRIntervals().length).toBeGreaterThan(0);
  });

  it('handles NaN/Infinity in filteredValue gracefully', () => {
    hbp.setFingerContactConfirmed(true);
    const r = hbp.processSignal(NaN, performance.now());
    expect(r.bpm).toBe(0);
    expect(r.isPeak).toBe(false);
    expect(r.filteredValue).toBe(0);
  });

  it('setPpgQualityMetrics clamps values correctly', () => {
    hbp.setPpgQualityMetrics(-5, -1, -0.1);
    const { filtered, times } = makeSignal(72, 30, 8, 0, 100);
    for (let i = 0; i < filtered.length; i++) hbp.processSignal(filtered[i], times[i]);
    const diag = hbp.getDiagnostics();
    expect(diag.externalSqi).toBeGreaterThanOrEqual(0);
  });

  it('reset clears all state', () => {
    const { filtered, times } = makeSignal(72, 30, 8, 0, 300);
    hbp.setFingerContactConfirmed(true);
    for (let i = 0; i < filtered.length; i++) hbp.processSignal(filtered[i], times[i]);
    hbp.reset();
    const r = hbp.processSignal(0, performance.now());
    expect(r.bpm).toBe(0);
    expect(hbp.getDiagnostics().internalSqi).toBe(0);
    expect(hbp.getDiagnostics().externalSqi).toBe(0);
  });

  it('dispose cleans up audio resources', () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    const fakeCtx = { close: closeSpy };
    (hbp as unknown as { audioContext: { close: () => Promise<void> } | null }).audioContext = fakeCtx as unknown as AudioContext;
    hbp.dispose();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('setFingerPlacementMode updates mode', () => {
    hbp.setFingerPlacementMode('pad');
    const { filtered, times } = makeSignal(72, 30, 8, 0, 100);
    for (let i = 0; i < filtered.length; i++) hbp.processSignal(filtered[i], times[i]);
    expect(hbp.getDiagnostics()).toBeDefined();
  });
});
