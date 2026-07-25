/**
 * FILTRO BUTTERWORTH DE FASE CERO — acondicionamiento de PPG.
 *
 * Réplica del acondicionamiento que NeuroKit2 aplica antes de detectar picos
 * (`ppg_clean` → `signal_filter(method="butterworth", order=3, lowcut=0.5,
 * highcut=8)`), que es a su vez lo que exige Elgendi et al. 2013: la señal debe
 * llegar al detector filtrada entre 0,5 y 8 Hz.
 *
 * DOS DECISIONES QUE IMPORTAN, y por qué:
 *
 * 1. BANDA 0,5–8 Hz, no 0,5–4,5 Hz. El pulso fundamental vive en 0,7–3,5 Hz,
 *    pero la SUBIDA SISTÓLICA —el flanco que el detector busca— está construida
 *    con armónicos hasta ~8 Hz. Cortar en 4,5 Hz redondea ese flanco y le quita
 *    al algoritmo justo el rasgo que discrimina.
 *
 * 2. FASE CERO (filtfilt), no causal. NeuroKit2 filtra hacia adelante y hacia
 *    atrás, lo que anula el desfase y —crucialmente— evita el *ringing* que un
 *    filtro causal de orden alto produce tras un escalón (un movimiento del
 *    dedo). Ese ringing es indistinguible de latidos y es una fuente clásica de
 *    picos falsos. El precio es que hay que trabajar sobre una VENTANA, no
 *    muestra a muestra: por eso el pipeline analiza una ventana deslizante.
 *
 * Implementación: Butterworth de orden 3 = un polo real + un par complejo →
 * una sección de primer orden en cascada con un biquad, por bilineal con
 * pre-warping. Es exacto para orden 3, no una aproximación.
 */

/** Sección de segundo orden (biquad) en forma directa I. */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Cascada de secciones que realiza un filtro completo. */
export interface FilterSections {
  sections: Biquad[];
}

/**
 * Butterworth pasa-bajos de orden 3 por transformada bilineal con pre-warping.
 * Polos del prototipo normalizado: s = −1, y el par s = −cos(60°) ± j·sen(60°).
 */
export function designLowpass3(cutoffHz: number, fsHz: number): FilterSections {
  const wc = prewarp(cutoffHz, fsHz);
  return {
    sections: [
      // Sección de primer orden: H(s) = wc / (s + wc), expresada como biquad.
      bilinearFirstOrder(wc, fsHz, 'low'),
      // Par complejo con Q = 1 (orden 3 → amortiguamiento 2·cos(60°) = 1).
      bilinearSecondOrder(wc, fsHz, 1.0, 'low'),
    ],
  };
}

/** Butterworth pasa-altos de orden 3, mismo criterio. */
export function designHighpass3(cutoffHz: number, fsHz: number): FilterSections {
  const wc = prewarp(cutoffHz, fsHz);
  return {
    sections: [
      bilinearFirstOrder(wc, fsHz, 'high'),
      bilinearSecondOrder(wc, fsHz, 1.0, 'high'),
    ],
  };
}

/**
 * Pasa-banda como cascada pasa-altos + pasa-bajos, ambos de orden 3.
 *
 * NOTA HONESTA: scipy `butter(3, [lo, hi], 'bandpass')` no es idéntico a esta
 * cascada (usa la transformación lp2bp sobre el prototipo, dando 6º orden con
 * otra distribución de polos). En la banda de paso ambos son planos y la
 * diferencia es marginal para PPG; esta forma es exacta, verificable sección a
 * sección y mucho menos propensa a errores numéricos que una lp2bp a mano.
 */
export function designBandpass(lowHz: number, highHz: number, fsHz: number): FilterSections {
  const nyquist = fsHz / 2;
  const hi = Math.min(highHz, nyquist * 0.99);
  return {
    sections: [
      ...designHighpass3(lowHz, fsHz).sections,
      ...designLowpass3(hi, fsHz).sections,
    ],
  };
}

function prewarp(freqHz: number, fsHz: number): number {
  // Pre-warping: compensa la compresión de frecuencias de la bilineal para que
  // la frecuencia de corte digital coincida con la analógica pedida.
  return 2 * fsHz * Math.tan((Math.PI * freqHz) / fsHz);
}

function bilinearFirstOrder(wc: number, fsHz: number, kind: 'low' | 'high'): Biquad {
  const k = 2 * fsHz;
  const den = k + wc;
  if (kind === 'low') {
    return { b0: wc / den, b1: wc / den, b2: 0, a1: (wc - k) / den, a2: 0 };
  }
  return { b0: k / den, b1: -k / den, b2: 0, a1: (wc - k) / den, a2: 0 };
}

function bilinearSecondOrder(
  wc: number,
  fsHz: number,
  damping: number,
  kind: 'low' | 'high',
): Biquad {
  // Analógico: H(s) = wc² / (s² + damping·wc·s + wc²)  [pasa-bajos]
  const k = 2 * fsHz;
  const k2 = k * k;
  const wc2 = wc * wc;
  const den = k2 + damping * wc * k + wc2;
  if (kind === 'low') {
    return {
      b0: wc2 / den,
      b1: (2 * wc2) / den,
      b2: wc2 / den,
      a1: (2 * (wc2 - k2)) / den,
      a2: (k2 - damping * wc * k + wc2) / den,
    };
  }
  return {
    b0: k2 / den,
    b1: (-2 * k2) / den,
    b2: k2 / den,
    a1: (2 * (wc2 - k2)) / den,
    a2: (k2 - damping * wc * k + wc2) / den,
  };
}

/** Aplica una cascada de biquads hacia adelante (causal). */
function forward(x: number[], filter: FilterSections): number[] {
  let signal = x;
  for (const s of filter.sections) {
    const out = new Array<number>(signal.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < signal.length; i++) {
      const xn = signal[i]!;
      const yn = s.b0 * xn + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1;
      x1 = xn;
      y2 = y1;
      y1 = yn;
      out[i] = yn;
    }
    signal = out;
  }
  return signal;
}

/**
 * Filtrado de FASE CERO: pasada hacia adelante + pasada hacia atrás.
 *
 * Los extremos se extienden por reflexión impar respecto del primer y último
 * valor (el mismo criterio que usa scipy `filtfilt` con `padtype="odd"`), lo que
 * evita el transitorio de arranque que de otro modo inventaría un flanco al
 * principio de cada ventana — y un flanco inventado es un latido falso.
 */
export function filtfilt(
  x: number[],
  filter: FilterSections,
  padLenSamples?: number,
): number[] {
  const n = x.length;
  if (n < 9) return x.slice();

  // El relleno DEBE escalar con el tiempo de asentamiento del filtro, que a su
  // vez va como fs/corte_inferior. Un relleno fijo parece inocuo y no lo es: si
  // se queda corto, la pasada deja un transitorio en los extremos cuya energía
  // domina cualquier estadístico posterior sobre la ventana —por ejemplo la
  // media del cuadrado con la que Elgendi fija su umbral—, y el umbral inflado
  // tapa los latidos reales. Quien llama conoce fs y el corte: que lo pase.
  const padLen = Math.min(
    Math.floor(n / 2),
    Math.max(12, Math.round(padLenSamples ?? 12)),
  );
  const padded = oddPad(x, padLen);

  const once = forward(padded, filter);
  const reversed = once.slice().reverse();
  const twice = forward(reversed, filter);
  const result = twice.reverse();

  return result.slice(padLen, padLen + n);
}

/** Extensión por reflexión impar: 2·x[0] − x[k] al inicio, análogo al final. */
function oddPad(x: number[], padLen: number): number[] {
  const n = x.length;
  const head = new Array<number>(padLen);
  const tail = new Array<number>(padLen);
  const first = x[0]!;
  const last = x[n - 1]!;
  for (let i = 0; i < padLen; i++) {
    head[i] = 2 * first - x[padLen - i]!;
    tail[i] = 2 * last - x[n - 2 - i]!;
  }
  return [...head, ...x, ...tail];
}
