import { pipeline, env, type TextGenerationPipeline } from '@huggingface/transformers';
import { createLogger } from '@/utils/logger';

const log = createLogger('SignalBrain');

env.allowLocalModels = false;
env.useBrowserCache = true;

export type SignalVerdict = 'REAL_BEAT' | 'NOISE_ARTIFACT' | 'FAKE_SIGNAL' | 'UNCERTAIN';

export interface SignalFeatures {
  bpm: number;
  sqi: number;
  pi: number;
  periodicity: number;
  motion: number;
  snr: number;
  skewness?: number;
  kurtosis?: number;
}

export interface BrainReasoning {
  verdict: SignalVerdict;
  confidence: number;
  thought: string;
}

/**
 * CEREBRO DE LA SEÑAL (LLM Local - Llama 3.2)
 *
 * Actúa como un Auditor Clínico. No calcula números, razonar sobre ellos
 * aplicando conocimiento de fisiología cardiovascular para validar la señal.
 */
export class SignalBrain {
  private generator: TextGenerationPipeline | null = null;
  private isInitializing = false;
  private modelId = 'onnx-community/Llama-3.2-1B-Instruct';

  async initialize() {
    if (this.generator || this.isInitializing) return;
    this.isInitializing = true;

    log.info(`Iniciando Cerebro IA con Llama 3.2...`);

    try {
      this.generator = await pipeline('text-generation', this.modelId, {
        device: 'webgpu',
        dtype: 'q4', // Precisión de 4 bits para eficiencia móvil
      }) as TextGenerationPipeline;

      log.info('Cerebro IA listo para auditoría clínica');
    } catch (e) {
      log.error('Fallo WebGPU, intentando CPU...', e);
      try {
        this.generator = await pipeline('text-generation', this.modelId, {
          device: 'wasm',
          dtype: 'q8',
        }) as TextGenerationPipeline;
      } catch (err) {
        log.error('Error total en inicialización de IA', err);
      }
    } finally {
      this.isInitializing = false;
    }
  }

  async auditSignal(f: SignalFeatures): Promise<BrainReasoning> {
    if (!this.generator) {
      return { verdict: 'UNCERTAIN', confidence: 0.5, thought: 'IA no inicializada' };
    }

    const prompt = this.buildMedicalPrompt(f);

    try {
      const output = await this.generator(prompt, {
        max_new_tokens: 128,
        temperature: 0.1, // Casi determinista para veracidad clínica
        do_sample: false,
        return_full_text: false,
      }) as any;

      const response = (Array.isArray(output) ? output[0].generated_text : output.generated_text) as string;
      return this.parseMedicalResponse(response);
    } catch (e) {
      log.warn('Fallo en razonamiento IA', e);
      return { verdict: 'UNCERTAIN', confidence: 0.5, thought: 'Error de razonamiento' };
    }
  }

  private buildMedicalPrompt(f: SignalFeatures): string {
    return `<|begin_of_text|><|start_header_id|>system<|end_header_id|>
Eres un Auditor Clínico Experto en Fotopletismografía (PPG).
Tu objetivo es determinar la veracidad de una señal de pulso humano.
Conocimiento base:
- Un pulso real tiene Skewness POSITIVA (subida sistólica rápida).
- La periodicidad alta (>0.7) indica ritmo biológico estable.
- El movimiento alto (>0.6) corrompe la morfología y genera falsos picos.
- La perfusión (PI) baja indica mala colocación o señal falsa.

Responde estrictamente en JSON: {"verdict": "REAL_BEAT" | "NOISE_ARTIFACT" | "FAKE_SIGNAL", "confidence": 0-1, "reason": "explicación clínica corta"}<|eot_id|>
<|start_header_id|>user<|end_header_id|>
Audita estos datos:
- Frecuencia: ${f.bpm} BPM
- Calidad Técnica (SQI): ${f.sqi}
- Perfusión (PI): ${f.pi.toFixed(5)}
- Periodicidad: ${f.periodicity.toFixed(2)}
- Movimiento: ${f.motion.toFixed(2)}
- SNR: ${f.snr.toFixed(2)}
- Skewness: ${f.skewness?.toFixed(2) ?? 'N/A'}
- Kurtosis: ${f.kurtosis?.toFixed(2) ?? 'N/A'}

¿Es este un latido humano legítimo y estable?<|inter_header_id|>assistant<|end_header_id|>
`;
  }

  private parseMedicalResponse(text: string): BrainReasoning {
    try {
      const jsonMatch = text.match(/\{.*\}/s);
      const data = JSON.parse(jsonMatch ? jsonMatch[0] : text);

      return {
        verdict: (data.verdict as SignalVerdict) || 'UNCERTAIN',
        confidence: data.confidence || 0.5,
        thought: data.reason || 'Sin razonamiento clínico',
      };
    } catch {
      const lower = text.toLowerCase();
      if (lower.includes('real_beat')) return { verdict: 'REAL_BEAT', confidence: 0.8, thought: text };
      if (lower.includes('noise')) return { verdict: 'NOISE_ARTIFACT', confidence: 0.8, thought: text };
      if (lower.includes('fake')) return { verdict: 'FAKE_SIGNAL', confidence: 0.9, thought: text }; // anti-sim-allow: reason="Internal label for AI verdict on simulated/fake inputs" ref="AI-SIGNAL-AUDIT"

      return { verdict: 'UNCERTAIN', confidence: 0.5, thought: text };
    }
  }
}

export const signalBrain = new SignalBrain();
