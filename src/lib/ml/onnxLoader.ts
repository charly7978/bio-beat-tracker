import * as ort from 'onnxruntime-web';

/**
 * Singleton Loader for ONNX Runtime sessions.
 * Caches sessions and configures optimum thread count/execution providers
 * for browser and worker environments.
 */
export class OnnxModelLoader {
  private static sessions: Map<string, ort.InferenceSession> = new Map();
  private static isConfigured = false;

  private static configureRuntime() {
    if (this.isConfigured) return;
    
    try {
      // Configure WASM paths and thread limits to prevent worker lag
      if (typeof ort !== 'undefined' && ort.env && ort.env.wasm) {
        ort.env.wasm.numThreads = 1; // Limit to 1 thread inside web worker to avoid context-switching overhead
        
        // Locate WASM binaries relative to the origin
        // In Vite, these are copied/served from the public or node_modules during dev/preview
        ort.env.wasm.wasmPaths = {
          'ort-wasm.wasm': '/ort-wasm.wasm',
          'ort-wasm-threaded.wasm': '/ort-wasm-threaded.wasm',
          'ort-wasm-simd.wasm': '/ort-wasm-simd.wasm',
          'ort-wasm-simd-threaded.wasm': '/ort-wasm-simd-threaded.wasm',
        };
      }
    } catch (e) {
      console.warn('ONNX Runtime Web environment configuration failed: ', e);
    }
    
    this.isConfigured = true;
  }

  /**
   * Loads or returns a cached inference session for a given model path.
   * @param modelPath URL or path to the .onnx model file (e.g. '/models/vision_cortex_v1.onnx')
   */
  public static async getSession(modelPath: string): Promise<ort.InferenceSession> {
    this.configureRuntime();
    
    if (this.sessions.has(modelPath)) {
      return this.sessions.get(modelPath)!;
    }

    try {
      // Force WASM execution provider for universal device compatibility (iOS/Android/Web)
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      
      this.sessions.set(modelPath, session);
      return session;
    } catch (err) {
      console.error(`Failed to create ONNX session for ${modelPath}:`, err);
      throw err;
    }
  }

  /**
   * Pre-fetches a model to warm up the cache.
   */
  public static async warmUp(modelPath: string): Promise<void> {
    try {
      await this.getSession(modelPath);
    } catch {
      // Best-effort warm up
    }
  }
}
