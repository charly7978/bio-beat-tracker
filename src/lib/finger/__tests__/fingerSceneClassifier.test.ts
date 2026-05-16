import { describe, it, expect } from 'vitest';
import {
  isOpenFlashWithoutContact,
  isExposureFlickerNotFingerPulse,
  isFingerOnLensScene,
} from '../fingerSceneClassifier';

describe('fingerSceneClassifier', () => {
  it('rechaza flash abierto sin dedo', () => {
    expect(
      isOpenFlashWithoutContact({
        red: 200,
        green: 170,
        blue: 155,
        coverage: 0.25,
        fingerScore: 0.35,
      }),
    ).toBe(true);
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
    expect(
      isFingerOnLensScene(
        { red: 140, green: 75, blue: 58, coverage: 0.15, fingerScore: 0.22 },
        0.16,
        0.22,
      ),
    ).toBe(true);
  });
});
