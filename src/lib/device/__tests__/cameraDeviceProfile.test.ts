import { describe, it, expect } from 'vitest';
import {
  inferCameraRuntimeHints,
  isMotorolaLikeUserAgent,
  isTclLikeUserAgent,
} from '../cameraDeviceProfile';
import { passesFingerMaintain } from '@/lib/finger/fingerSceneClassifier';

describe('cameraDeviceProfile', () => {
  it('TCL usa perfil estricto', () => {
    const h = inferCameraRuntimeHints({ userAgent: 'Mozilla TCL 6156' });
    expect(h.tclLike).toBe(true);
    expect(h.constrained).toBe(false);
    expect(h.fingerConfirmFrames).toBe(6);
  });

  it('Samsung/Motorola usan perfil tolerante por defecto', () => {
    const moto = inferCameraRuntimeHints({ userAgent: 'Motorola moto g84' });
    expect(moto.constrained).toBe(true);
    expect(moto.instantLostToUnstable).toBe(10);

    const sam = inferCameraRuntimeHints({ userAgent: 'Samsung SM-A546' });
    expect(sam.constrained).toBe(true);
    expect(sam.tclLike).toBe(false);
  });

  it('detecta Motorola en user agent', () => {
    expect(isMotorolaLikeUserAgent('Mozilla/5.0 Motorola moto g84')).toBe(true);
    expect(isTclLikeUserAgent('Mozilla/5.0 TCL')).toBe(true);
    expect(isTclLikeUserAgent('Mozilla/5.0 Samsung')).toBe(false);
  });

  it('marca tolerante extra con torch apagado o FPS bajo', () => {
    const h = inferCameraRuntimeHints({
      userAgent: 'Android Chrome',
      torchSupported: true,
      torchActive: false,
      fpsEffective: 16,
    });
    expect(h.constrained).toBe(true);
    expect(h.liveFingerMissGrace).toBeGreaterThanOrEqual(40);
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
