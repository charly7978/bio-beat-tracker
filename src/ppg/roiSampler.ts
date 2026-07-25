/**
 * MUESTREO DEL ROI — de píxeles a UNA muestra por cuadro.
 *
 * Lo único que este módulo hace es promediar la región central del cuadro por
 * canal. Deliberadamente NO decide si hay un dedo, no puntúa colores, no
 * clasifica escenas: esa era la arquitectura anterior, y su problema es que
 * responde a «qué tan rojo es el píxel», cosa que una pared bajo la linterna
 * satisface igual de bien que un dedo. La discriminación pertenece al dominio
 * temporal, donde vive el pulso, y se hace aguas abajo.
 *
 * ELECCIÓN DE CANAL — POR QUÉ ROJO EN CONTACTO CON LINTERNA:
 * En PPG de contacto con el dedo tapando lente y flash, el trayecto óptico es
 * de transmisión difusa a través de varios milímetros de tejido. La luz roja
 * (~660 nm) es la que penetra y vuelve con señal utilizable; verde y azul se
 * absorben casi por completo y devuelven poco más que ruido. Esto es lo
 * contrario del caso rPPG sin contacto (cámara a distancia, luz ambiente), donde
 * el verde gana porque la hemoglobina lo absorbe más y el trayecto es corto.
 * Como aquí el modo de uso es dedo sobre lente con flash, se usa ROJO como
 * fuente primaria y se conservan los tres canales para SpO2 aguas abajo.
 *
 * El ROI es un cuadrado central fijo: con el dedo cubriendo la lente, el
 * encuadre no aporta información, y un ROI adaptativo solo añade una variable
 * que puede desviarse sin que nadie lo note.
 */

export interface RoiSample {
  red: number;
  green: number;
  blue: number;
  timestampMs: number;
}

export interface RoiConfig {
  /** Fracción del lado corto usada como ROI cuadrado central (0..1). */
  sizeFraction: number;
  /** Salto de píxeles al recorrer (1 = todos). Reduce coste sin sesgar la media. */
  stride: number;
}

export const ROI_DEFAULTS: RoiConfig = {
  sizeFraction: 0.6,
  stride: 2,
};

/**
 * Promedia los canales R/G/B del ROI central de un `ImageData`.
 *
 * Devuelve medias en 0..255. No normaliza ni escala: cualquier transformación
 * pertenece al pipeline de señal, donde queda registrada y es testeable.
 */
export function sampleRoi(
  image: ImageData,
  timestampMs: number,
  config: RoiConfig = ROI_DEFAULTS,
): RoiSample {
  const { width, height, data } = image;
  const side = Math.floor(Math.min(width, height) * config.sizeFraction);
  const startX = Math.max(0, Math.floor((width - side) / 2));
  const startY = Math.max(0, Math.floor((height - side) / 2));
  const endX = Math.min(width, startX + side);
  const endY = Math.min(height, startY + side);
  const stride = Math.max(1, Math.floor(config.stride));

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  for (let y = startY; y < endY; y += stride) {
    const rowOffset = y * width;
    for (let x = startX; x < endX; x += stride) {
      const i = (rowOffset + x) * 4;
      sumR += data[i]!;
      sumG += data[i + 1]!;
      sumB += data[i + 2]!;
      count++;
    }
  }

  if (count === 0) {
    return { red: 0, green: 0, blue: 0, timestampMs };
  }
  return {
    red: sumR / count,
    green: sumG / count,
    blue: sumB / count,
    timestampMs,
  };
}

/** Rectángulo del ROI, para dibujarlo en la vista previa. */
export function roiRect(
  width: number,
  height: number,
  config: RoiConfig = ROI_DEFAULTS,
): { x: number; y: number; width: number; height: number } {
  const side = Math.floor(Math.min(width, height) * config.sizeFraction);
  return {
    x: Math.max(0, Math.floor((width - side) / 2)),
    y: Math.max(0, Math.floor((height - side) / 2)),
    width: side,
    height: side,
  };
}
