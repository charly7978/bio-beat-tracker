import type { PpgRenderState } from './ppgCanvasRenderer';

/**
 * VENTANA DE DEDO — instrumento sutil de colocación.
 *
 * Reglas duras:
 *   1. El MONITOR CARDÍACO es prioridad visual. Toda alpha usada acá vive
 *      debajo de MAX_ALPHA para que ni el "brillo del fondo" supere la
 *      luminosidad de las ondas. La guía se dibuja ANTES de la grilla y las
 *      sondas → siempre queda hundida en el piso; nunca por encima.
 *   2. La luz que ilumina el círculo sube desde el CENTRO del fondo, como si
 *      viniera del interior del monitor, y se detiene en un techo bajo.
 *   3. Rojo (color de sangre) es LO DE MENOS — solo aparece como
 *      advertencia física ("aflojá la presión") a nivel casi imperceptible.
 *   4. Nada es on/off: todo se apaga/enciende con datos reales
 *      (coverageRatio, perfusionIndex, motionScore, underexposureRatio,
 *      acquisitionProgress) y con animaciones suavizadas por frame.
 *
 * Novedad: cuando el usuario **encuentra la posición correcta** (cobertura
 * alta + quieto + perfusión detectable, sostenido ≥400 ms), en el círculo
 * se materializa una HUELLA DACTILAR procedural (arcos concéntricos con
 * núcleo y deltas, tipo whorl/loop) con fade-in animado — la señal exacta
 * de "acá está bien". Al perder la posición, se desmaterializa suavemente.
 */

// ── Geometría (fuente única de verdad para máscara y dibujo) ────────────────
export const FINGER_WINDOW = {
  cxFrac: 0.5,
  cyFrac: 0.44,
  rx: 100,
  ry: 56,
  featherRx: 150,
  featherRy: 86,
} as const;

/** Techo de brillo global de la guía — ninguna alpha lo supera. */
const MAX_ALPHA = 0.28;

/** Máscara CSS elíptica: transparencia centrada + feather muy suave. */
export function fingerWindowMaskCss(): string {
  const { cxFrac, cyFrac, featherRx, featherRy } = FINGER_WINDOW;
  const at = `at ${cxFrac * 100}% ${cyFrac * 100}%`;
  return (
    `radial-gradient(ellipse ${featherRx}px ${featherRy}px ${at}, ` +
    `rgba(0,0,0,0.24) 0%, rgba(0,0,0,0.30) 46%, rgba(0,0,0,0.44) 68%, ` +
    `rgba(0,0,0,0.80) 88%, rgba(0,0,0,1) 100%)`
  );
}

// ── Paleta: neutra, sin rojo protagónico ───────────────────────────────────
const COL = {
  invite: '148, 197, 240', // azul plata — invitación
  locking: '212, 214, 200', // marfil frío — estabilizando
  good: '154, 214, 178', // verde suave — posición correcta
  warn: '232, 196, 156', // arena — corrección
  bloodHint: '210, 128, 128', // rojo apagado — solo si perfusión colapsa
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
function mix(a: string, b: string, t: number): string {
  const pa = a.split(',').map(Number);
  const pb = b.split(',').map(Number);
  return `${Math.round(lerp(pa[0], pb[0], t))},${Math.round(
    lerp(pa[1], pb[1], t),
  )},${Math.round(lerp(pa[2], pb[2], t))}`;
}
function ellipsePt(cx: number, cy: number, rx: number, ry: number, a: number) {
  return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
}

interface Placement {
  hasFinger: boolean;
  coverage: number;
  perfusion: number;
  motion: number;
  under: number;
  progress: number;
  ready: boolean;
  quality: number;
  hint: string | null;
  /** ¿Está en la posición correcta AHORA? (gate para la huella). */
  positionOk: boolean;
  /** Si conviene mostrar el rojo apagado (colapso de perfusión). */
  bloodWarn: boolean;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
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

  const perfQ = clamp01(perfusion / 0.008);
  const quality = hasFinger
    ? clamp01(0.42 * coverage + 0.42 * perfQ + 0.16 * (1 - motion))
    : 0;

  // Posición correcta: bien cubierto, quieto, y con perfusión detectable (más permisivo).
  // Coverage > 0.55 alinea con el hint "cubrí bien el lente" y motion < 0.4 permite
  // más respiración/micromovimiento. Perfusión baja (> 0.0005) es lo real en muchos dedos.
  const positionOk =
    hasFinger && coverage > 0.55 && motion < 0.4 && perfusion > 0.0005;

  // Alerta de presión: sangre muy baja, pero ya no veda la huella (que aparece antes).
  const bloodWarn =
    hasFinger && coverage > 0.75 && perfusion > 0 && perfusion < 0.0005;

  let hint: string | null = null;
  if (!hasFinger) hint = pick(['apoyá la yema en el lente', 'colocá el dedo sobre la cámara', 'tapá el flash con la yema']);
  else if (coverage < 0.40) hint = pick(['más cobertura del lente', 'desplazá el dedo hacia el centro', 'cubrí mejor la cámara']);
  else if (coverage < 0.55) hint = pick(['cubrí bien el lente', 'casi ahí, mové un poco más', 'llená toda la superficie']);
  else if (motion > 0.55) hint = pick(['sostené el dedo quieto', 'sin mover, firme', 'tranqui, mantené el dedo estable']);
  else if (motion > 0.4) hint = pick(['menos movimiento, muy bien', 'casi perfecto, no te muevas', 'sostenelo así, sin temblar']);
  else if (bloodWarn) hint = pick(['aflojá la presión', 'presionás muy fuerte, soltá un toque', 'estás aplastando el dedo']);
  else if (perfusion < 0.001) hint = pick(['apoyá con firmeza', 'un poco más de presión', 'hacé más contacto']);
  else if (under > 0.45) hint = pick(['más presión moderada', 'apoyá un poco más', 'mejor contacto']);
  if (ready && quality > 0.6) hint = null;

  return {
    hasFinger,
    coverage,
    perfusion,
    motion,
    under,
    progress,
    ready,
    quality,
    hint,
    positionOk,
    bloodWarn,
  };
}

// ── Estado de animación persistente entre frames ────────────────────────────
// Se guarda en el `state` (que es el mismo objeto entre renders del meter).
interface FingerAnim {
  /** 0 = oculto, 1 = huella completamente materializada. */
  fingerprint: number;
  /** Ángulo actual del "cursor de búsqueda" (rotación lenta). */
  scanAngle: number;
  /** Tiempo desde el que la posición está OK sostenida (ms) — histéresis. */
  positionOkSince: number;
  /** Última marca de tiempo (para dt real). */
  lastNow: number;
  /** Presencia global suavizada (evita parpadeos). */
  presenceSmoothed: number;
  /** Anillo de arranque: pulso que aparece al detectar dedo (0→1→0). */
  contactPulse: number;
  /** Marca de la última transición hasFinger false→true. */
  contactAt: number;
  /** Recuerdo previo de hasFinger. */
  hadFingerLast: boolean;
}

function getAnim(state: PpgRenderState): FingerAnim {
  type Bag = { fingerAnim?: FingerAnim };
  const bag = state as unknown as Bag;
  if (!bag.fingerAnim) {
    bag.fingerAnim = {
      fingerprint: 0,
      scanAngle: 0,
      positionOkSince: 0,
      lastNow: state.now,
      presenceSmoothed: 1,
      contactPulse: 0,
      contactAt: 0,
      hadFingerLast: false,
    };
  }
  return bag.fingerAnim;
}

/** Aproximación crítica-amortiguada: converge a `target` con constante τ (ms). */
function approach(current: number, target: number, dt: number, tauMs: number): number {
  const k = 1 - Math.exp(-dt / Math.max(1, tauMs));
  return current + (target - current) * k;
}

/**
 * Traza un arco elíptico con HUECOS en 3 y 9 (por donde corre la onda),
 * de modo que la guía nunca compita con el trazo cardíaco.
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
  const steps = Math.max(28, Math.round((Math.abs(span) / TAU) * 128));
  const gapSin = Math.sin(gap);
  let drawing = false;
  for (let i = 0; i <= steps; i++) {
    const a = from + (span * i) / steps;
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
  if (alpha <= 0.003) return;
  ctx.strokeStyle = `rgba(${color},${Math.min(alpha, MAX_ALPHA).toFixed(3)})`;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  softArc(ctx, cx, cy, rx, ry, -Math.PI / 2, TAU, gap);
  ctx.stroke();
}

// ── HUELLA DACTILAR procedural (estilo whorl con núcleo desplazado) ─────────
/**
 * Dibuja una huella dactilar procedural centrada en (cx, cy), dimensionada
 * como la ventana, con opacidad `alpha` global (ya recortada por MAX_ALPHA).
 * No es aleatoria: es la misma huella siempre, para que se lea como *señal*
 * (aparece cuando la posición está bien) y no como ruido.
 */
function drawFingerprint(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string,
  alpha: number,
) {
  if (alpha <= 0.003) return;
  const a = Math.min(alpha, MAX_ALPHA);
  ctx.save();
  ctx.translate(cx, cy);
  // La huella "se acuesta" con la elipse.
  ctx.scale(1, ry / rx);
  ctx.strokeStyle = `rgba(${color},${a.toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';

  // 12 crestas concéntricas suavemente deformadas hacia arriba-izquierda
  // (núcleo desplazado como whorl real).
  const coreX = -rx * 0.08;
  const coreY = -rx * 0.06;
  const rings = 11;
  for (let i = 1; i <= rings; i++) {
    const t = i / (rings + 1);
    const rBase = rx * (0.16 + t * 0.72);
    // Deformación: el radio crece hacia el "delta" (abajo-derecha).
    ctx.beginPath();
    const steps = 96;
    for (let s = 0; s <= steps; s++) {
      const ang = (s / steps) * TAU;
      // Desplaza el centro efectivo hacia el núcleo, y añade un
      // "pinch" en la dirección de -π/4 para el delta.
      const pull = 0.14 * Math.cos(ang + Math.PI / 4);
      const r = rBase * (1 + pull * (1 - t) * 0.6);
      const x = coreX * (1 - t) + r * Math.cos(ang);
      const y = coreY * (1 - t) + r * Math.sin(ang);
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Delta corto: dos rayitas finas donde convergen las crestas.
  ctx.strokeStyle = `rgba(${color},${(a * 0.8).toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rx * 0.44, rx * 0.30);
  ctx.lineTo(rx * 0.62, rx * 0.42);
  ctx.moveTo(rx * 0.36, rx * 0.42);
  ctx.lineTo(rx * 0.54, rx * 0.52);
  ctx.stroke();

  // Núcleo: pequeño ojo del whorl.
  ctx.fillStyle = `rgba(${color},${(a * 0.9).toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(coreX, coreY, 2.4, 0, TAU);
  ctx.fill();

  ctx.restore();
}

// ── Dibujo principal ────────────────────────────────────────────────────────
export function drawFingerWindow3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
): void {
  const { width, height } = state.layout;
  const now = state.now;
  const cx = width * FINGER_WINDOW.cxFrac;
  const cy = height * FINGER_WINDOW.cyFrac;
  const { rx, ry } = FINGER_WINDOW;
  const gap = 0.32; // hueco angular para la onda a las 3 y 9

  const pl = readPlacement(state);
  const anim = getAnim(state);
  const dt = Math.max(0, Math.min(120, now - anim.lastNow));
  anim.lastNow = now;

  // ── Estados temporales (histéresis y suavizados) ─────────────────────────
  // Pulso de contacto: sube al 1 al detectar dedo, decae en ~700 ms.
  if (pl.hasFinger && !anim.hadFingerLast) {
    anim.contactAt = now;
    anim.contactPulse = 1;
  }
  anim.hadFingerLast = pl.hasFinger;
  anim.contactPulse = approach(anim.contactPulse, 0, dt, 400);

  // Huella: se materializa después de 300 ms de posición OK sostenida (más rápido).
  // Desmaterializa en 150 ms si se rompe (muy ágil, sigue al dedo).
  if (pl.positionOk) {
    if (anim.positionOkSince === 0) anim.positionOkSince = now;
    const held = now - anim.positionOkSince;
    // Muestra "cargando" (opacidad baja) a los 100ms, luego materializa a los 300ms.
    const target = held > 300 ? 1 : held > 100 ? 0.25 : 0;
    anim.fingerprint = approach(anim.fingerprint, target, dt, 200);
  } else {
    anim.positionOkSince = 0;
    anim.fingerprint = approach(anim.fingerprint, 0, dt, 150);
  }

  // Presencia global: se apaga a medida que la calidad crece.
  const targetPresence = pl.ready ? 0.16 : lerp(1, 0.24, pl.quality);
  anim.presenceSmoothed = approach(anim.presenceSmoothed, targetPresence, dt, 500);
  const presence = anim.presenceSmoothed;

  // Cursor de escaneo (rotación lenta y continua): 8 s por vuelta.
  anim.scanAngle = (anim.scanAngle + (dt / 8000) * TAU) % TAU;

  // Color base según necesidad — sin rojo protagónico.
  let baseCol: string;
  if (!pl.hasFinger) baseCol = COL.invite;
  else if (pl.positionOk) baseCol = COL.good;
  else if (pl.hint) baseCol = COL.warn;
  else baseCol = mix(COL.locking, COL.good, pl.quality);

  const breath = 0.5 + 0.5 * Math.sin(now / 1600);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // ── 1. LUZ QUE VIENE DEL FONDO (interior del monitor) ────────────────────
  // Vignette de recesión + brillo central. TOPE DURO de alpha (0.10).
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const vig = ctx.createRadialGradient(0, 0, rx * 0.5, 0, 0, rx * 1.8);
  vig.addColorStop(0, 'rgba(1,4,8,0)');
  vig.addColorStop(0.7, `rgba(1,4,8,${(0.26 * presence).toFixed(3)})`);
  vig.addColorStop(1, 'rgba(1,4,8,0)');
  ctx.fillStyle = vig;
  ctx.beginPath();
  ctx.arc(0, 0, rx * 1.8, 0, TAU);
  ctx.fill();

  const glowA = Math.min(MAX_ALPHA * 0.36, (0.05 + breath * 0.025) * presence);
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 1.0);
  glow.addColorStop(0, `rgba(${baseCol},${glowA.toFixed(3)})`);
  glow.addColorStop(0.55, `rgba(${baseCol},${(glowA * 0.45).toFixed(3)})`);
  glow.addColorStop(1, `rgba(${baseCol},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, rx * 1.0, 0, TAU);
  ctx.fill();
  ctx.restore();

  // ── 2. Aro-objetivo tenue + embudo (paredes del pozo) ─────────────────────
  ring(ctx, cx, cy, rx, ry, gap, baseCol, (0.13 + breath * 0.04) * presence, 1.2);
  const funnel = [0.86, 0.7, 0.55, 0.42];
  for (let i = 0; i < funnel.length; i++) {
    const f = funnel[i];
    const a = (0.04 + 0.014 * i) * presence;
    ring(ctx, cx, cy, rx * f, ry * f, gap, baseCol, a, 1);
  }

  // ── 3. Marcadores cardinales DENTRO del propio anillo (no colgados) ──────
  // 12 ticks, cardinales más largos; se apagan al mejorar la colocación.
  if (presence > 0.25) {
    const tickA = (0.10 + breath * 0.03) * presence;
    ctx.strokeStyle = `rgba(${baseCol},${Math.min(tickA, MAX_ALPHA).toFixed(3)})`;
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * TAU - Math.PI / 2;
      if (Math.abs(Math.sin(ang)) < Math.sin(gap)) continue; // deja pasar la onda
      const cardinal = i % 3 === 0;
      const rOut = 0.98;
      const rIn = cardinal ? 0.88 : 0.93;
      const p1 = ellipsePt(cx, cy, rx * rIn, ry * rIn, ang);
      const p2 = ellipsePt(cx, cy, rx * rOut, ry * rOut, ang);
      ctx.lineWidth = cardinal ? 1.1 : 0.7;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  // ── 4. CURSOR DE ESCANEO: un arco corto que rota lento, invita a apoyar.
  //       Solo cuando NO hay dedo, o cuando la posición es pobre. ───────────
  const inviteStrength = pl.hasFinger ? clamp01(0.7 - pl.quality) : 1;
  if (inviteStrength > 0.03) {
    const a = 0.16 * inviteStrength * presence;
    ctx.strokeStyle = `rgba(${baseCol},${Math.min(a, MAX_ALPHA).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    // Un arco corto (~36°) que ignora el eje horizontal para no chocar la onda.
    const from = anim.scanAngle - 0.18;
    const span = 0.36;
    ctx.beginPath();
    softArc(ctx, cx, cy, rx * 1.02, ry * 1.02, from, span, gap);
    ctx.stroke();
  }

  // ── 5. Aro de COBERTURA real (la guía verdadera del "cuánto falta") ──────
  if (pl.hasFinger) {
    const cov = clamp01(pl.coverage);
    ring(ctx, cx, cy, rx * 0.94, ry * 0.94, gap, baseCol, 0.05 * presence, 2);
    if (cov > 0.02) {
      const a = 0.32 * lerp(1, 0.5, pl.quality);
      ctx.strokeStyle = `rgba(${baseCol},${Math.min(a, MAX_ALPHA).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      softArc(ctx, cx, cy, rx * 0.94, ry * 0.94, -Math.PI / 2, TAU * cov, gap);
      ctx.stroke();
    }
  }

  // ── 6. PULSO DE CONTACTO: al detectar dedo por primera vez ───────────────
  if (anim.contactPulse > 0.02) {
    const k = anim.contactPulse;
    const grow = 1 + (1 - k) * 0.14;
    ring(
      ctx,
      cx,
      cy,
      rx * grow,
      ry * grow,
      gap,
      baseCol,
      0.22 * k * presence,
      1 + k * 0.6,
    );
  }

  // ── 7. HUELLA DACTILAR: aparece al encontrar la posición correcta ────────
  if (anim.fingerprint > 0.01) {
    // Color: verde en READY, azul/gris antes.
    const fpCol = pl.ready ? COL.good : mix(COL.invite, COL.good, pl.quality);
    // La huella respira levemente. Más opaca cuando se está cargando (0.25) para
    // que el usuario vea que está llegando a la posición correcta.
    const fpAlpha = anim.fingerprint < 0.3
      ? anim.fingerprint * (0.22 + breath * 0.08)
      : anim.fingerprint * (0.24 + breath * 0.08);
    drawFingerprint(ctx, cx, cy, rx * 0.9, ry * 0.9, fpCol, fpAlpha);
  }

  // ── 8. Progreso REAL de estabilización (aro exterior fino) ───────────────
  if (pl.hasFinger && !pl.ready && pl.progress > 0.01) {
    const col = mix(COL.locking, COL.good, pl.progress);
    ring(ctx, cx, cy, rx * 1.14, ry * 1.14, gap, col, 0.22 * presence + 0.05, 1.4);
    // Solo la porción "cubierta" del progreso:
    ctx.strokeStyle = `rgba(${col},${Math.min(0.24, MAX_ALPHA).toFixed(3)})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    softArc(ctx, cx, cy, rx * 1.14, ry * 1.14, -Math.PI / 2, TAU * pl.progress, gap);
    ctx.stroke();
  }

  // ── 9. Advertencia física de "aflojá presión" ────────────────────────────
  // Rojo apagado como último recurso, muy tenue, solo si la sangre no fluye.
  if (pl.bloodWarn) {
    const a = 0.08 * presence;
    ctx.strokeStyle = `rgba(${COL.bloodHint},${a.toFixed(3)})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    softArc(ctx, cx, cy, rx * 0.78, ry * 0.78, -Math.PI / 2, TAU, gap);
    ctx.stroke();
  }

  // ── 10. Latido casi imperceptible en señal estable ───────────────────────
  if (pl.ready && state.sweepPulse > 0.04) {
    const k = state.sweepPulse;
    ring(ctx, cx, cy, rx * (1 + (1 - k) * 0.06), ry * (1 + (1 - k) * 0.06), gap, COL.good, 0.14 * k, 1 + k * 0.6);
  }

  // ── 11. Micro-guía textual: susurrada, solo si hay algo accionable ───────
  if (pl.hint) {
    const a = 0.30 + breath * 0.10;
    ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = `rgba(${baseCol},${Math.min(a, MAX_ALPHA).toFixed(3)})`;
    ctx.fillText(pl.hint, cx, cy + ry + 18);
  }

  // ── 12. Guía grande de colocación (visible desde lejos) ──────────────────
  if (pl.hint && !pl.positionOk) {
    const guideAlpha = 0.50 + breath * 0.12;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Símbolo grande según acción
    const symbol = !pl.hasFinger ? '⊙' : pl.coverage < 0.50 ? '⊙' : pl.motion > 0.4 ? '—' : pl.bloodWarn ? '↓' : '↑';
    ctx.font = `bold 24px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = `rgba(${baseCol},${(guideAlpha * 0.6).toFixed(3)})`;
    ctx.fillText(symbol, cx, cy + ry + 38);

    ctx.restore();
  }

  ctx.restore();
}
