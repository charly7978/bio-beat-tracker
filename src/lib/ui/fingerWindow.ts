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

export function drawFingerWindow3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
): void {
  const { width, height } = state.layout;
  const now = state.now;
  const cx = width * FINGER_WINDOW.cxFrac;
  const cy = height * FINGER_WINDOW.cyFrac;
  const { rx, ry } = FINGER_WINDOW;

  const pl = readPlacement(state);

  // Color según situación: sin dedo→azul; corrigiendo→ámbar cálido;
  // estabilizando→ámbar; bueno/ready→verde. Transición continua por calidad.
  let baseCol: string;
  if (!pl.hasFinger) baseCol = COL.invite;
  else if (pl.hint) baseCol = COL.warn;
  else if (pl.ready) baseCol = COL.good;
  else baseCol = mix(COL.locking, COL.good, pl.quality);

  // Respiración lenta (nunca estático) y desvanecimiento global: cuanto mejor
  // la colocación, más se apaga la guía → cede el escenario a la onda.
  const breath = 0.5 + 0.5 * Math.sin(now / 1100);
  const presence = pl.ready ? 0.12 : lerp(1, 0.18, pl.quality); // 1=necesita guía

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // ── 1. Pozo de guía: glow central suave que dice "acá va el dedo" ─────────
  // Achatado a la elipse; alpha ínfimo, se desvanece al estabilizar.
  const wellA = (0.05 + breath * 0.03) * presence;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const well = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 1.15);
  well.addColorStop(0, `rgba(${baseCol},${wellA.toFixed(3)})`);
  well.addColorStop(0.55, `rgba(${baseCol},${(wellA * 0.5).toFixed(3)})`);
  well.addColorStop(1, `rgba(${baseCol},0)`);
  ctx.fillStyle = well;
  ctx.beginPath();
  ctx.arc(0, 0, rx * 1.15, 0, TAU);
  ctx.fill();
  ctx.restore();

  // ── 2. Aro-objetivo tenue (dónde apoyar), con huecos para la onda ────────
  const gap = 0.26; // ~15° de hueco a cada lado del eje horizontal
  const ringA = (0.12 + breath * 0.04) * presence;
  ctx.strokeStyle = `rgba(${baseCol},${ringA.toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  softArc(ctx, cx, cy, rx, ry, -Math.PI / 2, TAU, gap);
  ctx.stroke();

  // ── 3. Aro de COBERTURA (la guía real de "cuánto falta"): se completa con
  //       coverageRatio. El resto queda como fantasma para ver el objetivo. ──
  if (pl.hasFinger) {
    const cov = clamp01(pl.coverage);
    // Fantasma del objetivo completo (muy tenue).
    ctx.strokeStyle = `rgba(${baseCol},${(0.06 * presence).toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    softArc(ctx, cx, cy, rx * 0.82, ry * 0.82, -Math.PI / 2, TAU, gap);
    ctx.stroke();
    // Parte cubierta (se llena desde arriba).
    if (cov > 0.02) {
      ctx.strokeStyle = `rgba(${baseCol},${(0.5 * lerp(1, 0.35, pl.quality)).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      softArc(ctx, cx, cy, rx * 0.82, ry * 0.82, -Math.PI / 2, TAU * cov, gap);
      ctx.stroke();
    }
  }

  // ── 4. Invitación convergente: 4 chevrons finísimos que "respiran" hacia
  //       el centro cuando falta colocar. Atraen la yema. Se apagan al mejorar.
  const inviteStrength = pl.hasFinger ? clamp01(0.6 - pl.coverage) : 1;
  if (inviteStrength > 0.02) {
    const pull = 0.12 * (0.5 + 0.5 * Math.sin(now / 620)); // respiración hacia dentro
    const aInv = (0.14 * inviteStrength) * presence;
    ctx.strokeStyle = `rgba(${baseCol},${aInv.toFixed(3)})`;
    ctx.lineWidth = 1.1;
    for (let i = 0; i < 4; i++) {
      // Cardinales, pero salteando el eje horizontal (deja pasar la onda).
      const a = -Math.PI / 2 + (i * Math.PI) / 2;
      if (Math.abs(Math.sin(a)) < 0.2) continue; // omite 3 y 9 en punto
      const rOut = 1.12 - pull;
      const rIn = 0.98 - pull;
      const tip = ellipsePt(cx, cy, rx * rIn, ry * rIn, a);
      const l = ellipsePt(cx, cy, rx * rOut, ry * rOut, a - 0.12);
      const r = ellipsePt(cx, cy, rx * rOut, ry * rOut, a + 0.12);
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(r.x, r.y);
      ctx.stroke();
    }
  }

  // ── 5. Progreso REAL de estabilización: aro fino levemente exterior ──────
  if (pl.hasFinger && !pl.ready && pl.progress > 0.01) {
    const col = mix(COL.locking, COL.good, pl.progress);
    ctx.strokeStyle = `rgba(${col},0.32)`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    softArc(ctx, cx, cy, rx * 1.12, ry * 1.12, -Math.PI / 2, TAU * pl.progress, gap);
    ctx.stroke();
  }

  // ── 6. Latido casi imperceptible cuando la señal es estable ──────────────
  if (pl.ready && state.sweepPulse > 0.04) {
    const k = state.sweepPulse;
    const grow = 1 + (1 - k) * 0.1;
    ctx.strokeStyle = `rgba(${COL.good},${(0.16 * k).toFixed(3)})`;
    ctx.lineWidth = 1 + k * 0.8;
    ctx.beginPath();
    softArc(ctx, cx, cy, rx * grow, ry * grow, -Math.PI / 2, TAU, gap);
    ctx.stroke();
  }

  // ── 7. Micro-guía textual: susurrada, minúscula, solo si hay algo que hacer.
  if (pl.hint) {
    const a = (0.34 + breath * 0.12) * (pl.hasFinger ? 1 : 1.1);
    ctx.font = '500 10.5px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = `rgba(${baseCol},${a.toFixed(3)})`;
    // debajo de la ventana, fuera del corredor de la onda.
    ctx.fillText(pl.hint, cx, cy + ry + 16);
  }

  ctx.restore();
}
