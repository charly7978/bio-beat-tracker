import { describe, it, expect } from 'vitest';
import {
  isOpenFlashWithoutContact,
  isExposureFlickerNotFingerPulse,
  isFingerOnLensScene,
  passesLiveFingerContact,
  passesFingerAcquire,
  passesPulsatileAcquire,
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

  describe('passesPulsatileAcquire (adquisición universal por pulso)', () => {
    // Dedo de COLOR DÉBIL (rb≈1.11 < estricto 1.15/1.2) en otra cámara: la firma
    // de color lo RECHAZA, pero pulsa → la vía pulsátil lo ACEPTA (universalidad).
    const weakRaw = { red: 120, green: 110, blue: 108, coverage: 0.16, fingerScore: 0.22 };
    const weakSmooth = { red: 118, green: 108, blue: 106, coverage: 0.15, fingerScore: 0.2 };

    it('dedo de color débil PERO con pulso → acepta (donde el color falla)', () => {
      expect(passesLiveFingerContact(weakRaw, weakSmooth, spatialFinger)).toBe(false); // color falla
      expect(passesPulsatileAcquire(weakRaw, weakSmooth, spatialFinger, 0.05)).toBe(true); // pulso lo salva
    });

    it('sin pulsación (CV bajo) → rechaza aunque el color sea bueno', () => {
      expect(passesPulsatileAcquire(fingerRaw, fingerSmooth, spatialFinger, 0.01)).toBe(false);
    });

    it('flicker de AE whitish (CV alto, poco rojo) → rechaza', () => {
      const whitish = { red: 160, green: 150, blue: 156, coverage: 0.2, fingerScore: 0.3 };
      expect(passesPulsatileAcquire(whitish, whitish, spatialFinger, 0.06)).toBe(false);
    });
  });
});
