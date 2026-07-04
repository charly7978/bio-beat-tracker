import { describe, it, expect } from 'vitest';
import {
  computeContactScore,
  contactHintText,
  CONTACT_ACQUIRE_THRESHOLD,
  CONTACT_WARM_THRESHOLD,
} from '../fingerContactScore';

describe('computeContactScore', () => {
  it('scores a finger over the lens (deep uniform red) above the acquire threshold', () => {
    const s = computeContactScore({
      red: 180,
      green: 55,
      blue: 40,
      coverage: 0.9,
      redUniformity: 0.9,
    });
    expect(s.score).toBeGreaterThan(CONTACT_ACQUIRE_THRESHOLD);
    expect(s.hint).toBe('hold');
  });

  it('scores an ordinary bright scene (no red dominance, heterogeneous) well below warm', () => {
    const s = computeContactScore({
      red: 120,
      green: 130,
      blue: 140,
      coverage: 0.1,
      redUniformity: 0.15,
    });
    expect(s.score).toBeLessThan(CONTACT_WARM_THRESHOLD);
    expect(s.hint).toBe('searching');
  });

  it('flags excessive pressure / direct flash saturation', () => {
    const s = computeContactScore({
      red: 250,
      green: 235,
      blue: 230,
      coverage: 0.95,
      redUniformity: 0.9,
    });
    expect(s.hint).toBe('press-less');
  });

  it('gives a directional hint when finger is present but only partially covering', () => {
    const s = computeContactScore({
      red: 95,
      green: 70,
      blue: 62,
      coverage: 0.35,
      redUniformity: 0.35,
      coverageBias: { x: 0.6, y: 0.1 },
    });
    expect(s.score).toBeGreaterThan(CONTACT_WARM_THRESHOLD);
    expect(s.score).toBeLessThan(CONTACT_ACQUIRE_THRESHOLD);
    expect(['move-right', 'move-left', 'move-up', 'move-down']).toContain(s.hint);
    expect(s.hint).toBe('move-right');
  });

  it('is robust to white-balance shift where strict R/G would fail but red still dominates', () => {
    // Warm-tinted camera: green elevated, but red still clearly dominant + uniform.
    const s = computeContactScore({
      red: 165,
      green: 90,
      blue: 55,
      coverage: 0.85,
      redUniformity: 0.82,
    });
    expect(s.score).toBeGreaterThan(CONTACT_ACQUIRE_THRESHOLD);
  });

  it('maps every hint kind to some human text (or empty for none)', () => {
    expect(contactHintText('searching')).toMatch(/lente/i);
    expect(contactHintText('press-less')).toMatch(/suave/i);
    expect(contactHintText('none')).toBe('');
  });
});
