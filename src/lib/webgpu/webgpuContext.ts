export type GPUComputeBackend = 'webgpu' | 'cpu';

export interface GPUComputeCapabilities {
  available: boolean;
  backend: GPUComputeBackend;
  maxBufferSize: number;
  maxComputeWorkgroupSize: number;
  vendor?: string;
  architecture?: string;
}

export class WebGPUContext {
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private capabilities: GPUComputeCapabilities = {
    available: false,
    backend: 'cpu',
    maxBufferSize: 0,
    maxComputeWorkgroupSize: 0,
  };

  async initialize(): Promise<GPUComputeCapabilities> {
    if (this.device) return this.capabilities;

    try {
      if (!navigator.gpu) throw new Error('WebGPU not available');
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) throw new Error('No GPU adapter found');

      this.device = await this.adapter.requestDevice();
      const limits = this.device.limits;

      this.capabilities = {
        available: true,
        backend: 'webgpu',
        maxBufferSize: limits.maxBufferSize,
        maxComputeWorkgroupSize: limits.maxComputeWorkgroupInvocations,
        vendor: this.adapter.info?.vendor || undefined,
        architecture: this.adapter.info?.architecture || undefined,
      };
    } catch {
      this.capabilities = {
        available: false,
        backend: 'cpu',
        maxBufferSize: 0,
        maxComputeWorkgroupSize: 0,
      };
    }

    return this.capabilities;
  }

  getDevice(): GPUDevice | null { return this.device; }
  getCapabilities(): GPUComputeCapabilities { return this.capabilities; }

  createBuffer(
    label: string,
    size: number,
    usage: GPUBufferUsageFlags,
    mappedAtCreation = false,
 ): GPUBuffer | null {
    if (!this.device) return null;
    return this.device.createBuffer({ label, size, usage, mappedAtCreation });
  }

  createComputePipeline(code: string, entryPoint = 'main'): GPUComputePipeline | null {
    if (!this.device) return null;
    const shader = this.device.createShaderModule({ code });
    return this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: shader, entryPoint },
    });
  }

  async readBuffer(buffer: GPUBuffer, size: number): Promise<Float32Array | null> {
    if (!this.device) return null;
    const staging = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return result;
  }

  destroy(): void {
    this.device?.destroy();
    this.device = null;
    this.adapter = null;
    this.capabilities.available = false;
    this.capabilities.backend = 'cpu';
  }
}

export const webgpu = new WebGPUContext();
