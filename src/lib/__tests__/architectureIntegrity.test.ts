import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ElgendiPeakDetector } from '@/modules/signal-processing/detectors/ElgendiPeakDetector';
import { PanTompkinsPPGDetector } from '@/modules/signal-processing/detectors/PanTompkinsPPGDetector';
import { PeakDetectionEnsemble } from '@/modules/signal-processing/detectors/PeakDetectionEnsemble';
import { SignalQualityIndex } from '@/modules/signal-quality/SignalQualityIndex';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

const ROOT = join(process.cwd());

describe('architecture integrity', () => {
  it('expone detectores canónicos únicos', () => {
    expect(ElgendiPeakDetector).toBeDefined();
    expect(PanTompkinsPPGDetector).toBeDefined();
    expect(PeakDetectionEnsemble.analyze).toBeTypeOf('function');
  });

  it('enrichMetrics fusiona acuerdo de detectores en SQI', () => {
    const out = SignalQualityIndex.enrichMetrics(
      { sqi: 40, perfusionIndex: 0.02 },
      {
        elgendiConfidence: 0.9,
        panTompkinsConfidence: 0.85,
        agreement: { elgendi: 0.9, panTompkins: 0.85, spectral: 0.7 },
      },
    );
    expect(out.sqi).toBeGreaterThan(0);
    expect(out.detectorAgreement).toBeGreaterThan(0);
    expect(out.elgendiConfidence).toBe(0.9);
  });

  it('ensemble devuelve tiempos de picos para overlay', () => {
    const fs = 30;
    const n = 180;
    const signal: number[] = [];
    const timestampsMs: number[] = [];
    const bpm = 72;
    const period = (60_000 / bpm) / (1000 / fs);
    for (let i = 0; i < n; i++) {
      const t = i * (1000 / fs);
      timestampsMs.push(t);
      signal.push(Math.sin((2 * Math.PI * t) / period) * 0.5);
    }
    const res = PeakDetectionEnsemble.analyze({
      signal,
      timestampsMs,
      samplingRateHz: fs,
      sqi: 50,
    });
    const diag = res.diagnostics as {
      fusedPeakTimes?: number[];
      elgendiPeakTimes?: number[];
      panTompkinsPeakTimes?: number[];
    };
    expect(Array.isArray(diag.fusedPeakTimes)).toBe(true);
    expect(Array.isArray(diag.elgendiPeakTimes)).toBe(true);
    expect(Array.isArray(diag.panTompkinsPeakTimes)).toBe(true);
  });

  it('umbrales RR viven en vitalThresholds', () => {
    expect(VITAL_THRESHOLDS.HR.PHYSIOLOGICAL_RR_MIN_MS).toBe(270);
    const cfg = readFileSync(join(ROOT, 'src/config/vitalThresholds.ts'), 'utf8');
    expect(cfg).toContain('PHYSIOLOGICAL_RR_MIN_MS');
    expect(existsSync(join(ROOT, 'docs/ARCHITECTURE.md'))).toBe(true);
  });
});
