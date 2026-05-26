import { describe, expect, it } from 'vitest';
import {
  createMeasurementSessionLatch,
  isMeasurementPipelineLive,
  SESSION_LATCH,
  updateMeasurementSessionLatch,
} from '../measurementSessionLatch';

describe('measurementSessionLatch', () => {
  it('establece sesión solo con picos reales consecutivos', () => {
    let latch = createMeasurementSessionLatch();
    for (let i = 0; i < SESSION_LATCH.ESTABLISH_STREAK; i++) {
      latch = updateMeasurementSessionLatch(latch, true, 72, 8, 100 + i * 800, true);
    }
    expect(latch.established).toBe(true);
    expect(latch.lastPeakMs).toBeGreaterThan(0);
  });

  it('no pierde racha entre frames sin pico (30 fps entre latidos)', () => {
    let latch = createMeasurementSessionLatch();
    let t = 1000;
    for (let p = 0; p < SESSION_LATCH.ESTABLISH_STREAK; p++) {
      latch = updateMeasurementSessionLatch(latch, true, 72, 10, t, true);
      for (let f = 0; f < 24; f++) {
        t += 33;
        latch = updateMeasurementSessionLatch(latch, true, 72, 10, t, false);
      }
      t += 800;
    }
    expect(latch.established).toBe(true);
    expect(latch.goodStreak).toBeGreaterThanOrEqual(SESSION_LATCH.ESTABLISH_STREAK);
  });

  it('no mantiene pipeline sin picos recientes', () => {
    let latch = createMeasurementSessionLatch();
    for (let i = 0; i < SESSION_LATCH.ESTABLISH_STREAK; i++) {
      latch = updateMeasurementSessionLatch(latch, true, 72, 8, 1000 + i * 800, true);
    }
    const stale = 1000 + SESSION_LATCH.ESTABLISH_STREAK * 800 + SESSION_LATCH.MAX_PEAK_GAP_MS + 1;
    expect(isMeasurementPipelineLive(latch, true, 8, stale)).toBe(false);
  });

  it('gracia de contacto breve con picos recientes', () => {
    let latch = createMeasurementSessionLatch();
    for (let i = 0; i < SESSION_LATCH.ESTABLISH_STREAK; i++) {
      latch = updateMeasurementSessionLatch(latch, true, 68, 7, 2000 + i * 800, true);
    }
    const lostAt = 2000 + SESSION_LATCH.ESTABLISH_STREAK * 800;
    latch = updateMeasurementSessionLatch(latch, false, 0, 0, lostAt, false);
    expect(
      isMeasurementPipelineLive(latch, false, SESSION_LATCH.MIN_SQI, lostAt + 500),
    ).toBe(true);
    expect(
      isMeasurementPipelineLive(
        latch,
        false,
        SESSION_LATCH.MIN_SQI,
        lostAt + SESSION_LATCH.CONTACT_GRACE_MS + 1,
      ),
    ).toBe(false);
  });
});
