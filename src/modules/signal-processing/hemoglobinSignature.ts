/**
 * FIRMA ESPECTRAL DE LA HEMOGLOBINA — evidencia de que hay sangre pulsando.
 *
 * Responde a UNA pregunta, la que hoy el pipeline no sabe contestar:
 *
 *     ¿La variación temporal que estoy viendo la produjo hemoglobina,
 *      o la produjo cualquier otra cosa?
 *
 * ── El principio físico ────────────────────────────────────────────────────
 *
 * Cuando la sangre pulsa, la variación de color NO ocurre en una dirección
 * cualquiera del espacio RGB: ocurre a lo largo de un vector muy específico,
 * dictado por el espectro de absorción de la hemoglobina, que absorbe de forma
 * MUY distinta según la longitud de onda (fuerte alrededor de 500–600 nm,
 * mucho menos en el rojo profundo). Esa dirección se llama firma del pulso
 * sanguíneo (de Haan & van Leest 2014, ec. 7):
 *
 *          [ σ(Rn), σ(Gn), σ(Bn) ]
 *   Pbv = ───────────────────────────────
 *         √( σ(Rn)² + σ(Gn)² + σ(Bn)² )
 *
 * donde Rn, Gn, Bn son los canales normalizados temporalmente (ec. 2):
 *
 *   Xn = X/μ(X) − 1
 *
 * ── Por qué una pared no puede pasar ───────────────────────────────────────
 *
 * Una pared bajo el flash TAMBIÉN varía en el tiempo: ruido del sensor,
 * parpadeo del LED, control automático de exposición, micro-movimientos,
 * reflexión especular. Pero todas esas causas son *multiplicativas sobre la
 * intensidad*: escalan los tres canales en la misma proporción relativa.
 *
 * En el espacio normalizado eso cae exactamente sobre el eje acromático:
 *
 *   â = [1, 1, 1] / √3
 *
 * La hemoglobina NO puede caer ahí, porque absorbe selectivamente por longitud
 * de onda: por definición produce variación cromática. Entonces el ángulo entre
 * la dirección observada y el eje acromático es la prueba:
 *
 *   θ ≈ 0   →  variación de intensidad. NO es sangre.
 *   θ ≫ 0   →  variación cromática. Compatible con hemoglobina.
 *
 * Esta prueba no necesita calibración por dispositivo: el eje acromático es el
 * mismo en toda cámara. Es la hipótesis nula la que está anclada a la física,
 * no la alternativa — por eso funciona sin conocer de antemano dónde cae la
 * firma de ESTE teléfono con SU flash.
 *
 * ── Lo que este módulo NO hace ─────────────────────────────────────────────
 *
 * No afirma que haya sangre: afirma cuánta evidencia hay CONTRA la hipótesis
 * de que sea variación de intensidad. Cuando la entrada no permite decidir
 * (pocas muestras, canal saturado, variación por debajo del piso de ruido)
 * devuelve verosimilitud CERO — ni a favor ni en contra — y el motivo. No
 * inventa un veredicto donde no hay información.
 *
 * Referencia: de Haan, G. & van Leest, A. (2014). "Improved motion robustness
 * of remote-PPG by using the blood volume pulse signature." Physiological
 * Measurement 35(9), 1913–1926. DOI 10.1088/0967-3334/35/9/1913
 */

/** Nivel de píxel a partir del cual el canal se considera recortado. */
const CLIPPING_LEVEL = 250;

/**
 * Fracción de muestras recortadas tolerada antes de invalidar el canal.
 * Con el rojo saturado, σ(Rn) queda artificialmente comprimido y la dirección
 * observada se desvía del eje acromático por un motivo que NO es hemoglobina:
 * daría un falso positivo. Preferimos no opinar.
 */
const MAX_CLIPPED_FRACTION = 0.02;

/**
 * Piso de pulsatilidad relativa. Por debajo, la dirección es ruido de
 * cuantización dividido por ruido de cuantización: no significa nada.
 * 1e-4 ≈ 0.01 % de modulación, muy por debajo de cualquier perfusión real.
 */
const MIN_PULSATILE_NORM = 1e-4;

/** Mínimo de muestras para que la desviación estándar tenga sentido. */
const MIN_SAMPLES = 30;

/** Banda cardíaca útil: 36–210 lpm. */
const CARDIAC_LO_HZ = 0.6;
const CARDIAC_HI_HZ = 3.5;

/**
 * Banda de referencia de ruido: por encima de la fisiología cardíaca y sus
 * primeros armónicos, lo que queda es ruido del sensor. Sirve para medir el
 * piso de ruido de CADA canal por separado.
 */
const NOISE_LO_HZ = 5.0;


/**
 * Ángulo máximo posible respecto del eje acromático.
 * Las tres componentes son desviaciones estándar, luego no negativas: la
 * dirección vive en el octante positivo. El punto más lejano del eje
 * acromático es un vértice, p.ej. [1,0,0], y arccos(1/√3) = 54.7356°.
 * No es una constante elegida: es la geometría del problema.
 */
const THETA_MAX_RAD = Math.acos(1 / Math.sqrt(3));

const RAD_TO_DEG = 180 / Math.PI;

/** Tope de |LLR| por muestra, para que un caso extremo no domine el acumulador. */
const LLR_CLAMP = 12;

export type SignatureReason =
  | 'OK'
  | 'INSUFFICIENT_SAMPLES'
  | 'CHANNEL_CLIPPED'
  | 'BELOW_NOISE_FLOOR'
  | 'INVALID_INPUT';

export interface HemoglobinSignature {
  /**
   * Log-verosimilitud a favor de "variación cromática compatible con
   * hemoglobina" frente a "variación de intensidad".
   *   > 0 → evidencia a favor
   *   < 0 → evidencia en contra
   *   = 0 → sin información (ver `reason`)
   */
  logLikelihoodRatio: number;
  /** Ángulo con el eje acromático, en grados. 0 = intensidad pura. */
  chromaticAngleDeg: number;
  /** Dirección pulsátil observada (unitaria), o null si no se pudo calcular. */
  direction: readonly [number, number, number] | null;
  /** Norma del vector de pulsatilidades relativas (amplitud de la modulación). */
  pulsatileNorm: number;
  /** Incertidumbre angular esperada por tamaño de ventana, en grados. */
  angularUncertaintyDeg: number;
  /** Por qué no se pudo decidir, cuando corresponde. */
  reason: SignatureReason;
}

function emptyResult(reason: SignatureReason): HemoglobinSignature {
  return {
    logLikelihoodRatio: 0,
    chromaticAngleDeg: 0,
    direction: null,
    pulsatileNorm: 0,
    angularUncertaintyDeg: 0,
    reason,
  };
}

/** Media aritmética. Devuelve NaN si no hay muestras. */
function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s / xs.length;
}

/**
 * Amplitud pulsátil de un canal en la banda cardíaca, CORREGIDA por el piso de
 * ruido propio del canal.
 *
 * Por qué hace falta la corrección: el ruido del sensor es aditivo (lectura +
 * disparo), no multiplicativo. Con canales de DC distinto — típico en PPG de
 * contacto, donde el rojo satura de luz y el azul queda oscuro — un mismo ruido
 * absoluto produce pulsatilidad RELATIVA distinta en cada canal (σ/μ difiere
 * porque μ difiere). Eso imita una firma cromática y hace pasar una pared por
 * tejido. Medir la potencia solo en la banda cardíaca no alcanza: el ruido
 * blanco también tiene potencia ahí.
 *
 * La corrección estima la densidad de ruido en una banda alta —donde no hay
 * fisiología cardíaca— y le resta al canal la potencia de ruido que le
 * corresponde en la banda cardíaca. Lo que queda es pulso.
 *
 * Devuelve NaN si el canal no es utilizable.
 */
function bandPulsatility(
  xs: readonly number[],
  fs: number,
): { amplitude: number; snr: number; nCardiac: number; nNoise: number } | null {
  const n = xs.length;
  const mu = mean(xs);
  if (!Number.isFinite(mu) || mu <= 0) return null;

  // Normalización temporal (ec. 2) + ventana de Hann para limitar la fuga
  // espectral entre bandas, que si no contaminaría la estimación de ruido.
  const w = new Float64Array(n);
  let winPow = 0;
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    w[i] = (xs[i] / mu - 1) * hann;
    winPow += hann * hann;
  }
  if (winPow <= 0) return null;

  const df = fs / n;
  const binLo = Math.max(1, Math.ceil(CARDIAC_LO_HZ / df));
  const binHi = Math.min(Math.floor(n / 2) - 1, Math.floor(CARDIAC_HI_HZ / df));
  const noiseLo = Math.ceil(NOISE_LO_HZ / df);
  const noiseHi = Math.floor(n / 2) - 1;
  if (binHi <= binLo || noiseHi <= noiseLo) return null;

  // Periodograma solo en los bins que interesan (DFT parcial: más barato que
  // una FFT completa para el puñado de bins que se usan).
  const power = (k: number): number => {
    const c = (2 * Math.PI * k) / n;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const a = c * i;
      re += w[i] * Math.cos(a);
      im -= w[i] * Math.sin(a);
    }
    return (re * re + im * im) / winPow;
  };

  let cardiacPow = 0;
  for (let k = binLo; k <= binHi; k++) cardiacPow += power(k);
  let noisePow = 0;
  for (let k = noiseLo; k <= noiseHi; k++) noisePow += power(k);

  const nCardiac = binHi - binLo + 1;
  const nNoise = noiseHi - noiseLo + 1;

  // Densidad de ruido por bin, extrapolada a la banda cardíaca (ruido ~ blanco).
  const noiseInCardiac = (noisePow / nNoise) * nCardiac;
  const signalPow = cardiacPow - noiseInCardiac;
  const snr = noiseInCardiac > 0 ? signalPow / noiseInCardiac : signalPow > 0 ? Infinity : 0;

  return {
    amplitude: signalPow > 0 ? Math.sqrt(signalPow) : 0,
    snr,
    nCardiac,
    nNoise,
  };
}

/** Fracción de muestras en o por encima del nivel de recorte. */
function clippedFraction(xs: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < xs.length; i++) if (xs[i] >= CLIPPING_LEVEL) n++;
  return n / xs.length;
}

function allFinite(xs: readonly number[]): boolean {
  for (let i = 0; i < xs.length; i++) if (!Number.isFinite(xs[i])) return false;
  return true;
}

/**
 * Evalúa la firma espectral sobre una ventana de medias del ROI por canal.
 *
 * @param red          Medias del canal rojo, en orden cronológico (escala 0–255).
 * @param green        Medias del canal verde.
 * @param blue         Medias del canal azul.
 * @param sampleRateHz Frecuencia de muestreo real (fps efectivos de la cámara).
 */
export function evaluateHemoglobinSignature(
  red: readonly number[],
  green: readonly number[],
  blue: readonly number[],
  sampleRateHz: number,
): HemoglobinSignature {
  const n = red.length;
  if (n < MIN_SAMPLES || green.length !== n || blue.length !== n) {
    return emptyResult('INSUFFICIENT_SAMPLES');
  }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 2 * CARDIAC_HI_HZ) {
    // Sin margen de Nyquist sobre la banda cardíaca no hay nada que medir.
    return emptyResult('INVALID_INPUT');
  }
  if (!allFinite(red) || !allFinite(green) || !allFinite(blue)) {
    return emptyResult('INVALID_INPUT');
  }

  // Un canal recortado comprime su σ y sesga la dirección por un motivo que no
  // es óptico-fisiológico. No se opina con la entrada corrupta.
  if (
    clippedFraction(red) > MAX_CLIPPED_FRACTION ||
    clippedFraction(green) > MAX_CLIPPED_FRACTION ||
    clippedFraction(blue) > MAX_CLIPPED_FRACTION
  ) {
    return emptyResult('CHANNEL_CLIPPED');
  }

  const pr = bandPulsatility(red, sampleRateHz);
  const pg = bandPulsatility(green, sampleRateHz);
  const pb = bandPulsatility(blue, sampleRateHz);
  if (!pr || !pg || !pb) {
    return emptyResult('INVALID_INPUT');
  }

  const sr = pr.amplitude;
  const sg = pg.amplitude;
  const sb = pb.amplitude;

  const norm = Math.sqrt(sr * sr + sg * sg + sb * sb);
  if (norm < MIN_PULSATILE_NORM) {
    return emptyResult('BELOW_NOISE_FLOOR');
  }

  const direction: [number, number, number] = [sr / norm, sg / norm, sb / norm];

  // Ángulo con el eje acromático â = [1,1,1]/√3.
  const cosTheta = (direction[0] + direction[1] + direction[2]) / Math.sqrt(3);
  const theta = Math.acos(Math.min(1, Math.max(-1, cosTheta)));

  // ── Incertidumbre angular ────────────────────────────────────────────────
  //
  // La dirección se calcula a partir de tres amplitudes ESTIMADAS, y cada una
  // arrastra su propio error. Ignorar ese error fue el fallo de la primera
  // versión: al restarle a puro ruido su propio piso de ruido queda una
  // diferencia de dos números grandes ≈ 0, cuya dirección es aleatoria — y una
  // dirección aleatoria casi nunca cae sobre el eje acromático, así que el
  // ruido se hacía pasar por sangre.
  //
  // La corrección es propagar el error hasta el ángulo. Dos fuentes:
  //
  //  1. Muestreo: la potencia de banda estimada sobre nBins bins tiene error
  //     relativo ≈ 1/√nBins. Sobre la diferencia (cardíaca − ruido) se combinan
  //     ambas bandas, y el error se amplifica al dividir por la señal, es decir
  //     en proporción a 1/SNR.
  //  2. Ventana: error relativo ≈ 1/√(2N) de la propia estimación temporal.
  //
  // Amplitud = √potencia, así que el error relativo de la amplitud es la mitad
  // del error relativo de la potencia.
  const bandErr = Math.sqrt(1 / pr.nCardiac + 1 / pr.nNoise);
  const ampRelErr = (snr: number): number =>
    snr > 0 && Number.isFinite(snr) ? 0.5 * bandErr / snr : Number.POSITIVE_INFINITY;

  const eR = ampRelErr(pr.snr);
  const eG = ampRelErr(pg.snr);
  const eB = ampRelErr(pb.snr);

  // El error angular se aproxima por la media cuadrática de los errores
  // relativos de las componentes, ponderada por el peso de cada componente en
  // la dirección: una componente pequeña e incierta mueve poco el ángulo.
  const wR = direction[0];
  const wG = direction[1];
  const wB = direction[2];
  const angFromSnr = Math.sqrt(
    (wR * eR) ** 2 + (wG * eG) ** 2 + (wB * eB) ** 2,
  );
  const angFromWindow = 1 / Math.sqrt(2 * n);
  const sigma0 = Math.sqrt(angFromWindow * angFromWindow + angFromSnr * angFromSnr);

  // Si la incertidumbre angular es comparable al rango angular disponible, la
  // medición no tiene poder de resolución: no distingue nada. Devolver un
  // veredicto aquí sería inventarlo.
  if (!Number.isFinite(sigma0) || sigma0 > THETA_MAX_RAD / 3) {
    return emptyResult('BELOW_NOISE_FLOOR');
  }

  // Razón de verosimilitud.
  //   H0 (variación de intensidad): θ se concentra en 0 → media normal
  //       plegada de escala sigma0.
  //   H1 (cromática):               agnóstica sobre dónde cae exactamente la
  //       firma de este dispositivo → uniforme en [0, θmax].
  //
  // Es deliberado que la hipótesis anclada sea la NULA: sabemos con precisión
  // dónde cae la variación de intensidad (en el eje acromático, siempre, en
  // toda cámara), y no pretendemos saber aún dónde cae la hemoglobina de este
  // teléfono con su flash. Así el test no necesita calibración previa.
  //
  //   log p(θ|H1) = −log(θmax)
  //   log p(θ|H0) = log(2/(σ₀√(2π))) − θ²/(2σ₀²)
  //   LLR         = θ²/(2σ₀²) + log(σ₀√(2π)/(2·θmax))
  const llrRaw =
    (theta * theta) / (2 * sigma0 * sigma0) +
    Math.log((sigma0 * Math.sqrt(2 * Math.PI)) / (2 * THETA_MAX_RAD));

  const logLikelihoodRatio = Math.min(LLR_CLAMP, Math.max(-LLR_CLAMP, llrRaw));

  return {
    logLikelihoodRatio,
    chromaticAngleDeg: theta * RAD_TO_DEG,
    direction,
    pulsatileNorm: norm,
    angularUncertaintyDeg: sigma0 * RAD_TO_DEG,
    reason: 'OK',
  };
}
