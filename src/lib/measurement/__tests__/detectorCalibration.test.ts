import { describe, expect, it } from 'vitest';
import { computeDetectorCalibration } from '../detectorCalibration';

function sinePpg(fs: number, sec: number, bpm: number): number[] {
  const n = Math.floor(fs * sec);
  const y: number[] = [];
  const periodMs = 60000 / bpm;
  for (let i = 0; i < n; i++) {
    const ti = (i / fs) * 1000;
    const phase = ((ti % periodMs) / periodMs) * Math.PI * 2;
    y.push(Math.max(0, Math.sin(phase)) ** 3 * 1.1);
  }
  return y;
}

describe('detectorCalibration', () => {
  it('señal débil → prominencia Elgendi más baja (mayor sensibilidad)', () => {
    const weak = Array(200).fill(0).map((_, i) => 0.02 + 0.01 * Math.sin(i * 0.2));
    const strong = sinePpg(30, 8, 72);
    const calWeak = computeDetectorCalibration(weak, 30, 25, 0.001);
    const calStrong = computeDetectorCalibration(strong, 30, 55, 0.006);
    expect(calWeak.elgendiMinProminence).toBeLessThan(calStrong.elgendiMinProminence);
  });

  it('offset weight se ajusta por calidad de señal', () => {
    const strong = sinePpg(30, 8, 72);
    const cal = computeDetectorCalibration(strong, 30, 55, 0.006);
    expect(cal.elgendiOffsetWeight).toBeGreaterThan(0.1);
    expect(cal.elgendiOffsetWeight).toBeLessThan(0.4);
    expect(cal.signalDynamicRange).toBeGreaterThan(0);
  });
});
