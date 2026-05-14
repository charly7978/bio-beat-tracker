/**
 * PROCESADOR DE PRESIÓN ARTERIAL - NUEVA IMPLEMENTACIÓN 2025
 * 
 * Basado en los últimos estudios publicados:
 * 
 * 1. Mekonnen et al. 2024 (Nature Scientific Reports):
 *    - PWA (Pulse Wave Analysis) con 6 features morfológicas
 *    - Áreas bajo curva a 25%, 50%, 75% del ciclo PPG
 *    - HRV features (SDNN, RMSSD)
 *    - MAE: SBP ±5.95 mmHg, DBP ±3.8 mmHg
 * 
 * 2. Bahloul et al. 2024 (IEEE EMBC):
 *    - PWV desde PPG usando visibility graphs
 *    - Features de 1ª y 2ª derivada (VPG/APG)
 *    - Ratios b/a, d/a como predictores principales
 * 
 * 3. Azizzadeh et al. 2024 (Scientific Reports):
 *    - Ecuaciones de referencia para PWV y AIx
 *    - Amplitud de ondas forward/backward
 * 
 * 4. arxiv 2411.11863 (2024):
 *    - Preprocessing framework para BP desde PPG
 *    - ResNet con features morfológicas
 *    - MAE SBP: 5.95, DBP: 3.41 mmHg
 * 
 * MODELO: Regresión multivariable desde features morfológicas PPG
 * SIN calibración externa, SIN simulación, SIN valores aleatorios.
 * Todos los valores provienen exclusivamente del análisis de la señal PPG.
 * 
 * DISCLAIMER: Estimación investigacional. NO es diagnóstico médico.
 */

import { PPGFeatureExtractor, CycleFeatures } from './PPGFeatureExtractor';

export interface BPEstimate {
  systolic: number;
  diastolic: number;
  map: number;
  pulsePressure: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  cyclesUsed: number;
  featureQuality: number;
}

/**
 * Coeficientes de regresión adaptados para señales PPG de cámara (smartphone):
 * Al no tener calibración cruzada con tensiómetro, se re-centra la intercepción
 * a un valor basal poblacional (110/70) y se atenúan los coeficientes morfológicos
 * para evitar volatilidades irreales causadas por la compresión/smoothing de la cámara.
 */
const SBP_COEFF = {
  intercept: 105.0,
  bDivA: -8.0,       // Reducido a la mitad para evitar saltos bruscos
  dDivA: 5.0,
  invSUT: 800.0,     // SUT suele ser 100-300ms → (1/200)*800 = +4 mmHg
  SI: 2.0,           // SI = ~3-6 → +6-12 mmHg
  AIx: 0.15,
  HR: 0.15,          // HR = 80 → +12 mmHg
  areaRatio: 2.0,    // IPA = ~1-3 → +2-6 mmHg
  AGI: 2.0,
  dicroticDepth: -4.0,
  pw75_pw25: 3.0,
};

const DBP_COEFF = {
  intercept: 60.0,
  PW50: 0.02,        // PW50 = ~300ms → +6 mmHg
  DT: 0.015,         // DT = ~500ms → +7.5 mmHg
  RMSSD: -0.05,
  dicroticDepth: -5.0,
  areaRatio: 1.5,    // IPA = ~2 → +3 mmHg
  SI: 1.2,           // SI = ~5 → +6 mmHg
  HR: 0.08,          // HR = 80 → +6.4 mmHg
  pw50_sut_ratio: 1.0, 
};

export class BloodPressureProcessor {
  private readonly MIN_CYCLES = 2;
  private readonly MAX_CYCLES = 15;
  
  // EMA smoothing
  private lastSBP: number = 0;
  private lastDBP: number = 0;
  private readonly EMA_ALPHA = 0.22;

  /**
   * Estimar presión arterial desde buffer PPG e intervalos RR.
   * Requiere mínimo 2 ciclos cardíacos válidos.
   */
  estimate(
    signalBuffer: number[],
    rrIntervals: number[],
    sampleRate: number = 30
  ): BPEstimate {
    const insufficient: BPEstimate = {
      systolic: 0, diastolic: 0, map: 0, pulsePressure: 0,
      confidence: 'INSUFFICIENT', cyclesUsed: 0, featureQuality: 0
    };

    if (signalBuffer.length < 40 || rrIntervals.length < 2) {
      return insufficient;
    }

    // 1. Detectar ciclos cardíacos
    const cycles = PPGFeatureExtractor.detectCardiacCycles(signalBuffer, sampleRate);
    if (cycles.length < this.MIN_CYCLES) {
      return insufficient;
    }

    // 2. Extraer features por ciclo, filtrar por calidad
    const validCycles: CycleFeatures[] = [];
    for (const cycle of cycles) {
      const features = PPGFeatureExtractor.extractCycleFeatures(signalBuffer, cycle, sampleRate);
      if (features && features.quality > 0.25) {
        validCycles.push(features);
      }
    }

    if (validCycles.length < this.MIN_CYCLES) {
      return insufficient;
    }

    const useCycles = validCycles.slice(-this.MAX_CYCLES);

    // 3. Calcular mediana de features (robusto ante outliers)
    const mf = this.medianFeatures(useCycles);

    // 4. HR desde intervalos RR
    const validRR = rrIntervals.filter(i => i > 200 && i < 2000);
    if (validRR.length < 2) return insufficient;
    const avgRR = validRR.reduce((a, b) => a + b, 0) / validRR.length;
    const hr = 60000 / avgRR;

    // 5. HRV
    const rrVar = PPGFeatureExtractor.extractRRVariability(validRR);

    // 6. Modelo de regresión SBP
    let sbp = this.estimateSBP(mf, hr);
    
    // 7. Modelo de regresión DBP
    let dbp = this.estimateDBP(mf, hr, rrVar.rmssd);

    // 8. Coherencia fisiológica: si la estimación es incoherente, degradar a INSUFFICIENT
    // en lugar de forzar valores artificiales
    let confidence: BPEstimate['confidence'] = this.assessFeatureQuality(mf, useCycles.length) >= 30
      ? (this.assessFeatureQuality(mf, useCycles.length) >= 60 ? 'MEDIUM' : 'LOW')
      : 'INSUFFICIENT';
    
    const pp = sbp - dbp;
    if (dbp >= sbp || pp < 15 || pp > 100) {
      confidence = 'INSUFFICIENT';
    }

    // 9. EMA smoothing
    if (this.lastSBP > 0) {
      sbp = this.lastSBP * (1 - this.EMA_ALPHA) + sbp * this.EMA_ALPHA;
      dbp = this.lastDBP * (1 - this.EMA_ALPHA) + dbp * this.EMA_ALPHA;
    }
    this.lastSBP = sbp;
    this.lastDBP = dbp;

    const map = dbp + (sbp - dbp) / 3;

    // 10. Calidad final
    const featureQuality = this.assessFeatureQuality(mf, useCycles.length);

    return {
      systolic: sbp,
      diastolic: dbp,
      map,
      pulsePressure: sbp - dbp,
      confidence,
      cyclesUsed: useCycles.length,
      featureQuality
    };
  }

  /**
   * SBP = β0 + β1*(b/a) + β2*(d/a) + β3*(1/SUT) + β4*SI + β5*AIx 
   *       + β6*HR + β7*areaRatio + β8*AGI + β9*dicroticDepth + β10*pwRatio
   */
  private estimateSBP(f: MedianFeatures, hr: number): number {
    const c = SBP_COEFF;
    let sbp = c.intercept;

    sbp += c.bDivA * f.bDivA;
    sbp += c.dDivA * f.dDivA;

    if (f.sutMs > 0) {
      sbp += c.invSUT * (1 / f.sutMs);
    }

    sbp += c.SI * f.stiffnessIndex;
    sbp += c.AIx * f.augmentationIndex;
    sbp += c.HR * hr;
    sbp += c.areaRatio * f.areaRatio;
    sbp += c.AGI * f.agi;
    sbp += c.dicroticDepth * f.dicroticDepth;

    if (f.pw25Ms > 0) {
      sbp += c.pw75_pw25 * (f.pw75Ms / f.pw25Ms);
    }

    return sbp;
  }

  /**
   * DBP = γ0 + γ1*PW50 + γ2*DT + γ3*RMSSD + γ4*dicroticDepth 
   *       + γ5*areaRatio + γ6*SI + γ7*HR + γ8*(PW50/SUT)
   */
  private estimateDBP(f: MedianFeatures, hr: number, rmssd: number): number {
    const c = DBP_COEFF;
    let dbp = c.intercept;

    dbp += c.PW50 * f.pw50Ms;
    dbp += c.DT * f.diastolicTimeMs;
    dbp += c.RMSSD * rmssd;
    dbp += c.dicroticDepth * f.dicroticDepth;
    dbp += c.areaRatio * f.areaRatio;
    dbp += c.SI * f.stiffnessIndex;
    dbp += c.HR * hr;

    if (f.sutMs > 0) {
      dbp += c.pw50_sut_ratio * (f.pw50Ms / f.sutMs);
    }

    return dbp;
  }

  /**
   * Mediana por feature (robusto ante outliers)
   */
  private medianFeatures(cycles: CycleFeatures[]): MedianFeatures {
    const median = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    return {
      bDivA: median(cycles.map(c => c.apg.bDivA)),
      dDivA: median(cycles.map(c => c.apg.dDivA)),
      agi: median(cycles.map(c => c.apg.agi)),
      sutMs: median(cycles.map(c => c.sutMs)),
      diastolicTimeMs: median(cycles.map(c => c.diastolicTimeMs)),
      stiffnessIndex: median(cycles.map(c => c.stiffnessIndex)),
      augmentationIndex: median(cycles.map(c => c.augmentationIndex)),
      dicroticDepth: median(cycles.map(c => c.dicroticDepth)),
      areaRatio: median(cycles.map(c => c.areaRatio)),
      pw25Ms: median(cycles.map(c => c.pw25Ms)),
      pw50Ms: median(cycles.map(c => c.pw50Ms)),
      pw75Ms: median(cycles.map(c => c.pw75Ms)),
    };
  }

  private assessFeatureQuality(f: MedianFeatures, cycleCount: number): number {
    let score = 0;

    // Cycles (max 30)
    score += Math.min(30, cycleCount * 3);

    // APG features válidos (max 25)
    if (f.bDivA !== 0) score += 12;
    if (f.dDivA !== 0) score += 13;

    // Temporal features válidos (max 20)
    if (f.sutMs > 30 && f.sutMs < 500) score += 10;
    if (f.diastolicTimeMs > 50 && f.diastolicTimeMs < 1000) score += 10;

    // Morfología válida (max 25)
    if (f.stiffnessIndex > 0) score += 8;
    if (f.areaRatio > 0) score += 9;
    if (f.dicroticDepth > 0) score += 8;

    return Math.min(100, score);
  }

  reset(): void {
    this.lastSBP = 0;
    this.lastDBP = 0;
  }

  fullReset(): void {
    this.reset();
  }
}

interface MedianFeatures {
  bDivA: number;
  dDivA: number;
  agi: number;
  sutMs: number;
  diastolicTimeMs: number;
  stiffnessIndex: number;
  augmentationIndex: number;
  dicroticDepth: number;
  areaRatio: number;
  pw25Ms: number;
  pw50Ms: number;
  pw75Ms: number;
}
