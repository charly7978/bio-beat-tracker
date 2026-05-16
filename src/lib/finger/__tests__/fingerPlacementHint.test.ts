import { describe, it, expect } from 'vitest';
import { getFingerPlacementHint } from '../fingerPlacementHint';

describe('getFingerPlacementHint', () => {
  it('pide cubrir el recuadro sin dedo', () => {
    const h = getFingerPlacementHint({
      fingerDetected: false,
      contactState: 'NO_CONTACT',
      coverageRatio: 0.02,
    });
    expect(h.toLowerCase()).toContain('recuadro');
  });

  it('pide quietud con dedo inestable', () => {
    const h = getFingerPlacementHint({
      fingerDetected: true,
      contactState: 'UNSTABLE_CONTACT',
      coverageRatio: 0.2,
    });
    expect(h.toLowerCase()).toMatch(/quieto|onda/);
  });
});
