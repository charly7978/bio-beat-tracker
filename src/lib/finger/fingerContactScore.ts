import { clamp } from '@/utils/math';

/**
 * PRIMITIVA UNIVERSAL DE CONTACTO DEL DEDO (device-agnostic).
 *
 * Problema que resuelve: la detección por firma de hemoglobina estricta (R/G,
 * R/B, dominancia, cobertura, CV) falla en muchos teléfonos por balance de
 * blancos, geometría flash-lente o exposición → el usuario no encuentra "el
 * punto exacto". La señal física MÁS confiable de "el dedo cubre la lente + el
 * flash" es simple y robusta: TODO el cuadro se vuelve rojo profundo y UNIFORME
 * (rojo alto, verde/azul bajos, baja varianza espacial, brillo moderado).
 *
 * Este módulo produce:
 *  - {@link ContactScore.score} 0–1 continuo → alimenta el medidor de proximidad
 *    ("caliente/frío") y una compuerta de adquisición tolerante.
 *  - un {@link ContactScore.hint} de dirección/presión accionable por el usuario.
 *
 * Es puro (sin estado): la suavización temporal la hace quien lo consume.
 */
export interface ContactScoreInput {
  /** Rojo medio del ROI (0–255). */
  red: number;
  /** Verde medio del ROI (0–255). */
  green: number;
  /** Azul medio del ROI (0–255). */
  blue: number;
  /** Fracción de celdas con dedo [0..1]. */
  coverage: number;
  /**
   * Uniformidad espacial del rojo [0..1]: 1 = rojo homogéneo en todo el ROI
   * (dedo cubriendo), 0 = muy heterogéneo (escena, borde del dedo, sin dedo).
   */
  redUniformity: number;
  /**
   * Sesgo de cobertura: dirección normalizada [-1..1] hacia donde FALTA cobertura
   * de dedo (x: + = falta a la derecha; y: + = falta abajo). 0,0 = centrado.
   */
  coverageBias?: { x: number; y: number };
}

export type ContactHintKind =
  | 'none'
  | 'searching'
  | 'move-left'
  | 'move-right'
  | 'move-up'
  | 'move-down'
  | 'press-less'
  | 'press-more'
  | 'hold';

export interface ContactScore {
  /** Confianza de contacto 0–1 (continua, para el medidor de proximidad). */
  score: number;
  /** Componentes (diagnóstico/telemetría). */
  parts: {
    redness: number;
    dominance: number;
    coverage: number;
    uniformity: number;
    brightness: number;
  };
  hint: ContactHintKind;
}

/** Contacto físico presente: el dedo cubre la lente (aunque el pulso aún no sea óptimo). */
export const CONTACT_ACQUIRE_THRESHOLD = 0.6;
/** Umbral bajo para "estás cerca" (guía de proximidad templada). */
export const CONTACT_WARM_THRESHOLD = 0.32;

export function computeContactScore(input: ContactScoreInput): ContactScore {
  const r = Math.max(0, input.red);
  const g = Math.max(0, input.green);
  const b = Math.max(0, input.blue);
  const total = r + g + b;

  // Rojez relativa: r/g y r/b altos (el tejido iluminado por el flash es rojo).
  const rg = r / Math.max(1, g);
  const rb = r / Math.max(1, b);
  const redness = clamp((Math.min(rg, rb) - 1.05) / 0.85, 0, 1);

  // Dominancia absoluta del rojo sobre el promedio de verde/azul.
  const dominance = clamp((r - (g + b) / 2) / 45, 0, 1);

  // Cobertura de celdas.
  const coverage = clamp(input.coverage, 0, 1);

  // Uniformidad espacial (dedo = homogéneo).
  const uniformity = clamp(input.redUniformity, 0, 1);

  // Brillo en rango: ni negro (sin luz/dedo aplastado) ni saturado (flash directo).
  // Meseta 1.0 en [120, 470]; cae fuera. Penaliza fuerte la saturación (dedo muy
  // apretado corta el flujo y quema el sensor → PPG plano).
  let brightness: number;
  if (total < 60) brightness = clamp(total / 60, 0, 1) * 0.5;
  else if (total < 120) brightness = 0.5 + (total - 60) / 120;
  else if (total <= 470) brightness = 1;
  else brightness = clamp(1 - (total - 470) / 180, 0, 1);
  brightness = clamp(brightness, 0, 1);

  // Fusión: la rojez+dominancia+uniformidad son la firma dura de contacto; la
  // cobertura y el brillo modulan. Pesos calibrados para que un dedo real cruce
  // 0.6 con holgura y una escena cualquiera quede muy por debajo.
  const score = clamp(
    redness * 0.28 +
      dominance * 0.24 +
      uniformity * 0.22 +
      coverage * 0.16 +
      brightness * 0.1,
    0,
    1,
  );

  const hint = deriveHint({ score, total, coverage, brightness, bias: input.coverageBias });

  return {
    score,
    parts: { redness, dominance, coverage, uniformity, brightness },
    hint,
  };
}

function deriveHint(ctx: {
  score: number;
  total: number;
  coverage: number;
  brightness: number;
  bias?: { x: number; y: number };
}): ContactHintKind {
  // Sin señal roja de dedo en absoluto.
  if (ctx.score < CONTACT_WARM_THRESHOLD) return 'searching';

  // Saturado: flash directo / demasiada presión.
  if (ctx.total > 500) return 'press-less';
  // Demasiado oscuro pese a haber contacto: presiona un poco para sellar la luz.
  if (ctx.total < 90 && ctx.score >= CONTACT_WARM_THRESHOLD) return 'press-more';

  // Cerca pero descentrado: guía direccional hacia donde falta cobertura.
  if (ctx.score < CONTACT_ACQUIRE_THRESHOLD && ctx.bias) {
    const { x, y } = ctx.bias;
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    if (Math.max(ax, ay) > 0.28) {
      if (ax >= ay) return x > 0 ? 'move-right' : 'move-left';
      return y > 0 ? 'move-down' : 'move-up';
    }
  }

  // Contacto sólido → mantener.
  if (ctx.score >= CONTACT_ACQUIRE_THRESHOLD) return 'hold';

  return 'none';
}

const HINT_TEXT: Record<ContactHintKind, string> = {
  none: '',
  searching: 'Apoya la yema cubriendo la lente y el flash',
  'move-left': 'Desliza el dedo un poco a la izquierda',
  'move-right': 'Desliza el dedo un poco a la derecha',
  'move-up': 'Desliza el dedo un poco hacia arriba',
  'move-down': 'Desliza el dedo un poco hacia abajo',
  'press-less': 'Presiona más suave (aprietas demasiado)',
  'press-more': 'Presiona un poco más para sellar la luz',
  hold: 'Perfecto, mantén el dedo quieto',
};

export function contactHintText(hint: ContactHintKind): string {
  return HINT_TEXT[hint] ?? '';
}
