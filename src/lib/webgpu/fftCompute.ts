import { webgpu } from './webgpuContext';
import { FFT_SHADER, BANDPASS_SHADER, AUTOCORRELATION_SHADER, MATRIX_MUL_SHADER } from './shaders';

export interface FFTOutput {
  real: Float32Array;
  imag: Float32Array;
  magnitudes: Float32Array;
  dominantFreq: number;
  executionTimeMs: number;
}

export class GPUFFTProcessor {
  private fftPipeline: GPUComputePipeline | null = null;
  private bpPipeline: GPUComputePipeline | null = null;
  private acPipeline: GPUComputePipeline | null = null;
  private mmPipeline: GPUComputePipeline | null = null;
  private initialized = false;

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    await webgpu.initialize();
    if (!webgpu.getCapabilities().available) return false;

    try {
      this.fftPipeline = webgpu.createComputePipeline(FFT_SHADER)!;
      this.bpPipeline = webgpu.createComputePipeline(BANDPASS_SHADER)!;
      this.acPipeline = webgpu.createComputePipeline(AUTOCORRELATION_SHADER)!;
      this.mmPipeline = webgpu.createComputePipeline(MATRIX_MUL_SHADER)!;
      this.initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  get available(): boolean { return this.initialized; }

  async fft(signal: Float32Array, sampleRate: number): Promise<FFTOutput> {
    const device = webgpu.getDevice();
    if (!device || !this.fftPipeline) throw new Error('WebGPU not initialized');

    const start = performance.now();
    const n = this.nextPow2(signal.length);
    const buf = new Float32Array(n);
    buf.set(signal);

    const inputBuf = webgpu.createBuffer('fft_input', buf.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)!;
    const outputBuf = webgpu.createBuffer('fft_output', buf.byteLength * 2,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)!;
    const twiddles = this.computeTwiddles(n);
    const twiddleBuf = webgpu.createBuffer('fft_twiddles', twiddles.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)!;

    device.queue.writeBuffer(inputBuf, 0, buf);
    device.queue.writeBuffer(twiddleBuf, 0, twiddles);

    const bindGroup = device.createBindGroup({
      layout: this.fftPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: outputBuf } },
        { binding: 2, resource: { buffer: twiddleBuf } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.fftPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(n / 256));
    pass.end();
    device.queue.submit([encoder.finish()]);

    const result = await webgpu.readBuffer(outputBuf, buf.byteLength * 2);
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    const magnitudes = new Float32Array(n);

    if (result) {
      for (let i = 0; i < n; i++) {
        real[i] = result[i * 2];
        imag[i] = result[i * 2 + 1];
        magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
      }
    }

    const dominantIdx = this.findDominantFreq(magnitudes, sampleRate, n);
    const dominantFreq = dominantIdx * sampleRate / n;

    inputBuf.destroy();
    outputBuf.destroy();
    twiddleBuf.destroy();

    return {
      real, imag, magnitudes, dominantFreq,
      executionTimeMs: performance.now() - start,
    };
  }

  async bandpassFilter(signal: Float32Array, lowHz: number, highHz: number, sampleRate: number): Promise<Float32Array> {
    const device = webgpu.getDevice();
    if (!device || !this.bpPipeline) throw new Error('WebGPU not initialized');

    const n = signal.length;
    const inputBuf = webgpu.createBuffer('bp_input', n * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)!;
    const outputBuf = webgpu.createBuffer('bp_output', n * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)!;
    const paramsBuf = webgpu.createBuffer('bp_params', 16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)!;

    device.queue.writeBuffer(inputBuf, 0, signal);
    device.queue.writeBuffer(paramsBuf, 0,
      new Float32Array([lowHz, highHz, sampleRate, 0]));

    const bindGroup = device.createBindGroup({
      layout: this.bpPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: outputBuf } },
        { binding: 2, resource: { buffer: paramsBuf } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.bpPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(n / 256));
    pass.end();
    device.queue.submit([encoder.finish()]);

    const result = await webgpu.readBuffer(outputBuf, n * 4);

    inputBuf.destroy();
    outputBuf.destroy();
    paramsBuf.destroy();

    return result || new Float32Array(n);
  }

  async autocorrelate(signal: Float32Array): Promise<Float32Array> {
    const device = webgpu.getDevice();
    if (!device || !this.acPipeline) throw new Error('WebGPU not initialized');

    const n = signal.length;
    const inputBuf = webgpu.createBuffer('ac_input', n * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)!;
    const outputBuf = webgpu.createBuffer('ac_output', n * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)!;

    device.queue.writeBuffer(inputBuf, 0, signal);

    const bindGroup = device.createBindGroup({
      layout: this.acPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuf } },
        { binding: 1, resource: { buffer: outputBuf } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.acPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(n / 256));
    pass.end();
    device.queue.submit([encoder.finish()]);

    const result = await webgpu.readBuffer(outputBuf, n * 4);
    inputBuf.destroy();
    outputBuf.destroy();
    return result || new Float32Array(n);
  }

  async matrixMul(
    a: Float32Array, b: Float32Array,
    m: number, n: number, k: number,
  ): Promise<Float32Array> {
    const device = webgpu.getDevice();
    if (!device || !this.mmPipeline) throw new Error('WebGPU not initialized');

    const aBuf = webgpu.createBuffer('mm_a', a.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)!;
    const bBuf = webgpu.createBuffer('mm_b', b.byteLength,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)!;
    const outBuf = webgpu.createBuffer('mm_out', m * n * 4,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)!;
    const dimsBuf = webgpu.createBuffer('mm_dims', 16,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)!;

    device.queue.writeBuffer(aBuf, 0, a);
    device.queue.writeBuffer(bBuf, 0, b);
    device.queue.writeBuffer(dimsBuf, 0, new Uint32Array([m, n, k, 0]));

    const bindGroup = device.createBindGroup({
      layout: this.mmPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: aBuf } },
        { binding: 1, resource: { buffer: bBuf } },
        { binding: 2, resource: { buffer: outBuf } },
        { binding: 3, resource: { buffer: dimsBuf } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.mmPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(m / 16), Math.ceil(n / 16));
    pass.end();
    device.queue.submit([encoder.finish()]);

    const result = await webgpu.readBuffer(outBuf, m * n * 4);
    aBuf.destroy(); bBuf.destroy(); outBuf.destroy(); dimsBuf.destroy();
    return result || new Float32Array(m * n);
  }

  private nextPow2(x: number): number {
    let n = 1;
    while (n < x) n <<= 1;
    return n;
  }

  private computeTwiddles(n: number): Float32Array {
    const tw = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const angle = -2 * Math.PI * i / n;
      tw[i * 2] = Math.cos(angle);
      tw[i * 2 + 1] = Math.sin(angle);
    }
    return tw;
  }

  private findDominantFreq(magnitudes: Float32Array, sampleRate: number, n: number): number {
    const minBin = Math.floor(0.5 * n / sampleRate);
    const maxBin = Math.ceil(4 * n / sampleRate);
    let maxIdx = minBin;
    let maxVal = 0;
    for (let i = minBin; i <= maxBin && i < magnitudes.length; i++) {
      if (magnitudes[i] > maxVal) { maxVal = magnitudes[i]; maxIdx = i; }
    }
    return maxIdx;
  }
}

export const gpuFFT = new GPUFFTProcessor();
