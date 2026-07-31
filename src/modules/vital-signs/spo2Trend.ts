/**
 * TENDENCIA RELATIVA DE OXIGENACIÓN — lo único que el hardware sostiene.
 *
 * ── Por qué no hay número absoluto ────────────────────────────────────────
 *
 * La saturación no se puede derivar del cociente de cocientes por teoría. La
 * ley de Beer-Lambert NO aplica: el tejido es un medio dispersor, y esa
 * dispersión hace imposible determinar SaO₂ a partir de R directamente. Por eso
 * **todo oxímetro se calibra empíricamente**: se mide R simultáneamente con
 * gasometría arterial en voluntarios sometidos a hipoxia controlada, y de ahí
 * sale una curva de regresión.
 *
 * Sin esa curva, cualquier constante que convierta R en un porcentaje está
 * inventada. Este módulo existe porque en el código había uno:
 *
 *     SpO2 = 104 − 7.5·R − 3.5·R²
 *
 * Esos coeficientes no provienen de ninguna calibración de este dispositivo.
 *
 * Y aunque se calibrara: el mejor estudio publicado de oximetría por cámara de
 * teléfono (hipoxia inducida, npj Digital Medicine 2022) reporta **ARMS 5,55 %**
 * frente al **3,5 %** que exige la ISO 80601-2-61 para uso clínico. Los equipos
 * homologados están en 2–3 %. El valor absoluto no es alcanzable con esta óptica.
 *
 * ── Qué sí es medible ─────────────────────────────────────────────────────
 *
 * El propio R es una medición real: cociente de las relaciones AC/DC entre
 * canales. Lo que no se puede es traducirlo a un porcentaje absoluto sin curva.
 *
 * Pero su **variación dentro de una misma medición** sí es informativa, porque
 * los factores que impiden la traducción absoluta —dispersión del tejido,
 * pigmentación, geometría del contacto, respuesta espectral de la cámara— son
 * aproximadamente CONSTANTES durante esa medición. Se cancelan al comparar
 * contra la propia línea base del usuario.
 *
 * Relación de signo: R sube cuando la saturación baja (el rojo se absorbe más
 * al desoxigenarse la hemoglobina). Así que ΔR positivo = tendencia a la baja.
 *
 * ── Lo que este módulo NO afirma ──────────────────────────────────────────
 *
 * No dice cuánta saturación hay ni cuánto cambió en puntos porcentuales. Dice
 * si, respecto de su propio inicio, la señal se mueve hacia menos oxigenación,
 * hacia más, o se mantiene — y con cuánta confianza.
 */

import { clamp } from '../../utils/math';

/** Muestras estables necesarias para fijar la línea base. */
const BASELINE_SAMPLES = 12;

/** Muestras necesarias para emitir tendencia tras la línea base. */
const TREND_SAMPLES = 8;

/**
 * Umbral de cambio relativo en R para declarar una tendencia, como fracción de
 * la dispersión de la propia línea base. Un cambio menor que la variabilidad
 * basal del usuario no se distingue del ruido, así que no se reporta.
 */
const TREND_SIGMA_MULTIPLE = 2;

export type Spo2TrendDirection = 'RISING' | 'FALLING' | 'STABLE' | 'UNKNOWN';

export interface Spo2Trend {
  direction: Spo2TrendDirection;
  /**
   * Magnitud del cambio en desviaciones estándar de la línea base.
   * 0 si no hay tendencia establecida. No son puntos de saturación.
   */
  sigmas: number;
  /** Confianza [0,1] derivada de cuántas muestras sostienen la estimación. */
  confidence: number;
  /** Si ya hay línea base fijada. */
  baselineReady: boolean;
}

const UNKNOWN: Spo2Trend = {
  direction: 'UNKNOWN',
  sigmas: 0,
  confidence: 0,
  baselineReady: false,
};

/**
 * Acumulador de tendencia para UNA medición.
 *
 * Se reinicia con cada medición a propósito: la línea base solo tiene sentido
 * dentro de una sesión con la misma geometría de contacto. Comparar contra la
 * línea base de ayer, con el dedo puesto de otra forma, no significa nada.
 */
export class Spo2TrendTracker {
  private baseline: number[] = [];
  private baselineMean = 0;
  private baselineStd = 0;
  private baselineReady = false;
  private recent: number[] = [];

  /**
   * Incorpora una nueva medición de R.
   *
   * @param rValue Cociente de cocientes medido. Debe ser finito y positivo;
   *   cualquier otra cosa se descarta sin alterar el estado.
   */
  push(rValue: number): Spo2Trend {
    if (!Number.isFinite(rValue) || rValue <= 0) return this.current();

    if (!this.baselineReady) {
      this.baseline.push(rValue);
      if (this.baseline.length >= BASELINE_SAMPLES) {
        this.baselineMean = mean(this.baseline);
        this.baselineStd = std(this.baseline, this.baselineMean);
        this.baselineReady = true;
      }
      return this.current();
    }

    this.recent.push(rValue);
    if (this.recent.length > TREND_SAMPLES) this.recent.shift();
    return this.current();
  }

  current(): Spo2Trend {
    if (!this.baselineReady) {
      return {
        ...UNKNOWN,
        confidence: clamp(this.baseline.length / BASELINE_SAMPLES, 0, 0.99),
      };
    }
    if (this.recent.length < TREND_SAMPLES) {
      return {
        direction: 'UNKNOWN',
        sigmas: 0,
        confidence: clamp(this.recent.length / TREND_SAMPLES, 0, 0.99),
        baselineReady: true,
      };
    }

    // Mediana reciente frente a la media basal, en unidades de la dispersión
    // basal. Usar la propia variabilidad del usuario como vara evita fijar un
    // umbral absoluto que no significaría lo mismo en dos personas.
    const recentMedian = median(this.recent);
    const denom = Math.max(this.baselineStd, 1e-6);
    const sigmas = (recentMedian - this.baselineMean) / denom;

    // Si la dispersión basal fue prácticamente nula, cualquier cambio da un
    // número enorme de sigmas y no significa nada. No se opina.
    if (this.baselineStd <= 1e-6) {
      return { direction: 'STABLE', sigmas: 0, confidence: 0.3, baselineReady: true };
    }

    let direction: Spo2TrendDirection = 'STABLE';
    if (sigmas > TREND_SIGMA_MULTIPLE) {
      // R sube ⇒ menos oxigenación.
      direction = 'FALLING';
    } else if (sigmas < -TREND_SIGMA_MULTIPLE) {
      direction = 'RISING';
    }

    return {
      direction,
      sigmas,
      confidence: clamp(0.5 + Math.min(1, Math.abs(sigmas) / 4) * 0.5, 0, 1),
      baselineReady: true,
    };
  }

  reset(): void {
    this.baseline = [];
    this.baselineMean = 0;
    this.baselineStd = 0;
    this.baselineReady = false;
    this.recent = [];
  }
}

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const v of xs) s += v;
  return xs.length ? s / xs.length : 0;
}

function std(xs: readonly number[], mu: number): number {
  if (xs.length < 2) return 0;
  let acc = 0;
  for (const v of xs) acc += (v - mu) ** 2;
  return Math.sqrt(acc / (xs.length - 1));
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
