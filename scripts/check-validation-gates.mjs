#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const reportPath = join(root, 'validation', 'reports', 'ppg-replay-summary.json');
const gatesPath = join(root, 'validation', 'quality-gates.json');

if (!existsSync(reportPath)) {
  console.error('Missing validation report. Run npm run validate:ppg:replay first.');
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const gates = JSON.parse(readFileSync(gatesPath, 'utf8'));
const failures = [];

for (const s of report.sessions ?? []) {
  if (typeof s.validCoveragePct === 'number' && s.validCoveragePct < gates.validCoveragePctMin) failures.push(`${s.sessionId}: low coverage`);
  if (typeof s.timeToFirstValidMs === 'number' && s.timeToFirstValidMs > gates.timeToFirstValidMsMax) failures.push(`${s.sessionId}: slow first valid`);
  if (typeof s.heartRateMae === 'number' && s.heartRateMae > gates.heartRateMaeBpmMax) failures.push(`${s.sessionId}: HR MAE high`);
  if (typeof s.spo2Mae === 'number' && s.spo2Mae > gates.spo2MaePctMax) failures.push(`${s.sessionId}: SpO2 MAE high`);
  if (typeof s.systolicMae === 'number' && s.systolicMae > gates.systolicMaeMmHgMax) failures.push(`${s.sessionId}: SBP MAE high`);
  if (typeof s.diastolicMae === 'number' && s.diastolicMae > gates.diastolicMaeMmHgMax) failures.push(`${s.sessionId}: DBP MAE high`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Validation quality gates passed.');
