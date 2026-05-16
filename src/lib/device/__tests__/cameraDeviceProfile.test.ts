import { describe, it, expect } from 'vitest';
import { inferCameraRuntimeHints, isMotorolaLikeUserAgent } from '../cameraDeviceProfile';
import { passesFingerMaintain } from '@/lib/finger/fingerSceneClassifier';

describe('cameraDeviceProfile', () => {
  it('detecta Motorola en user agent', () => {
    expect(isMotorolaLikeUserAgent('Mozilla/5.0 Motorola moto g84')).toBe(true);
    expect(isMotorolaLikeUserAgent('Mozilla/5.0 TCL')).toBe(false);
  });

  it('marca perfil tolerante sin torch confirmado', () => {
    const h = inferCameraRuntimeHints({
      userAgent: 'Android',
      torchSupported: true,
      torchActive: false,
      fpsEffective: 28,
    });
    expect(h.constrained).toBe(true);
    expect(h.minPiScale).toBeLessThan(0.28);
    expect(h.liveFingerMissGrace).toBeGreaterThan(6);
  });
});

describe('passesFingerMaintain', () => {
  it('acepta RGB moderado con cobertura mínima', () => {
    const ok = passesFingerMaintain(
      { red: 118, green: 52, blue: 42, coverage: 0.12, fingerScore: 0.2 },
      { red: 112, green: 50, blue: 40, coverage: 0.11, fingerScore: 0.18 },
      { coverageRatio: 0.11, fingerScore: 0.18, fingerTileCount: 4 },
    );
    expect(ok).toBe(true);
  });
});
