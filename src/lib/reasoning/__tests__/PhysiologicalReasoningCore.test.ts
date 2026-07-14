import { describe, expect, it } from 'vitest';
import {
  PhysiologicalReasoningCore,
  type PhysiologicalReasoningInput,
} from '../PhysiologicalReasoningCore';

const FS = 30;

function perfusedInput(i: number, bpm = 72): PhysiologicalReasoningInput {
  const t = i / FS;
  const f = bpm / 60;
  const pulse = Math.sin(2 * Math.PI * f * t) + 0.28 * Math.sin(4 * Math.PI * f * t + 0.2);
  return {
    timestampMs: i * (1000 / FS),
    rawRed: 178 + pulse * 4.2,
    rawGreen: 76 + pulse * 1.8,
    rawBlue: 55 + pulse * 1.1,
    coverageRatio: 0.24,
    perfusionIndex: 0.008,
    periodicity: 0.86,
    sqi: 82,
    pulseStrength: 0.78,
    filteredValue: pulse,
    morphologyValue: pulse * 0.9,
    motionScore: 0.05,
    signalMotionScore: 0.04,
    centroidMotion: 0.02,
    saturationRatio: 0,
    underexposureRatio: 0,
    spo2Channels: {
      acRed: 0.016,
      dcRed: 1,
      acGreen: 0.019,
      dcGreen: 1,
    },
  };
}

describe('PhysiologicalReasoningCore', () => {
  it('converge hacia tejido perfundido y aprende un perfil sin referencia externa', () => {
    const core = new PhysiologicalReasoningCore();
    let state = core.update(perfusedInput(0));
    for (let i = 1; i < 220; i++) state = core.update(perfusedInput(i));

    expect(state.beliefs.PERFUSED_HUMAN_TISSUE).toBeGreaterThan(0.45);
    expect(state.observability.heartRate).toBeGreaterThan(0.45);
    expect(core.exportProfile().acceptedSamples).toBeGreaterThan(10);
    expect(core.exportProfile().confidence).toBeGreaterThan(0.1);
  });

  it('prefiere movimiento cuando la escena oscila en modo común sin consistencia multicanal', () => {
    const core = new PhysiologicalReasoningCore();
    let state = core.update(perfusedInput(0));
    for (let i = 1; i < 80; i++) {
      const common = Math.sin(i * 0.7) * 22;
      state = core.update({
        ...perfusedInput(i),
        rawRed: 135 + common,
        rawGreen: 125 + common,
        rawBlue: 120 + common,
        coverageRatio: 0.08,
        perfusionIndex: 0.00012,
        periodicity: 0.18,
        sqi: 18,
        pulseStrength: 0.08,
        filteredValue: common * 0.08,
        morphologyValue: common * 0.08,
        motionScore: 0.92,
        signalMotionScore: 0.88,
        centroidMotion: 0.75,
        spo2Channels: {
          acRed: 0.001,
          dcRed: 1,
          acGreen: 0.00003,
          dcGreen: 1,
        },
      });
    }

    expect(state.beliefs.MOTION_DOMINATED_SCENE).toBeGreaterThan(state.beliefs.PERFUSED_HUMAN_TISSUE);
    expect(state.observability.heartRate).toBeLessThan(0.2);
  });

  it('reconoce energía residual cuando desaparece la fuente pero persiste el filtro', () => {
    const core = new PhysiologicalReasoningCore();
    for (let i = 0; i < 120; i++) core.update(perfusedInput(i));

    let state = core.update(perfusedInput(121));
    for (let i = 122; i < 145; i++) {
      state = core.update({
        ...perfusedInput(i),
        rawRed: 22,
        rawGreen: 21,
        rawBlue: 20,
        coverageRatio: 0,
        perfusionIndex: 0,
        periodicity: 0.05,
        sqi: 0,
        pulseStrength: 0,
        filteredValue: Math.exp(-(i - 122) / 12) * Math.sin(i),
        morphologyValue: Math.exp(-(i - 122) / 12) * Math.sin(i),
        underexposureRatio: 0.8,
        spo2Channels: undefined,
      });
    }

    expect(state.beliefs.FILTER_RESIDUAL_OR_RINGING).toBeGreaterThan(state.beliefs.PERFUSED_HUMAN_TISSUE);
    expect(state.observability.heartRate).toBeLessThan(0.15);
  });

  it('exporta e importa la memoria aprendida', () => {
    const first = new PhysiologicalReasoningCore();
    for (let i = 0; i < 180; i++) first.update(perfusedInput(i));
    const profile = first.exportProfile();

    const second = new PhysiologicalReasoningCore();
    expect(second.importProfile(profile)).toBe(true);
    expect(second.exportProfile().acceptedSamples).toBe(profile.acceptedSamples);
    expect(second.exportProfile().revision).toBe(profile.revision);
  });
});
