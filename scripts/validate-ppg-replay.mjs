#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const sessionsDir = join(root, 'validation', 'sessions');
const reportsDir = join(root, 'validation', 'reports');

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function absErrors(samples, key) {
  return samples
    .filter((s) => Number.isFinite(s?.estimate?.[key]) && Number.isFinite(s?.reference?.[key]))
    .map((s) => Math.abs(s.estimate[key] - s.reference[key]));
}

function percent(value) {
  return value == null ? null : Number((value * 100).toFixed(2));
}

function summarizeSession(fileName, session) {
  const samples = Array.isArray(session.samples) ? session.samples : [];
  const validSamples = samples.filter((s) => s?.status === 'VALID' || s?.valid === true);
  const hrErrors = absErrors(samples, 'heartRate');
  const spo2Errors = absErrors(samples, 'spo2');
  const sbpErrors = absErrors(samples, 'systolic');
  const dbpErrors = absErrors(samples, 'diastolic');
  const firstValid = samples.find((s) => s?.status === 'VALID' || s?.valid === true);

  return {
    fileName,
    sessionId: session.sessionId ?? fileName.replace(/\.json$/i, ''),
    deviceProfileId: session.deviceProfileId ?? null,
    sampleCount: samples.length,
    validCoveragePct: percent(samples.length ? validSamples.length / samples.length : null),
    timeToFirstValidMs: Number.isFinite(firstValid?.timestampMs) ? firstValid.timestampMs : null,
    heartRateMae: mean(hrErrors),
    spo2Mae: mean(spo2Errors),
    systolicMae: mean(sbpErrors),
    diastolicMae: mean(dbpErrors),
    hrPairs: hrErrors.length,
    spo2Pairs: spo2Errors.length,
    bpPairs: Math.min(sbpErrors.length, dbpErrors.length),
  };
}

if (!existsSync(sessionsDir)) {
  mkdirSync(sessionsDir, { recursive: true });
}
if (!existsSync(reportsDir)) {
  mkdirSync(reportsDir, { recursive: true });
}

const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
const report = {
  generatedAt: new Date().toISOString(),
  sessionCount: files.length,
  sessions: [],
};

for (const file of files) {
  try {
    const session = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8'));
    report.sessions.push(summarizeSession(file, session));
  } catch (err) {
    report.sessions.push({ fileName: file, error: err instanceof Error ? err.message : String(err) });
  }
}

writeFileSync(join(reportsDir, 'ppg-replay-summary.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Validated ${files.length} recorded session(s). Report: validation/reports/ppg-replay-summary.json`);
