import type { PpgRenderState } from './ppgCanvasRenderer';

/**
 * VENTANA DE DEDO — guía de colocación como "susurro visual".
 *
 * Filosofía (prioridad absoluta de las ondas):
 *   1. Las sondas y el monitor cardíaco MANDAN. Esta guía se dibuja SIEMPRE
 *      por debajo de la onda (en la capa de señal, antes de drawSignal) y con
 *      alphas mínimos → nunca compite con el trazo. La onda pasa "por encima"
 *      y hasta atraviesa los huecos que la guía deja a las 3 y 9 en punto.
 *   2. No es un semáforo on/off. Guía de verdad, con DATOS REALES:
 *        - coverageRatio  → cuánto falta cubrir el lente (aro que se completa)
 *        - perfusionIndex → presión: si aprieta de más, invita a aflojar
 *        - motionScore    → si tiembla, pide sostener quieto
 *        - underexposure  → si está oscuro/flojo, pide más contacto
 *        - acquisitionProgress → progreso REAL de estabilización
 *   3. Delicada y sofisticada: elipse acostada sobre la grilla, respiración
 *      lenta, invitación que atrae la yema al centro, y silencio total cuando
 *      la señal ya es estable (solo un latido casi imperceptible).
 *
 * La geometría (FINGER_WINDOW) es la ÚNICA fuente de verdad, compartida entre
 * la máscara CSS (abre la transparencia hacia la cámara) y este dibujo.
 */
export const FINGER_WINDOW = {
  /** Centro X como fracción del ancho. */
  cxFrac: 0.5,
  /** Centro Y como fracción del alto — levemente arriba del medio. */
  cyFrac: 0.44,
  /** Radio horizontal útil ≈ yema de dedo. */
  rx: 98,
  /** Radio vertical achatado (perspectiva ≈ 0.55 → "acostado" en el piso). */
  ry: 54,
  /** Radios exteriores del feather de la máscara (borde sin corte duro). */
  featherRx: 146,
  featherRy: 84,
} as const;

/** Máscara CSS elíptica: transparencia centrada + feather muy suave. */
export function fingerWindowMaskCss(): string {
  const { cxFrac, cyFrac, featherRx, featherRy } = FINGER_WINDOW;
  const at = `at ${cxFrac * 100}% ${cyFrac * 100}%`;
  return (
    `radial-gradient(ellipse ${featherRx}px ${featherRy}px ${at}, ` +
    `rgba(0,0,0,0.26) 0%, rgba(0,0,0,0.30) 46%, rgba(0,0,0,0.42) 67%, ` +
    `rgba(0,0,0,0.78) 86%, rgba(0,0,0,1) 100%)`
  );
}

// ── Paleta delicada (RGB sin alpha; el alpha se aplica por elemento) ────────
const COL = {
  invite: '129, 187, 248', // azul suave — invitación / búsqueda
  locking: '250, 204, 120', // ámbar tenue — estabilizando
  good: '110, 231, 160', // verde señal — contacto sano
  warn: '248, 180, 120', // ámbar cálido — corrección (presión/movimiento)
} as const;

const TAU = Math.PI * 2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function num(d: Record<string, unknown> | undefined, key: string): number {
  const v = d?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Mezcla dos colores "r,g,b" por t∈[0,1]. */
function mix(a: string, b: string, t: number): string {
  const pa = a.split(',').map(Number);
  const pb = b.split(',').map(Number);
  return `${Math.round(lerp(pa[0], pb[0], t))},${Math.round(
    lerp(pa[1], pb[1], t),
  )},${Math.round(lerp(pa[2], pb[2], t))}`;
}

interface Placement {
  hasFinger: boolean;
  coverage: number; // 0..1
  perfusion: number; // fracción pequeña (~0.001..0.02)
  motion: number; // 0..1 (mayor = más temblor)
  under: number; // 0..1 subexposición
  progress: number; // 0..1 estabilización
  ready: boolean;
  /** Calidad global de colocación 0..1 (funde los elementos ruidosos). */
  quality: number;
  /** Sugerencia accionable (o null = silencio). */
  hint: string | null;
}

function readPlacement(state: PpgRenderState): Placement {
  const p = state.props;
  const diag = p.diagnostics as unknown as Record<string, unknown> | undefined;
  const sqm = diag?.sqm as Record<string, unknown> | undefined;

  const hasFinger = !!p.isFingerDetected;
  const coverage = clamp01(num(diag, 'coverageRatio'));
  const perfusion = p.perfusionIndex ?? 0;
  const motion = clamp01(num(sqm, 'motionScore'));
  const under = clamp01(num(sqm, 'underexposureRatio'));
  const progress = clamp01(num(diag, 'acquisitionProgress'));
  const ready = diag?.acquisitionStage === 'READY';

  // Calidad de colocación: cubre bien + perfunde + quieto.
  const perfQ = clamp01(perfusion / 0.008);
  const quality = hasFinger
    ? clamp01(0.45 * coverage + 0.4 * perfQ + 0.15 * (1 - motion))
    : 0;

  // Sugerencia accionable — una sola, priorizada, y solo si hace falta.
  let hint: string | null = null;
  if (!hasFinger) {
    hint = 'apoyá la yema en el lente';
  } else if (coverage < 0.55) {
    hint = 'cubrí bien el lente';
  } else if (motion > 0.55) {
    hint = 'sostené el dedo quieto';
  } else if (coverage > 0.7 && perfusion > 0 && perfusion < 0.0025) {
    hint = 'aflojá un poco la presión';
  } else if (under > 0.45) {
    hint = 'apoyá con un poco más de firmeza';
  }
  // En señal estable: silencio (salvo que algo crítico rompa la calidad).
  if (ready && quality > 0.6) hint = null;

  return { hasFinger, coverage, perfusion, motion, under, progress, ready, quality, hint };
}

/** Punto sobre la elipse (ángulo desde +X, horario en pantalla). */
function ellipsePt(cx: number, cy: number, rx: number, ry: number, a: number) {
  return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
}

/**
 * Dibuja un arco elíptico como segmentos, dejando HUECOS cerca de las 3 y 9 en
 * punto (donde corre horizontalmente la onda) para que el trazo "pase" por la
 * guía sin chocarla. `from`/`span` en radianes; `gap` = semiancho del hueco.
 */
function softArc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  span: number,
  gap: number,
) {
  const steps = Math.max(24, Math.round((Math.abs(span) / TAU) * 96));
  const gapSin = Math.sin(gap);
  let drawing = false;
  for (let i = 0; i <= steps; i++) {
    const a = from + (span * i) / steps;
    // Hueco cerca del eje horizontal (3 y 9 en punto) → deja pasar la onda.
    const inGap = Math.abs(Math.sin(a)) < gapSin;
    if (inGap) {
      drawing = false;
      continue;
    }
    const pt = ellipsePt(cx, cy, rx, ry, a);
    if (!drawing) {
      ctx.moveTo(pt.x, pt.y);
      drawing = true;
    } else {
      ctx.lineTo(pt.x, pt.y);
    }
  }
}

/** Dibuja una elipse completa como trazo suave con huecos para la onda. */
function ring(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  gap: number,
  color: string,
  alpha: number,
  lineWidth: number,
) {
  if (alpha <= 0.002) return;
  ctx.strokeStyle = `rgba(${color},${alpha.toFixed(3)})`;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  softArc(ctx, cx, cy, rx, ry, -Math.PI / 2, TAU, gap);
  ctx.stroke();
}

export function drawFingerWindow3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
): void {
  const { width, height } = state.layout;
  const now = state.now;
  const cx = width * FINGER_WINDOW.cxFrac;
  const cy = height * FINGER_WINDOW.cyFrac;
  const { rx, ry } = FINGER_WINDOW;
  const gap = 0.30; // hueco angular a las 3 y 9 en punto → pasa la onda

  const pl = readPlacement(state);

  // Color: sin dedo→azul; corrigiendo→ámbar cálido; estabilizando→ámbar→verde.
  let baseCol: string;
  if (!pl.hasFinger) baseCol = COL.invite;
  else if (pl.hint) baseCol = COL.warn;
  else if (pl.ready) baseCol = COL.good;
  else baseCol = mix(COL.locking, COL.good, pl.quality);

  const breath = 0.5 + 0.5 * Math.sin(now / 1400);
  // presencia global: la guía se apaga a medida que la colocación mejora.
  const presence = pl.ready ? 0.14 : lerp(1, 0.2, pl.quality);
  // necesidad de invitación: máxima sin dedo o con poca cobertura.
  const need = pl.hasFinger ? clamp01((0.7 - pl.quality) / 0.7) : 1;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // ── 1. RECESIÓN: vignette elíptico que hunde el centro (marco oscuro suave
  //       alrededor de la ventana). Da el efecto de "pozo" bajo el piso. ─────
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const vig = ctx.createRadialGradient(0, 0, rx * 0.55, 0, 0, rx * 1.75);
  vig.addColorStop(0, 'rgba(2,6,12,0)');
  vig.addColorStop(0.72, `rgba(2,6,12,${(0.34 * presence).toFixed(3)})`);
  vig.addColorStop(1, 'rgba(2,6,12,0)');
  ctx.fillStyle = vig;
  ctx.beginPath();
  ctx.arc(0, 0, rx * 1.75, 0, TAU);
  ctx.fill();

  // Brillo central del fondo del pozo (muy tenue) — "acá va la yema".
  const glowA = (0.06 + breath * 0.035) * presence;
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 0.95);
  glow.addColorStop(0, `rgba(${baseCol},${glowA.toFixed(3)})`);
  glow.addColorStop(0.6, `rgba(${baseCol},${(glowA * 0.4).toFixed(3)})`);
  glow.addColorStop(1, `rgba(${baseCol},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, rx * 0.95, 0, TAU);
  ctx.fill();
  ctx.restore();

  // ── 2. EMBUDO: anillos concéntricos que se cierran hacia el centro (paredes
  //       del pozo en perspectiva). Los más internos, más juntos y tenues. ──
  const funnel = [1.06, 0.86, 0.68, 0.52, 0.38];
  for (let i = 0; i < funnel.length; i++) {
    const f = funnel[i];
    const a = (0.05 + 0.02 * i) * presence; // se aclara hacia afuera
    ring(ctx, cx, cy, rx * f, ry * f, gap, baseCol, a, 1);
  }

  // ── 3. ONDAS CONVERGENTES: ripples que viajan HACIA el centro para atraer
  //       la yema. Solo cuando falta colocar; se apagan al estabilizar. ─────
  if (need > 0.03) {
    const RIPPLES = 3;
    for (let i = 0; i < RIPPLES; i++) {
      const phase = ((now / 2600 + i / RIPPLES) % 1); // 0→1
      const r = lerp(1.18, 0.32, phase); // de afuera hacia adentro
      const env = Math.sin(phase * Math.PI); // fade en extremos
      const a = 0.12 * env * need * presence;
      ring(ctx, cx, cy, rx * r, ry * r, gap, baseCol, a, 1.1);
    }
  }

  // ── 4. ARO-OBJETIVO + COBERTURA REAL (cuánto falta cubrir el lente) ──────
  // Objetivo (borde de la ventana), tenue.
  ring(ctx, cx, cy, rx, ry, gap, baseCol, (0.14 + breath * 0.04) * presence, 1.2);
  if (pl.hasFinger) {
    const cov = clamp01(pl.coverage);
    // Fantasma del objetivo de cobertura.
    ring(ctx, cx, cy, rx * 0.9, ry * 0.9, gap, baseCol, 0.06 * presence, 2);
    // Parte cubierta (se llena desde arriba).
    if (cov > 0.02) {
      ctx.strokeStyle = `rgba(${baseCol},${(0.42 * lerp(1, 0.4, pl.quality)).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      softArc(ctx, cx, cy, rx * 0.9, ry * 0.9, -Math.PI / 2, TAU * cov, gap);
      ctx.stroke();
    }
  }

  // ── 5. PROGRESO REAL de estabilización (aro exterior fino) ───────────────
  if (pl.hasFinger && !pl.ready && pl.progress > 0.01) {
    const col = mix(COL.locking, COL.good, pl.progress);
    ctx.strokeStyle = `rgba(${col},${(0.3 * presence + 0.08).toFixed(3)})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    softArc(ctx, cx, cy, rx * 1.16, ry * 1.16, -Math.PI / 2, TAU * pl.progress, gap);
    ctx.stroke();
  }

  // ── 6. LATIDO casi imperceptible en señal estable ────────────────────────
  if (pl.ready && state.sweepPulse > 0.04) {
    const k = state.sweepPulse;
    ring(ctx, cx, cy, rx * (1 + (1 - k) * 0.08), ry * (1 + (1 - k) * 0.08), gap, COL.good, 0.16 * k, 1 + k * 0.8);
  }

  // ── 7. MICRO-GUÍA textual: susurrada, minúscula, solo si hay algo que hacer.
  if (pl.hint) {
    const a = 0.32 + breath * 0.12;
    ctx.font = '500 10.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = `rgba(${baseCol},${a.toFixed(3)})`;
    ctx.fillText(pl.hint, cx, cy + ry + 18);
  }

  ctx.restore();
}
