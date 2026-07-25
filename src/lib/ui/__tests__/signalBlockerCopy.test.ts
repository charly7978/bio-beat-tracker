import { describe, expect, it } from 'vitest';
import { describeSignalBlocker } from '../ppgCanvasRenderer';

describe('describeSignalBlocker (coach de colocación)', () => {
  it('traduce los bloqueos a una acción concreta, sin códigos crudos', () => {
    const codes = [
      'MOTION_ARTIFACT',
      'SATURATED',
      'UNDEREXPOSED',
      'LOW_FPS',
      'TORCH_UNAVAILABLE',
      'LOW_SIGNAL_QUALITY',
      'NO_FINGER',
    ];
    for (const code of codes) {
      const text = describeSignalBlocker(code);
      expect(text).not.toBe(code);
      expect(text).not.toMatch(/_/);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('el aviso de movimiento indica apoyar la mano', () => {
    expect(describeSignalBlocker('MOTION_ARTIFACT')).toMatch(/apoye la mano/i);
  });

  it('un código desconocido se muestra tal cual (no se inventa mensaje)', () => {
    expect(describeSignalBlocker('ALGO_NUEVO')).toBe('ALGO_NUEVO');
  });
});
