import { describe, expect, it } from 'vitest';
import {
  classifyFingerPlacement,
  placementHintText,
  passesUnifiedFingerAcquire,
} from '../fingerPlacementProfile';

const padSpatial = { coverageRatio: 0.22, fingerScore: 0.2, fingerTileCount: 5 };
const tipSpatial = { coverageRatio: 0.11, fingerScore: 0.18, fingerTileCount: 4 };

const fingerRaw = {
  red: 118,
  green: 52,
  blue: 42,
  coverage: 0.12,
  fingerScore: 0.22,
};

const fingerSmooth = {
  red: 112,
  green: 50,
  blue: 40,
  coverage: 0.11,
  fingerScore: 0.2,
};

describe('fingerPlacementProfile', () => {
  it('clasifica almohadilla vs punta', () => {
    expect(
      classifyFingerPlacement({ coverageRatio: 0.21, roiRedCv: 0.03, perfusionIndex: 0.001 }),
    ).toBe('pad');
    expect(
      classifyFingerPlacement({ coverageRatio: 0.11, roiRedCv: 0.05, perfusionIndex: 0.0005 }),
    ).toBe('tip');
    expect(
      classifyFingerPlacement({ coverageRatio: 0.15, roiRedCv: 0.025, perfusionIndex: 0.0002 }),
    ).toBe('hybrid');
  });

  it('acepta adquisición en modo pad con maintain', () => {
    expect(
      passesUnifiedFingerAcquire(fingerRaw, fingerSmooth, padSpatial, 0.03, 0.001),
    ).toBe(true);
  });

  it('acepta adquisición en modo tip con live contact', () => {
    expect(
      passesUnifiedFingerAcquire(fingerRaw, fingerSmooth, tipSpatial, 0.05, 0.0006),
    ).toBe(true);
  });

  it('genera texto de guía por modo', () => {
    expect(placementHintText('hybrid')).toMatch(/yema/i);
    expect(placementHintText('tip')).toMatch(/punta/i);
  });
});
