import { pipeline, type TextGenerationPipeline } from '@huggingface/transformers';
import { createLogger } from '@/utils/logger';

const log = createLogger('SessionOrchestrator');

export type SignalVerdict = 'REAL_BEAT' | 'NOISE_ARTIFACT' | 'FAKE_SIGNAL' | 'UNCERTAIN';

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
    thoughtProcess?: string; // Los pensamientos internos de la IA
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
  private loadProgress = 0;
  private loadStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';

  getStatus() {
    return { status: this.loadStatus, progress: this.loadProgress };
  }

  async initialize() {
    if (this.generator || this.isInitializing) return;
    this.isInitializing = true;
    this.loadStatus = 'loading';

    try {
      // Usamos un modelo más realista para móvil (Qwen 0.5B) para asegurar que "Exista"
      // Llama 3.2 3B es demasiado pesado para la mayoría de navegadores móviles.
      this.generator = await pipeline('text-generation', 'onnx-community/Qwen2.5-0.5B-Instruct', {
        device: 'webgpu',
        dtype: 'q4',
        progress_callback: (p: any) => {
          if (p.status === 'progress') {
            this.loadProgress = p.progress;
          }
        }
      }) as TextGenerationPipeline;

      this.loadStatus = 'ready';
      log.info('Orchestrator: Qwen 0.5B Ready');
    } catch (e) {
      log.warn('Orchestrator: WebGPU failed, falling back to WASM', e);
      try {
        this.generator = await pipeline('text-generation', 'onnx-community/Qwen2.5-0.5B-Instruct', {
          device: 'wasm',
          dtype: 'q8',
        }) as TextGenerationPipeline;
        this.loadStatus = 'ready';
      } catch (err) {
        this.loadStatus = 'error';
        log.error('Total failure in SessionOrchestrator', err);
      }
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
NO ERES UN FILTRO, ERES UN AGENTE DECISOR.

Sectores bajo tu mando:
- "camera" (fps, iso, exp)
- "dsp" (filterType, sensitivity)
- "ui" (speak, guidanceText, status, thoughtProcess)

Reglas de Oro:
1. "thoughtProcess": Escribe aquí tu razonamiento médico real sobre por qué tomas cada decisión. Sé crítico y profesional.
2. Si detectas fraude (manzana, objeto inerte), pon status="error", speak="Veredicto IA: Objeto no biológico detectado. Abortando." y explica por qué en thoughtProcess.
3. Si la señal es inestable, NO permitas que avance el progreso. Detenlo con status="analyzing".
4. Interactúa de forma humana en "speak".

Historial reciente:
${history}

Responde EXCLUSIVAMENTE con un objeto JSON válido.<|eot_id|>
<|start_header_id|>user<|end_header_id|>
Snapshot actual:
Visión: ${JSON.stringify(s.vision)}
Señal: ${JSON.stringify(s.signal)}
Hardware: ${JSON.stringify(s.hardware)}

Analiza la biología de la escena y emite comandos:<|inter_header_id|>assistant<|end_header_id|>
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
