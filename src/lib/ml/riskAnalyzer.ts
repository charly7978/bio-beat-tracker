import type { VitalSignsResult } from '../../modules/vital-signs/VitalSignsProcessor';

export interface HealthRiskScore {
  overall: number;
  categories: {
    cardiovascular: number;
    respiratory: number;
    arrhythmia: number;
    hypertension: number;
    hypoxia: number;
  };
  flags: string[];
  recommendations: string[];
  timeline: 'IMMEDIATE' | 'SOON' | 'MONITOR' | 'NORMAL';
}

interface RiskWeights {
  base: number;
  age: number;
  bmi: number;
  smoking: number;
  diabetes: number;
  familyHistory: number;
}

export class HealthRiskAnalyzer {
  private readonly REFERENCE_BP_SYS = 120;
  private readonly REFERENCE_BP_DIA = 80;
  private readonly REFERENCE_SPO2 = 98;
  private readonly REFERENCE_HR = 72;

  analyze(
    vitals: VitalSignsResult,
    profile?: Partial<RiskWeights>,
    age?: number,
  ): HealthRiskScore {
    const hr = vitals.heartRate.value ?? 72;
    const spo2 = vitals.spo2.value ?? 98;
    const sys = vitals.bloodPressure.value?.systolic ?? 120;
    const dia = vitals.bloodPressure.value?.diastolic ?? 80;
    const arrhythmiaScore = vitals.arrhythmia.value?.score ?? 0;

    const cv = this.scoreCardiovascular(hr, sys, dia, profile, age);
    const resp = this.scoreRespiratory(spo2);
    const arr = this.scoreArrhythmia(arrhythmiaScore);
    const htn = this.scoreHypertension(sys, dia);
    const hyp = this.scoreHypoxia(spo2, hr);

    const categories = {
      cardiovascular: cv,
      respiratory: resp,
      arrhythmia: arr,
      hypertension: htn,
      hypoxia: hyp,
    };

    const weights = { cardiovascular: 0.30, respiratory: 0.15, arrhythmia: 0.20, hypertension: 0.20, hypoxia: 0.15 };
    const overall = Object.entries(categories).reduce(
      (sum, [k, v]) => sum + v * weights[k as keyof typeof weights], 0,
    );

    const flags = this.generateFlags(categories, vitals);
    const timeline = this.determineTimeline(overall, flags);

    return {
      overall: Math.round(overall * 100) / 100,
      categories,
      flags,
      recommendations: this.generateRecommendations(categories, flags),
      timeline,
    };
  }

  private scoreCardiovascular(
    hr: number, sys: number, dia: number,
    profile?: Partial<RiskWeights>, _age?: number,
  ): number {
    let score = 0;
    score += Math.min(1, Math.abs(hr - 72) / 120) * 0.3;
    score += Math.min(1, Math.abs(sys - 120) / 160) * 0.3;
    score += Math.min(1, Math.abs(dia - 80) / 80) * 0.2;
    if (profile?.age) score += Math.min(1, (profile.age - 40) / 60) * 0.1;
    if (profile?.smoking) score += 0.1;
    if (profile?.diabetes) score += 0.1;
    if (profile?.familyHistory) score += 0.05;
    return Math.min(1, Math.max(0, score));
  }

  private scoreRespiratory(spo2: number): number {
    if (spo2 >= 97) return 0;
    if (spo2 >= 95) return 0.2;
    if (spo2 >= 92) return 0.5;
    if (spo2 >= 88) return 0.75;
    return 1;
  }

  private scoreArrhythmia(score: number): number {
    return Math.min(1, Math.max(0, score));
  }

  private scoreHypertension(sys: number, dia: number): number {
    const sysScore = Math.min(1, Math.max(0, (sys - 120) / 160));
    const diaScore = Math.min(1, Math.max(0, (dia - 80) / 80));
    return sysScore * 0.6 + diaScore * 0.4;
  }

  private scoreHypoxia(spo2: number, hr: number): number {
    const spo2Risk = Math.min(1, Math.max(0, (98 - spo2) / 15));
    const hrRisk = hr > 100 ? Math.min(1, (hr - 100) / 80) : 0;
    return spo2Risk * 0.7 + hrRisk * 0.3;
  }

  private generateFlags(
    categories: HealthRiskScore['categories'],
    vitals: VitalSignsResult,
  ): string[] {
    const flags: string[] = [];
    const hr = vitals.heartRate.value ?? 0;
    const spo2 = vitals.spo2.value ?? 100;
    const sys = vitals.bloodPressure.value?.systolic ?? 0;
    const dia = vitals.bloodPressure.value?.diastolic ?? 0;

    if (categories.hypertension > 0.7) flags.push('HIPERTENSION_SEVERA');
    else if (categories.hypertension > 0.4) flags.push('HIPERTENSION_MODERADA');
    if (categories.hypoxia > 0.7) flags.push('HIPOXIA_SEVERA');
    else if (categories.hypoxia > 0.4) flags.push('HIPOXIA_MODERADA');
    if (categories.arrhythmia > 0.7) flags.push('ARRITMIA_SEVERA');
    if (categories.arrhythmia > 0.4 && categories.arrhythmia <= 0.7) flags.push('ARRITMIA_MODERADA');
    if (categories.cardiovascular > 0.6) flags.push('RIESGO_CARDIOVASCULAR_ELEVADO');
    if (hr > 100) flags.push('TAQUICARDIA');
    if (hr < 50) flags.push('BRADICARDIA');
    if (sys >= 180 || dia >= 120) flags.push('CRISIS_HIPERTENSIVA');
    if (spo2 < 90) flags.push('DESATURACION_CRITICA');

    return flags;
  }

  private determineTimeline(
    overall: number,
    flags: string[],
  ): HealthRiskScore['timeline'] {
    if (overall > 0.7 || flags.some(f =>
      ['CRISIS_HIPERTENSIVA', 'DESATURACION_CRITICA', 'HIPOXIA_SEVERA',
       'HIPERTENSION_SEVERA', 'ARRITMIA_SEVERA'].includes(f),
    )) return 'IMMEDIATE';
    if (overall > 0.5 || flags.some(f =>
      ['HIPERTENSION_MODERADA', 'HIPOXIA_MODERADA', 'ARRITMIA_MODERADA',
       'RIESGO_CARDIOVASCULAR_ELEVADO'].includes(f),
    )) return 'SOON';
    if (overall > 0.2) return 'MONITOR';
    return 'NORMAL';
  }

  private generateRecommendations(
    categories: HealthRiskScore['categories'],
    flags: string[],
  ): string[] {
    const recs: string[] = [];
    if (flags.includes('CRISIS_HIPERTENSIVA')) {
      recs.push('Busque atención médica de URGENCIA inmediatamente');
    }
    if (flags.includes('DESATURACION_CRITICA')) {
      recs.push('Administre oxígeno si está disponible. Acuda a emergencias');
    }
    if (flags.includes('HIPERTENSION_SEVERA') || flags.includes('HIPERTENSION_MODERADA')) {
      recs.push('Monitore su presión arterial diariamente. Consulte a su médico para ajustar medicación');
    }
    if (flags.includes('HIPOXIA_MODERADA')) {
      recs.push('Realice ejercicios de respiración profunda. Consulte a su médico si empeora');
    }
    if (flags.includes('ARRITMIA_SEVERA') || flags.includes('ARRITMIA_MODERADA')) {
      recs.push('Evite cafeína y alcohol. Realice un ECG de confirmación con su médico');
    }
    if (flags.includes('TAQUICARDIA')) {
      recs.push('Descanse y evite esfuerzos. Si persiste, consulte a su médico');
    }
    if (flags.includes('BRADICARDIA')) {
      recs.push('Si presenta mareos o desmayos, acuda a emergencias');
    }
    if (categories.hypoxia > 0.2 && categories.hypoxia <= 0.4) {
      recs.push('Manténgase hidratado. Ventile bien el área donde se encuentra');
    }
    if (flags.length === 0) {
      recs.push('Sus signos vitales se encuentran dentro de parámetros normales');
      recs.push('Mantenga una dieta equilibrada y ejercicio regular');
    }
    return recs;
  }
}

export const healthRiskAnalyzer = new HealthRiskAnalyzer();
