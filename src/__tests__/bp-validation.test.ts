/**
 * Validación ciega: app PPG vs tensiómetro de referencia
 *
 * Protocolo (IEEE / AAMI):
 *   1. Meditar 5 min sentado, brazo apoyado
 *   2. Tomar app PPG (30s con presión constante del dedo)
 *   3. Inmediatamente después, tomar tensiómetro braquial en el mismo brazo
 *   4. Repetir 3× (ideal 5×), esperar 1 min entre cada par
 *   5. Comparar SBP y DBP: MAE < 5 mmHg, RMSE < 8 mmHg (estándar AAMI)
 *
 * USO:
 *   - Editar REF_READINGS abajo con los valores reales del tensiómetro
 *   - La app registra automáticamente los valores PPG en cada medición
 *   - Ejecutar: npx vitest run src/__tests__/bp-validation.test.ts --reporter=verbose
 */
import { describe, expect, it } from 'vitest';

// ────────────────────────── CONFIG ──────────────────────────
// Reemplazar con las tomas reales (app vs tensiómetro)

const REF_READINGS: { sbp: number; dbp: number }[] = [
  // Cada entrada: { sbp: tensiómetro_SBP, dbp: tensiómetro_DBP }
  { sbp: 120, dbp: 80 },
  { sbp: 118, dbp: 79 },
  { sbp: 122, dbp: 81 },
];

const APP_READINGS: { sbp: number; dbp: number }[] = [
  // Cada entrada: { sbp: app_SBP, dbp: app_DBP }
  // ← EDITAR AQUÍ con los valores que muestra la app
  { sbp: 120, dbp: 80 },
  { sbp: 118, dbp: 79 },
  { sbp: 122, dbp: 81 },
];
// ────────────────────────────────────────────────────────────

function mae<T extends keyof typeof REF_READINGS[0]>(
  field: T,
): number {
  let sum = 0;
  for (let i = 0; i < Math.min(REF_READINGS.length, APP_READINGS.length); i++) {
    sum += Math.abs(APP_READINGS[i][field] - REF_READINGS[i][field]);
  }
  return sum / Math.min(REF_READINGS.length, APP_READINGS.length);
}

function rmse<T extends keyof typeof REF_READINGS[0]>(
  field: T,
): number {
  let sumSq = 0;
  const n = Math.min(REF_READINGS.length, APP_READINGS.length);
  for (let i = 0; i < n; i++) {
    const d = APP_READINGS[i][field] - REF_READINGS[i][field];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

function bias<T extends keyof typeof REF_READINGS[0]>(
  field: T,
): number {
  let sum = 0;
  const n = Math.min(REF_READINGS.length, APP_READINGS.length);
  for (let i = 0; i < n; i++) {
    sum += APP_READINGS[i][field] - REF_READINGS[i][field];
  }
  return sum / n;
}

function maxError<T extends keyof typeof REF_READINGS[0]>(
  field: T,
): number {
  let max = 0;
  for (let i = 0; i < Math.min(REF_READINGS.length, APP_READINGS.length); i++) {
    const e = Math.abs(APP_READINGS[i][field] - REF_READINGS[i][field]);
    if (e > max) max = e;
  }
  return max;
}

describe('Validación PA app vs tensiómetro', () => {
  const n = Math.min(REF_READINGS.length, APP_READINGS.length);

  it(`tiene ${n} pares de lecturas`, () => {
    expect(REF_READINGS.length).toBe(APP_READINGS.length);
    expect(REF_READINGS.length).toBeGreaterThanOrEqual(3);
  });

  describe('SBP (sistólica)', () => {
    const sbpMAE = mae('sbp');
    const sbpRMSE = rmse('sbp');
    const sbpBias = bias('sbp');
    const sbpMax = maxError('sbp');

    it(`MAE: ${sbpMAE.toFixed(2)} mmHg (AAMI ≤ 5 mmHg)`, () => {
      expect(sbpMAE).toBeLessThanOrEqual(5);
    });
    it(`RMSE: ${sbpRMSE.toFixed(2)} mmHg (AAMI ≤ 8 mmHg)`, () => {
      expect(sbpRMSE).toBeLessThanOrEqual(8);
    });
    it(`Bias: ${sbpBias.toFixed(2)} mmHg (AAMI ±5 mmHg)`, () => {
      expect(Math.abs(sbpBias)).toBeLessThanOrEqual(5);
    });
    it(`Error máximo: ${sbpMax} mmHg`, () => {
      expect(sbpMax).toBeLessThanOrEqual(10);
    });
  });

  describe('DBP (diastólica)', () => {
    const dbpMAE = mae('dbp');
    const dbpRMSE = rmse('dbp');
    const dbpBias = bias('dbp');
    const dbpMax = maxError('dbp');

    it(`MAE: ${dbpMAE.toFixed(2)} mmHg (AAMI ≤ 5 mmHg)`, () => {
      expect(dbpMAE).toBeLessThanOrEqual(5);
    });
    it(`RMSE: ${dbpRMSE.toFixed(2)} mmHg (AAMI ≤ 8 mmHg)`, () => {
      expect(dbpRMSE).toBeLessThanOrEqual(8);
    });
    it(`Bias: ${dbpBias.toFixed(2)} mmHg (AAMI ±5 mmHg)`, () => {
      expect(Math.abs(dbpBias)).toBeLessThanOrEqual(5);
    });
    it(`Error máximo: ${dbpMax} mmHg`, () => {
      expect(dbpMax).toBeLessThanOrEqual(10);
    });
  });
});
