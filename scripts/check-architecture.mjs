#!/usr/bin/env node
/**
 * Guardrail anti-duplicación arquitectónica (CI).
 * - Prohíbe procesadores/detectores paralelos por nombre.
 * - Exige módulos canónicos únicos (ensemble, umbrales, SQI).
 * - Detecta carpetas legacy prohibidas.
 * - Advierte si umbrales fisiológicos RR se repiten fuera de config.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

const BANNED_BASENAMES = [
  /ProcessorV2/i,
  /FinalProcessor/i,
  /AdvancedProcessor/i,
  /NewDetector/i,
  /HeartBeatProcessorV2/i,
  /PPGProcessorV2/i,
  /PeakDetectorV2/i,
];

const FORBIDDEN_PATHS = [
  'src/lib/ppg',
  'src/components/CameraPreview.tsx',
];

const REQUIRED_FILES = [
  'src/types/measurements.ts',
  'src/config/vitalThresholds.ts',
  'src/config/signalProcessing.ts',
  'src/modules/signal-processing/detectors/ElgendiPeakDetector.ts',
  'src/modules/signal-processing/detectors/PanTompkinsPPGDetector.ts',
  'src/modules/signal-processing/detectors/PeakDetectionEnsemble.ts',
  'src/modules/signal-processing/shared/dsp.ts',
  'src/modules/signal-quality/SignalQualityIndex.ts',
  'src/modules/HeartBeatProcessor.ts',
  'src/modules/signal-processing/PPGSignalProcessor.ts',
  'src/modules/vital-signs/CalibrationManager.ts',
];

const SINGLETON_EXPORTS = [
  { file: 'src/modules/signal-processing/detectors/ElgendiPeakDetector.ts', symbol: 'ElgendiPeakDetector' },
  { file: 'src/modules/signal-processing/detectors/PanTompkinsPPGDetector.ts', symbol: 'PanTompkinsPPGDetector' },
  { file: 'src/modules/signal-processing/detectors/PeakDetectionEnsemble.ts', symbol: 'PeakDetectionEnsemble' },
];

const EXTS = ['.ts', '.tsx'];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (EXTS.includes(extname(p))) acc.push(p);
  }
  return acc;
}

const errors = [];
const warnings = [];

for (const rel of FORBIDDEN_PATHS) {
  const abs = join(ROOT, rel);
  if (existsSync(abs)) errors.push(`FORBIDDEN_PATH  ${rel} (carpeta/módulo legacy duplicado)`);
}

for (const rel of REQUIRED_FILES) {
  if (!existsSync(join(ROOT, rel))) {
    errors.push(`MISSING_CANONICAL  ${rel}`);
  }
}

const files = walk(SRC);
const exportCounts = new Map();

for (const file of files) {
  const base = file.split(/[/\\]/).pop() ?? '';
  for (const re of BANNED_BASENAMES) {
    if (re.test(base)) errors.push(`BANNED_FILENAME  ${relative(ROOT, file)}`);
  }
}

for (const { file, symbol } of SINGLETON_EXPORTS) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8');
  if (!src.includes(`export class ${symbol}`) && !src.includes(`export const ${symbol}`)) {
    warnings.push(`SYMBOL_MISMATCH  ${file} no exporta ${symbol}`);
  }
  exportCounts.set(symbol, (exportCounts.get(symbol) ?? 0) + 1);
}

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  for (const { symbol } of SINGLETON_EXPORTS) {
    if (rel === SINGLETON_EXPORTS.find((s) => s.symbol === symbol)?.file) continue;
    if (new RegExp(`export class ${symbol}\\b`).test(src)) {
      errors.push(`DUPLICATE_EXPORT  ${symbol} en ${rel} (usar import del módulo canónico)`);
    }
  }
}

// Umbrales RR dispersos (solo config debe definir la pareja canónica)
const rrLiteral = /PHYSIOLOGICAL_RR_MIN_MS\s*[:=]\s*270/;
let rrDefCount = 0;
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (!rel.startsWith('src/')) continue;
  const src = readFileSync(file, 'utf8');
  if (rrLiteral.test(src)) {
    rrDefCount++;
    if (!rel.includes('vitalThresholds.ts')) {
      warnings.push(`RR_THRESHOLD_OUTSIDE_CONFIG  ${rel}`);
    }
  }
}

// Múltiples archivos *PeakDetector* fuera de detectors/
const extraDetectors = files.filter((f) => {
  const rel = relative(ROOT, f).replace(/\\/g, '/');
  return (
    /PeakDetector/i.test(f) &&
    !rel.includes('signal-processing/detectors/') &&
    !rel.includes('__tests__')
  );
});
for (const f of extraDetectors) {
  errors.push(`EXTRA_PEAK_DETECTOR  ${relative(ROOT, f)} (consolidar en detectors/)`);
}

if (warnings.length) {
  console.warn('⚠️  Architecture warnings:\n  ' + warnings.join('\n  '));
}

if (errors.length) {
  console.error('❌ Architecture guardrail failed:\n  ' + errors.join('\n  '));
  process.exit(1);
}

console.log(
  `✅ Architecture guardrail passed (${files.length} source files, ${REQUIRED_FILES.length} canonical modules).`,
);
