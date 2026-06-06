export const FFT_SHADER = `
  @group(0) @binding(0) var<storage, read> input: array<f32>;
  @group(0) @binding(1) var<storage, read_write> output: array<f32>;
  @group(0) @binding(2) var<storage, read> twiddles: array<f32>;

  @compute @workgroup_size(256)
  fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    let n = arrayLength(&input);
    if (i >= n) { return; }

    // Bit-reversal permutation
    var j: u32 = 0;
    var bit: u32 = 1;
    while (bit < n) {
      j = (j << 1) | ((i & bit) >> u32(log2(f32(bit))));
      bit = bit << 1;
    }
    output[i * 2] = input[j];
    output[i * 2 + 1] = 0.0;

    // Cooley-Tukey radix-2 FFT
    var len: u32 = 1;
    while (len < n) {
      let step = len * 2;
      for (var k: u32 = 0u; k < n; k += step) {
        for (var t: u32 = 0u; t < len; t++) {
          let idx0 = (k + t) * 2u;
          let idx1 = (k + t + len) * 2u;
          let re0 = output[idx0];
          let im0 = output[idx0 + 1u];
          let tw = twiddles[(n / step) * t * 2u];
          let twIm = twiddles[(n / step) * t * 2u + 1u];
          let re1 = output[idx1] * tw - output[idx1 + 1u] * twIm;
          let im1 = output[idx1] * twIm + output[idx1 + 1u] * tw;
          output[idx0] = re0 + re1;
          output[idx0 + 1u] = im0 + im1;
          output[idx1] = re0 - re1;
          output[idx1 + 1u] = im0 - im1;
        }
      }
      len = step;
    }
  }
`;

export const BANDPASS_SHADER = `
  @group(0) @binding(0) var<storage, read> input: array<f32>;
  @group(0) @binding(1) var<storage, read_write> output: array<f32>;
  @group(0) @binding(2) var<uniform> params: vec4<f32>;

  @compute @workgroup_size(256)
  fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    let n = arrayLength(&input);
    if (i >= n) { return; }

    let lowCutoff = params.x;
    let highCutoff = params.y;
    let sampleRate = params.z;

    // Simple IIR bandpass approximation per sample
    let freq = f32(i) * sampleRate / f32(n);
    var gain: f32 = 0.0;
    if (freq >= lowCutoff && freq <= highCutoff) {
      gain = 1.0;
    } else if (freq < lowCutoff) {
      gain = 1.0 - (lowCutoff - freq) / lowCutoff;
    } else {
      gain = 1.0 - (freq - highCutoff) / highCutoff;
    }
    output[i] = input[i] * max(0.0, gain);
  }
`;

export const AUTOCORRELATION_SHADER = `
  @group(0) @binding(0) var<storage, read> input: array<f32>;
  @group(0) @binding(1) var<storage, read_write> output: array<f32>;

  @compute @workgroup_size(256)
  fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let lag = id.x;
    let n = arrayLength(&input);
    if (lag >= n) { return; }
    var sum: f32 = 0.0;
    for (var i: u32 = 0u; i < n - lag; i++) {
      sum += input[i] * input[i + lag];
    }
    output[lag] = sum;
  }
`;

export const MATRIX_MUL_SHADER = `
  @group(0) @binding(0) var<storage, read> a: array<f32>;
  @group(0) @binding(1) var<storage, read> b: array<f32>;
  @group(0) @binding(2) var<storage, read_write> output: array<f32>;
  @group(0) @binding(3) var<uniform> dims: vec4<u32>;

  @compute @workgroup_size(16, 16)
  fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let row = id.x;
    let col = id.y;
    let m = dims.x;
    let n = dims.y;
    let k = dims.z;
    if (row >= m || col >= n) { return; }
    var sum: f32 = 0.0;
    for (var i: u32 = 0u; i < k; i++) {
      sum += a[row * k + i] * b[i * n + col];
    }
    output[row * n + col] = sum;
  }
`;
