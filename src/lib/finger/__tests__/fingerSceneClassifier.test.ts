import { describe, it, expect } from 'vitest';
import {
  isOpenFlashWithoutContact,
  isExposureFlickerNotFingerPulse,
  isFingerOnLensScene,
  passesLiveFingerContact,
  passesFingerAcquire,
} from '../fingerSceneClassifier';

const flashOpen = {
  red: 200,
  green: 170,
  blue: 155,
  coverage: 0.2,
  fingerScore: 0.3,
};

const fingerRaw = {
  red: 140,
  green: 72,
  blue: 55,
  coverage: 0.16,
  fingerScore: 0.22,
};

const fingerSmooth = {
  red: 135,
  green: 70,
  blue: 54,
  coverage: 0.15,
  fingerScore: 0.2,
};

const spatialFinger = {
  coverageRatio: 0.16,
  fingerScore: 0.22,
  fingerTileCount: 5,
};

describe('fingerSceneClassifier', () => {
  it('rechaza flash abierto sin dedo', () => {
    expect(isOpenFlashWithoutContact(flashOpen)).toBe(true);
  });

  it('no confunde CV alto + R/B bajo con pulso de dedo', () => {
    expect(
      isExposureFlickerNotFingerPulse(
        0.05,
        { red: 160, green: 130, blue: 142, coverage: 0.2, fingerScore: 0.3 },
        1.2,
      ),
    ).toBe(true);
  });

  it('acepta escena dedo en lente', () => {
    expect(isFingerOnLensScene(fingerSmooth, 0.16, 0.22)).toBe(true);
  });

  it('passesLiveFingerContact rechaza flash', () => {
    expect(passesLiveFingerContact(flashOpen, flashOpen, spatialFinger)).toBe(false);
  });

  it('passesLiveFingerContact acepta dedo crudo+suavizado', () => {
    expect(passesLiveFingerContact(fingerRaw, fingerSmooth, spatialFinger)).toBe(true);
  });

  it('passesFingerAcquire exige R/B estricto en crudo', () => {
    expect(passesFingerAcquire(fingerRaw, fingerSmooth, spatialFinger)).toBe(true);
    const weakRb = { ...fingerRaw, blue: 120 };
    expect(passesFingerAcquire(weakRb, fingerSmooth, spatialFinger)).toBe(false);
  });
});
