import { describe, it, expect } from 'vitest';
import {
  computeFingerEnsemble,
  hasFingerHemoglobinSignature,
  isFingerPresentByEnsemble,
} from '../fingerContactSignature';
import { isFingerOnLensScene, passesLiveFingerContact } from '../fingerSceneClassifier';

describe('Inanimate Surface Rejection (BSO-MSCG)', () => {
  it('rechaza pared roja / tela roja inanimada (alto azul reflejado o sin firma subcutánea)', () => {
    const redShirtOrWall = {
      red: 180,
      green: 50,
      blue: 65, // blueFraction = 65 / 295 = 0.22, rb = 2.76
      coverage: 0.85,
      fingerScore: 0.40,
    };
    const grayPixels = new Uint8ClampedArray(100).fill(120); // imagen uniforme
    const ensemble = computeFingerEnsemble(redShirtOrWall, grayPixels, 0.005);
    
    // No debe clasificar la tela/pared roja como dedo
    expect(isFingerPresentByEnsemble(ensemble)).toBe(false);
  });

  it('rechaza ambiente cálido / luz de habitación sin transiluminación', () => {
    const warmRoomLight = {
      red: 160,
      green: 130,
      blue: 110, // blueFraction = 0.275
      coverage: 0.90,
      fingerScore: 0.35,
    };
    const ensemble = computeFingerEnsemble(warmRoomLight, null, 0.002);
    expect(isFingerPresentByEnsemble(ensemble)).toBe(false);
    expect(hasFingerHemoglobinSignature(warmRoomLight)).toBe(false);
  });

  it('acepta transiluminación tisular real con LED torch flash', () => {
    const realFingerTorch = {
      red: 215,
      green: 55,
      blue: 22, // blueFraction = 22 / 292 = 0.075 (7.5%), rb = 9.77
      coverage: 0.88,
      fingerScore: 0.42,
    };
    const grayPixels = new Uint8ClampedArray(100);
    for (let i = 0; i < 100; i++) grayPixels[i] = 70 + (i % 25);

    const ensemble = computeFingerEnsemble(realFingerTorch, grayPixels, 0.008);
    expect(isFingerPresentByEnsemble(ensemble)).toBe(true);
    expect(hasFingerHemoglobinSignature(realFingerTorch)).toBe(true);

    const spatial = { coverageRatio: 0.88, fingerScore: 0.42, fingerTileCount: 20 };
    expect(passesLiveFingerContact(realFingerTorch, realFingerTorch, spatial, ensemble.ensembleScore)).toBe(true);
  });
});
