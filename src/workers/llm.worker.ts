import { pipeline, env, type TextGenerationPipeline } from '@huggingface/transformers';

env.allowLocalModels = false;

let generator: TextGenerationPipeline | null = null;
let loading = false;
let loadProgress = 0;

const MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';

self.onmessage = async (event: MessageEvent) => {
  const { id, type, data } = event.data;

  try {
    switch (type) {
      case 'load': {
        if (generator) {
          self.postMessage({ id, type: 'loaded', data: { model: MODEL_ID } });
          return;
        }
        if (loading) {
          self.postMessage({ id, type: 'loading', data: { progress: loadProgress } });
          return;
        }
        loading = true;
        self.postMessage({ id: 0, type: 'progress', data: { stage: 'loading_model', progress: 0 } });

        try {
          const device = await detectDevice();
          generator = await pipeline('text-generation', MODEL_ID, {
            dtype: 'q4',
            device,
            progress_callback: (p: Record<string, unknown>) => {
              if (typeof p === 'object' && p !== null) {
                if ('progress' in p && typeof p.progress === 'number') {
                  loadProgress = p.progress;
                  self.postMessage({ id: 0, type: 'progress', data: { stage: 'downloading', progress: p.progress } });
                }
                if ('status' in p && p.status === 'ready') {
                  loadProgress = 100;
                  self.postMessage({ id: 0, type: 'progress', data: { stage: 'ready', progress: 100 } });
                }
              }
            },
          }) as TextGenerationPipeline;
          loading = false;
          self.postMessage({ id, type: 'loaded', data: { model: MODEL_ID, device } });
        } catch (err) {
          loading = false;
          self.postMessage({ id, type: 'error', data: { message: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }

      case 'infer': {
        if (!generator) {
          self.postMessage({ id, type: 'error', data: { message: 'Model not loaded' } });
          return;
        }

        const { messages, maxTokens } = data as {
          messages: Array<{ role: string; content: string }>;
          maxTokens?: number;
        };

        const output = await generator(messages, {
          max_new_tokens: maxTokens ?? 512,
          do_sample: false,
          temperature: 0.1,
        });

        const response = (output as Array<{ generated_text: Array<{ role: string; content: string }> }>)[0];
        const lastMsg = response.generated_text[response.generated_text.length - 1];
        self.postMessage({ id, type: 'result', data: { content: lastMsg?.content ?? '' } });
        break;
      }

      case 'status': {
        self.postMessage({
          id,
          type: 'status',
          data: { loaded: !!generator, loading, progress: loadProgress, model: MODEL_ID },
        });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    self.postMessage({
      id,
      type: 'error',
      data: { message: err instanceof Error ? err.message : String(err) },
    });
  }
};

async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      const adapter = await (navigator as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu?.requestAdapter?.();
      if (adapter) return 'webgpu';
    }
  } catch {
    // WebGPU not available
  }
  return 'wasm';
}
