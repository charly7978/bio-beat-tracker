import { describe, expect, it } from 'vitest';
import {
  createMeasurementSessionLatch,
  isMeasurementPipelineLive,
  SESSION_LATCH,
  updateMeasurementSessionLatch,
} from '../measurementSessionLatch';

describe('measurementSessionLatch', () => {
  it('establece sesión tras racha de frames buenos', () => {
    let latch = createMeasurementSessionLatch();
    for (let i = 0; i < SESSION_LATCH.ESTABLISH_STREAK; i++) {
      latch = updateMeasurementSessionLatch(latch, true, 72, 8, i * 33);
    }
    expect(latch.established).toBe(true);
    expect(latch.lastBpm).toBe(72);
  });

  it('mantiene pipeline en gracia tras perder contacto breve', () => {
    let latch = createMeasurementSessionLatch();
    for (let i = 0; i < SESSION_LATCH.ESTABLISH_STREAK; i++) {
      latch = updateMeasurementSessionLatch(latch, true, 68, 7, 1000 + i * 33);
    }
    const lostAt = 2000;
    latch = updateMeasurementSessionLatch(latch, false, 0, 0, lostAt);
    expect(latch.established).toBe(true);
    expect(
      isMeasurementPipelineLive(latch, false, 3, lostAt + 1000),
    ).toBe(true);
    expect(
      isMeasurementPipelineLive(
        latch,
        false,
        3,
        lostAt + SESSION_LATCH.CONTACT_GRACE_MS + 1,
      ),
    ).toBe(false);
  });
});
