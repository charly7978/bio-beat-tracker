import { describe, expect, it } from 'vitest';
import { median, robustBounds, robustDynamicRange } from '../stats';

describe('stats', () => {
  it('median de ventana impar/par', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('robustDynamicRange positivo', () => {
    expect(robustDynamicRange([1, 2, 3, 4, 5])).toBeGreaterThan(0);
    const b = robustBounds([10, 20, 30]);
    expect(b.range).toBeGreaterThan(0);
  });
});
