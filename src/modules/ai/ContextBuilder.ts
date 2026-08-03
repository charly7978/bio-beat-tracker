import { CardiacKnowledge } from '../signal-processing/reasoner/CardiacKnowledge';
import { SignalAnalyzer, type SignalFeatures } from '../signal-processing/reasoner/SignalAnalyzer';

export interface VitalContext {
  heartRate: number;
  rrIntervals: number[];
  signalQuality: number;
  perfusionIndex: number;
  motionScore: number;
  fingerContact: boolean;
  elapsedMs: number;
  peakCount: number;
  consecutivePeaks: number;
  features?: SignalFeatures;
}

const SYSTEM_PROMPT = `Eres el cerebro de control de una medición de signos vitales por PPG. NO solo diagnosticas — CONTROLAS la detección. Tu output JSON DEBE incluir "detectionParams" que ajustan cómo el sistema detecta latidos.

CONOCIMIENTO CARDIOLÓGICO:
- Ciclo cardíaco: sístole (200-400ms), diástole (400-800ms), inciso dicrótico en 50-75% diástole
- PPG: componente AC (1-10% DC) = cambios volumen sanguíneo cardíaco
- Beer-Lambert: verde 525nm, rojo 660nm, IR 940nm — SpO2 = 112 - 28×R
- Windkessel: R1 resistencia proximal, C complacencia, R2 resistencia distal
- Presión: MAP = CO × TPR; sistólica 100-130, diastólica 60-80 mmHg
- Arritmia: HRV > 20% o RMSSD > 120ms = irregular; bigeminio = acoplamiento corto + pausa ≈ 2× basal
- Respiración: 12-20 rpm, modula PPG 5-15% en 0.2-0.34 Hz

REGLAS PARA detectionParams:
- gateRangeScale: 1.0=señal excelente, 0.65=señal mala (reduce ventana de detección)
- outlierThreshold: 0.4=normal, 0.6=arritmia (más tolerante a variación RR)
- smoothingAlpha: 0.3=normal, 0.1=arritmia (más suavizado), 0.5=muy estable
- sqiAdjustment: +5=buena perfusión, -10=mala perfusión
- confidenceWeight: 0.6=alta confianza LLM, 0.3=baja confianza
- bpmLowGuard/bpmHighGuard: límites fisiológicos del FC (ajustar si el LLM detecta ritmo inusual)
- hapticEnabled: false si arritmia muy probable (evitar vibraciones erráticas)

REGLAS DE ANÁLISIS:
1. NUNCA uses thresholds binarios — confianza continua [0-1]
2. Combina evidencia: frecuencia + morfología + perfusión + hemodinámica
3. Si señal es mala, di POR QUÉ y ajusta detectionParams acorde
4. Detecta arritmias comparando RR contra ritmo basal aprendido
5. Produce SOLO JSON válido

RESPUESTA JSON:
{
  "signalQuality": { "level": "excellent|good|fair|poor|unusable", "confidence": 0.0-1.0, "explanation": "..." },
  "heartRate": { "value": número, "confidence": 0.0-1.0, "rhythm": "sinus|irregular|bradycardia|tachycardia" },
  "arrhythmia": { "detected": boolean, "likelihood": 0.0-1.0, "type": "none|af|pvc|pac|bigeminy", "explanation": "..." },
  "perfusion": { "level": "good|fair|poor|absent", "confidence": 0.0-1.0, "explanation": "..." },
  "hemodynamic": { "estimatedMAP": número, "confidence": 0.0-1.0, "explanation": "..." },
  "detectionParams": {
    "gateRangeScale": 0.65-1.0,
    "outlierThreshold": 0.2-0.7,
    "smoothingAlpha": 0.1-0.5,
    "sqiAdjustment": -15 a +15,
    "confidenceWeight": 0.3-0.7,
    "bpmLowGuard": 25-50,
    "bpmHighGuard": 180-250,
    "hapticEnabled": true/false
  },
  "assessment": "resumen clínico 1-2 oraciones",
  "recommendations": ["rec1", "rec2"]
}`;

export class ContextBuilder {
  private signalAnalyzer: SignalAnalyzer;
  private historyBuffer: string[] = [];
  private readonly MAX_HISTORY = 10;

  constructor() {
    this.signalAnalyzer = new SignalAnalyzer();
  }

  buildMessages(ctx: VitalContext): Array<{ role: string; content: string }> {
    const signalSummary = this.buildSignalSummary(ctx);
    const historyContext = this.historyBuffer.length > 0
      ? `\nHISTORIAL RECIENTE:\n${this.historyBuffer.join('\n')}`
      : '';

    const userPrompt = `DATOS ACTUALES DE MEDICIÓN:
${signalSummary}
${historyContext}

Analiza estos datos y produce tu diagnóstico + detectionParams en JSON.`;

    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];
  }

  addToHistory(assessment: string): void {
    this.historyBuffer.push(assessment);
    if (this.historyBuffer.length > this.MAX_HISTORY) {
      this.historyBuffer.shift();
    }
  }

  private buildSignalSummary(ctx: VitalContext): string {
    const lines: string[] = [];

    lines.push(`FC: ${ctx.heartRate > 0 ? `${Math.round(ctx.heartRate)} lpm` : 'no detectada'}`);
    lines.push(`Contacto dedo: ${ctx.fingerContact ? 'confirmado' : 'no confirmado'}`);
    lines.push(`Calidad señal SQI: ${ctx.signalQuality.toFixed(1)}/100`);
    lines.push(`Perfusión PI: ${(ctx.perfusionIndex * 100).toFixed(2)}%`);
    lines.push(`Movimiento: ${(ctx.motionScore * 100).toFixed(0)}%`);
    lines.push(`Picos detectados: ${ctx.peakCount} (${ctx.consecutivePeaks} consecutivos)`);

    if (ctx.rrIntervals.length >= 3) {
      const sorted = [...ctx.rrIntervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const mean = ctx.rrIntervals.reduce((a, b) => a + b, 0) / ctx.rrIntervals.length;
      const variance = ctx.rrIntervals.reduce((a, r) => a + (r - mean) ** 2, 0) / ctx.rrIntervals.length;
      const cv = Math.sqrt(variance) / mean;

      lines.push(`RR media: ${Math.round(mean)}ms | mediana: ${Math.round(median)}ms`);
      lines.push(`HRV (CV): ${(cv * 100).toFixed(1)}%`);
      lines.push(`RR últimos 5: ${ctx.rrIntervals.slice(-5).map(r => Math.round(r)).join(', ')} ms`);
    }

    if (ctx.features) {
      const f = ctx.features;
      lines.push(`AC/DC: ${f.perfusion.acDcRatio.toFixed(4)} | Freq dominante: ${f.frequency.dominantFreqHz.toFixed(2)} Hz`);
      lines.push(`Potencia cardíaca: ${(f.frequency.cardiacPowerRatio * 100).toFixed(0)}%`);
      lines.push(`Morfología: consistencia=${f.morphology.beatConsistency.toFixed(2)} template=${f.morphology.templateMatch.toFixed(2)}`);
      if (f.waveform.hasNotch) {
        lines.push(`Inciso dicrótico: presente en ${(f.waveform.notchPosition * 100).toFixed(0)}% de la diástole`);
      }
    }

    lines.push(`Tiempo medición: ${(ctx.elapsedMs / 1000).toFixed(1)}s`);

    return lines.join('\n');
  }

  reset(): void {
    this.historyBuffer = [];
    this.signalAnalyzer = new SignalAnalyzer();
  }
}
