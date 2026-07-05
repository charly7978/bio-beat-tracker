import type { PpgRenderState } from './ppgCanvasRenderer';

/**
 * VENTANA DE DEDO 3D — plataforma-objetivo en perspectiva.
 *
 * No es un adorno: es el instrumento de guiado para la colocación exacta del
 * dedo sobre el lente. La ventana es una ELIPSE en perspectiva (como si el
 * círculo estuviera acostado sobre el piso-grilla del monitor, no parado de
 * frente tapando las ondas) y toda su gráfica reacciona en vivo al estado
 * real del sistema:
 *
 *   - sin dedo        → cian, radar de invitación girando lento
 *   - estabilizando   → ámbar, arco de progreso real (acquisitionProgress)
 *   - señal estable   → verde, casi invisible (silencio visual) y pulsando
 *                        con cada latido real (sweepPulse)
 *
 * La geometría es la ÚNICA fuente de verdad compartida entre la máscara CSS
 * (que abre la transparencia hacia la cámara) y el dibujo canvas de la guía:
 * si se mueve una, se mueve la otra.
 */
export const FINGER_WINDOW = {
  /** Centro X como fracción del ancho de pantalla. */
  cxFrac: 0.5,
  /** Centro Y como fracción del alto — levemente arriba del centro. */
  cyFrac: 0.44,
  /** Radio horizontal útil ≈ yema de dedo. */
  rx: 96,
  /** Radio vertical achatado (foreshortening ≈ 0.56 → "acostado" en el piso). */
  ry: 54,
  /** Radios exteriores del feather de la máscara (transición sin borde duro). */
  featherRx: 134,
  featherRy: 76,
} as const;

/** Máscara CSS elíptica: transparencia centrada + feather suave. */
export function fingerWindowMaskCss(): string {
  const { cxFrac, cyFrac, featherRx, featherRy } = FINGER_WINDOW;
  const at = `at ${cxFrac * 100}% ${cyFrac * 100}%`;
  // Los % de los stops se miden sobre el tamaño declarado de la elipse
  // (featherRx × featherRy). Zona útil ≈ 70% (= rx/featherRx).
  return (
    `radial-gradient(ellipse ${featherRx}px ${featherRy}px ${at}, ` +
    `rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.33) 48%, rgba(0,0,0,0.46) 70%, ` +
    `rgba(0,0,0,0.84) 88%, rgba(0,0,0,1) 100%)`
  );
}

type WindowMode = 'invite' | 'locking' | 'locked';

const MODE_COLOR: Record<WindowMode, string> = {
  invite: '0, 242, 255', // cian del horizonte del monitor
  locking: '251, 191, 36', // ámbar
  locked: '74, 222, 128', // verde señal
};

const MODE_LABEL: Record<WindowMode, string> = {
  invite: 'APOYE LA YEMA AQUÍ',
  locking: 'MANTENGA EL DEDO QUIETO',
  locked: '',
};

function ellipsePoint(cx: number, cy: number, rx: number, ry: number, t: number) {
  return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
}

export function drawFingerWindow3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
): void {
  const { width, height } = state.layout;
  const p = state.props;
  const now = state.now;

  const cx = width * FINGER_WINDOW.cxFrac;
  const cy = height * FINGER_WINDOW.cyFrac;
  const { rx, ry } = FINGER_WINDOW;

  const stage = p.diagnostics?.acquisitionStage;
  const progress = Math.max(0, Math.min(1, p.diagnostics?.acquisitionProgress ?? 0));
  const mode: WindowMode = !p.isFingerDetected
    ? 'invite'
    : stage === 'READY'
      ? 'locked'
      : 'locking';
  const col = MODE_COLOR[mode];

  // Respiración lenta (modula alphas para que se sienta vivo, nunca estático).
  const breath = 0.5 + 0.5 * Math.sin(now / 900);

  ctx.save();
  ctx.lineCap = 'round';

  // ── Asiento: halo elíptico que "apoya" la plataforma sobre la grilla ─────
  const seat = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx * 1.3);
  const seatAlpha = mode === 'locked' ? 0.05 : 0.09 + breath * 0.04;
  seat.addColorStop(0, 'rgba(0,0,0,0)');
  seat.addColorStop(0.72, 'rgba(0,0,0,0)');
  seat.addColorStop(0.86, `rgba(${col}, ${seatAlpha.toFixed(3)})`);
  seat.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = seat;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx); // el gradiente circular se achata a la elipse
  ctx.translate(-cx, -cy);
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 1.3, rx * 1.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ── Canto frontal (grosor de la plataforma: media elipse inferior +3px) ──
  ctx.strokeStyle = `rgba(${col}, ${mode === 'locked' ? 0.06 : 0.14})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 3, rx, ry, 0, 0.08 * Math.PI, 0.92 * Math.PI);
  ctx.stroke();

  // ── Aro exterior ──────────────────────────────────────────────────────────
  const outerAlpha =
    mode === 'invite' ? 0.30 + breath * 0.14 :
    mode === 'locking' ? 0.45 :
    0.14;
  ctx.strokeStyle = `rgba(${col}, ${outerAlpha.toFixed(3)})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();

  // ── Aro interior (zona de contacto ideal) ────────────────────────────────
  ctx.strokeStyle = `rgba(${col}, ${(outerAlpha * 0.55).toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx * 0.62, ry * 0.62, 0, 0, Math.PI * 2);
  ctx.stroke();

  // ── Marcas radiales (12, cardinales más largas) ──────────────────────────
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    const cardinal = i % 3 === 0;
    const a = ellipsePoint(cx, cy, rx * (cardinal ? 0.84 : 0.90), ry * (cardinal ? 0.84 : 0.90), t);
    const b = ellipsePoint(cx, cy, rx * 0.97, ry * 0.97, t);
    ctx.strokeStyle = `rgba(${col}, ${(outerAlpha * (cardinal ? 0.9 : 0.5)).toFixed(3)})`;
    ctx.lineWidth = cardinal ? 1.2 : 0.75;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // ── Radar de invitación / búsqueda (gira sobre la elipse) ────────────────
  if (mode !== 'locked') {
    const speed = mode === 'invite' ? 2600 : 1300;
    const t0 = ((now % speed) / speed) * Math.PI * 2;
    ctx.strokeStyle = `rgba(${col}, 0.75)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, t0, t0 + Math.PI * 0.35);
    ctx.stroke();
  }

  // ── Arco de progreso REAL de estabilización (no decorativo) ──────────────
  if (mode === 'locking' && progress > 0.01) {
    const start = -Math.PI / 2;
    ctx.strokeStyle = `rgba(${col}, 0.9)`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 1.06, ry * 1.06, 0, start, start + Math.PI * 2 * progress);
    ctx.stroke();
  }

  // ── Latido: la plataforma pulsa con cada pico cardíaco real ──────────────
  if (mode === 'locked' && state.sweepPulse > 0.03) {
    const k = state.sweepPulse; // 1 en el pico → decae por frame
    const grow = 1 + (1 - k) * 0.16;
    ctx.strokeStyle = `rgba(${col}, ${(0.4 * k).toFixed(3)})`;
    ctx.lineWidth = 1.5 + k;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * grow, ry * grow, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ── Etiqueta de estado (debajo de la plataforma, estilo monitor) ─────────
  const label = MODE_LABEL[mode];
  if (label) {
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = `rgba(${col}, ${(0.55 + breath * 0.25).toFixed(3)})`;
    ctx.fillText(label, cx, cy + ry + 14);
  }

  ctx.restore();
}
