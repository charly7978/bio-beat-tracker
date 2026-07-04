import { pipeline, type TextGenerationPipeline } from '@huggingface/transformers';
import { createLogger } from '@/utils/logger';

const log = createLogger('SessionOrchestrator');

export interface SessionSnapshot {
  vision: {
    scene: string;
    certainty: number;
    tissueTransparency?: number;
  };
  signal: {
    bpm: number;
    sqi: number;
    pi: number;
    asymmetry?: number;
    notchDetected: boolean;
  };
  hardware: {
    fps: number;
    iso: number;
    exposure: number;
  };
}

export interface SectorCommands {
  camera?: {
    fps?: number;
    iso?: number | 'auto';
    exposureCompensation?: number;
  };
  dsp?: {
    filterType?: 'butterworth' | 'chebyshev';
    sensitivity?: number;
    highcut?: number;
  };
  ui?: {
    speak?: string;
    guidanceText?: string;
    status: 'analyzing' | 'stabilizing' | 'ready' | 'error';
  };
}

/**
 * MASTER ORCHESTRATOR (Llama 3.2 3B)
 *
 * Es el cerebro central que razona sobre la sesión de medición y orquestra
 * todos los sectores del código mediante comandos JSON.
 */
export class SessionOrchestrator {
  private generator: TextGenerationPipeline | null = null;
  private isInitializing = false;
  private mentalModel: string[] = [];

  async initialize() {
    if (this.generator || this.isInitializing) return;
    this.isInitializing = true;

    try {
      // Intentamos cargar Llama 3.2 3B. Si falla (memoria), fallback a 1B.
      this.generator = await pipeline('text-generation', 'onnx-community/Llama-3.2-3B-Instruct', {
        device: 'webgpu',
        dtype: 'q4',
      }) as TextGenerationPipeline;
      log.info('Orchestrator: Llama 3.2 3B Loaded');
    } catch (e) {
      log.warn('Orchestrator: 3B failed, falling back to 1B', e);
      this.generator = await pipeline('text-generation', 'onnx-community/Llama-3.2-1B-Instruct', {
        device: 'webgpu',
        dtype: 'q4',
      }) as TextGenerationPipeline;
    } finally {
      this.isInitializing = false;
    }
  }

  async reason(snapshot: SessionSnapshot): Promise<SectorCommands> {
    if (!this.generator) return {};

    const prompt = this.buildOrchestratorPrompt(snapshot);

    try {
      const output = await this.generator(prompt, {
        max_new_tokens: 256,
        temperature: 0.2,
        do_sample: false,
        return_full_text: false,
      }) as unknown as { generated_text: string } | { generated_text: string }[];

      const text = (Array.isArray(output) ? output[0].generated_text : output.generated_text) as string;
      return this.parseCommands(text);
    } catch (e) {
      log.error('Reasoning failed', e);
      return {};
    }
  }

  private buildOrchestratorPrompt(s: SessionSnapshot): string {
    const history = this.mentalModel.slice(-3).join('\n');

    return `<|begin_of_text|><|start_header_id|>system<|end_header_id|>
Eres el Orquestador Central de un monitor cardíaco clínico. Tu misión es razonar sobre los datos de los agentes tácticos y controlar el hardware y software mediante JSON.
Sectores bajo tu mando: "camera" (fps, iso, exp), "dsp" (filterType, sensitivity), "ui" (speak, guidanceText, status).

Reglas Clínicas:
1. Si no hay dedo (scene="inert"), detén la orquestación.
2. Si la muesca dicrótica no se ve (notchDetected=false), aumenta la sensibilidad del DSP o ajusta ISO.
3. Si el PI es bajo, pide al usuario mover el dedo para encontrar una arteria.

Historial reciente:
${history}

Responde EXCLUSIVAMENTE con un objeto JSON válido.<|eot_id|>
<|start_header_id|>user<|end_header_id|>
Snapshot actual:
Visión: ${JSON.stringify(s.vision)}
Señal: ${JSON.stringify(s.signal)}
Hardware: ${JSON.stringify(s.hardware)}

¿Qué acciones ejecutivas debemos tomar?<|inter_header_id|>assistant<|end_header_id|>
`;
  }

  private parseCommands(text: string): SectorCommands {
    try {
      const jsonMatch = text.match(/\{.*\}/s);
      const commands = JSON.parse(jsonMatch ? jsonMatch[0] : text);

      // Guardamos la decisión en el modelo mental
      if (commands.ui?.speak) {
        this.mentalModel.push(`IA: ${commands.ui.speak}`);
      }

      return commands as SectorCommands;
    } catch {
      log.warn('Failed to parse IA commands', text);
      return {};
    }
  }
}

export const orchestrator = new SessionOrchestrator();
