/**
 * PPG 3D PROJECTION — Capa de profundidad real para el monitor cardíaco.
 *
 * Render en CANVAS 2D PURO con proyección en perspectiva (modelo pinhole / ley 1/z).
 * Implementa dos elementos validados de visualización 3D:
 *   1) GRILLA-PISO en perspectiva (técnica "outrun/synthwave floor"): las filas de
 *      profundidad se comprimen hacia un horizonte y las columnas de tiempo convergen
 *      a un punto de fuga → profundidad real.
 *   2) ONDA como CINTA 3D EXTRUIDA (ribbon): cresta frontal honesta + cara lateral
 *      hacia el piso + cara superior con grosor en profundidad + sombra proyectada.
 *
 * CLAVE: la onda NO se recalcula. Reusa EXACTAMENTE las mismas coordenadas honestas
 * (`coords`) que produce el render 2D (mismo gate de strength, misma agudeza ^1.75,
 * misma marcación de arritmia, mismo barrido temporal). El 3D es sólo presentación:
 * la actividad cardíaca del dedo se representa idéntica al modo 2D.
 *
 * Sin dependencias de Three.js / React-Three-Fiber (no compilan en móvil, son pesadas).
 * Sólo importa el TIPO del renderer (erased en runtime) → sin ciclos de import.
 */
import { WINDOW_MS, type PpgRenderState } from './ppgCanvasRenderer';

/** Fuente monoespaciada (misma familia que el renderer 2D). */
const FONT = '"SF Mono", Consolas, "Roboto Mono", monospace';

/** Coordenada honesta de la onda, idéntica a la que arma `drawSignal` en 2D. */
export interface WaveCoord {
  x: number;
  y: number;
  isArr: boolean;
  val: number;
}

/** Geometría 2D de la zona de onda, para recuperar amplitud normalizada y tiempo. */
export interface WaveGeom {
  waveBaseY: number;
  waveH: number;
  midValue: number;
}

/** Punto proyectado en pantalla + escala de perspectiva en esa profundidad. */
interface ProjPoint {
  x: number;
  y: number;
  scale: number;
}

export interface Projector {
  horizonY: number;
  nearY: number;
  vpX: number;
  plotX: number;
  plotW: number;
  zNear: number;
  zFar: number;
  /** Altura en pantalla (px) del piso visible: nearY - horizonY. */
  floorSpanY: number;
  /**
   * Proyecta un punto del escenario:
   *  - u  [0..1] eje lateral/tiempo (0 = izquierda/antiguo, 1 = derecha/reciente)
   *  - d  [0..1] profundidad (0 = cerca/frente, 1 = lejos/horizonte)
   *  - h  [0..1] altura sobre el piso (0 = piso, 1 = altura máxima)
   */
  project: (u: number, d: number, h: number) => ProjPoint;
  scaleAt: (d: number) => number;
  /**
   * Proyecta un punto del PISO en coordenadas-mundo:
   *  - xWorld: desplazamiento lateral en px-a-distancia-cercana (0 = centro)
   *  - zWorld: profundidad real [zNear..zFar]
   * Las unidades de xWorld y de la profundidad comparten escala → celdas cuadradas.
   */
  floorPoint: (xWorld: number, zWorld: number) => ProjPoint;
}

// === Calibración de la cámara virtual ===========================================
const Z_NEAR = 1;
const Z_FAR = 5.2; // compresión de profundidad (mayor = horizonte más comprimido)
// Grilla más GRANDE: horizonte subido (más piso visible) y margen inferior menor.
const HORIZON_FRAC = 0.08; // horizonte más alto → piso (grilla) más grande
const NEAR_MARGIN_PX = 30; // sitio para el tacograma + etiquetas de tiempo del eje
const MAX_LIFT_FRAC = 0.62; // altura máx. de la onda como fracción del piso visible
// Banda de profundidad que ocupa la cinta de onda (grosor 3D real del trazo).
const WAVE_D_FRONT = 0.05;
const WAVE_D_BACK = 0.17;

// Paleta local (evita import de valores desde el renderer → sin ciclo en runtime).
const C = {
  signal: '34, 197, 94', // verde ECG
  signalBright: '74, 222, 128',
  arr: '239, 68, 68',
  cyan: '0, 242, 255',
  horizon: '103, 232, 249',
  gridMinor: '255, 255, 255', // líneas de grilla BLANCAS
};

export function makeProjector(state: PpgRenderState): Projector {
  const { plot } = state.layout;
  const intensity = clamp(state.threeD?.intensity ?? 1, 0.6, 1.4);

  const horizonY = plot.y + plot.h * HORIZON_FRAC;
  const nearY = plot.y + plot.h - NEAR_MARGIN_PX;
  const vpX = plot.x + plot.w * 0.5;
  const floorSpanY = Math.max(40, nearY - horizonY);
  const maxLift = floorSpanY * MAX_LIFT_FRAC * intensity;

  const zAt = (d: number) => Z_NEAR + clamp(d, 0, 1) * (Z_FAR - Z_NEAR);
  const scaleAt = (d: number) => Z_NEAR / zAt(d); // 1 cerca → pequeño lejos

  const project = (u: number, d: number, h: number): ProjPoint => {
    const s = scaleAt(d);
    // Ensanchar horizontalmente de manera sutil la visualización (factor 1.12) sin alterar la perspectiva 3D vertical
    const x = vpX + (u - 0.5) * plot.w * 1.12 * s;
    const groundY = horizonY + floorSpanY * s; // s=1 → nearY ; s→0 → horizonY
    const y = groundY - h * maxLift * s;
    return { x, y, scale: s };
  };

  const floorPoint = (xWorld: number, zWorld: number): ProjPoint => {
    const s = Z_NEAR / zWorld;
    // Aplicamos el mismo factor de ensanchado (1.12) para mantener la grilla y la onda perfectamente sincronizadas
    return { x: vpX + xWorld * 1.12 * s, y: horizonY + floorSpanY * s, scale: s };
  };

  return {
    horizonY,
    nearY,
    vpX,
    plotX: plot.x,
    plotW: plot.w,
    zNear: Z_NEAR,
    zFar: Z_FAR,
    floorSpanY,
    project,
    scaleAt,
    floorPoint,
  };
}

/**
 * Dibuja la GRILLA-PISO en perspectiva (reemplaza `drawECGGrid` cuando 3D está activo).
 * Mantiene la semántica ECG (líneas mayores/menores) pero con profundidad real.
 */
export function drawGrid3D(ctx: CanvasRenderingContext2D, state: PpgRenderState): void {
  const proj = makeProjector(state);
  const { plot } = state.layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // Fondo NEGRO sólido detrás de la grilla.
  ctx.fillStyle = '#000000';
  ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

  // Línea de horizonte (tenue, marca el punto de fuga).
  ctx.strokeStyle = `rgba(${C.gridMinor}, 0.35)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.x, proj.horizonY);
  ctx.lineTo(plot.x + plot.w, proj.horizonY);
  ctx.stroke();

  // === GRILLA CUADRADA en perspectiva (baldosas) — celdas GRANDES =============
  // Celda en unidades-mundo (= px en el borde cercano), MISMA medida en ancho (X)
  // y en profundidad (Z) → celdas cuadradas que se escorzan hacia el horizonte.
  // Menos columnas = celdas más grandes. Líneas mayores cada 5 (estilo papel ECG).
  const TARGET_COLS = 11;
  const cellPx = proj.plotW / TARGET_COLS;
  const halfCols = Math.ceil(TARGET_COLS / 2);
  const halfX = halfCols * cellPx;
  const dZ = cellPx / proj.floorSpanY; // paso de profundidad = ancho de celda → cuadrada

  // Filas (Z constante): cuadradas cerca, agrupándose al horizonte. Se cortan cuando
  // dos filas quedan a < 2 px (evita el moiré en la lejanía).
  let rowIdx = 0;
  let prevRowY = Number.POSITIVE_INFINITY;
  for (let z = proj.zNear; z <= proj.zFar + 1e-6; z += dZ, rowIdx++) {
    const a = proj.floorPoint(-halfX, z);
    if (prevRowY - a.y < 2) break;
    const b = proj.floorPoint(halfX, z);
    const isMajor = rowIdx % 5 === 0;
    const fade = 0.3 + 0.7 * a.scale;
    const alpha = (isMajor ? 0.55 : 0.25) * fade;
    ctx.strokeStyle = `rgba(${C.gridMinor}, ${alpha.toFixed(3)})`;
    ctx.lineWidth = isMajor ? 1.2 : 0.7;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    prevRowY = a.y;
  }

  // Columnas (X constante): separadas cellPx en mundo → convergen al punto de fuga.
  for (let k = -halfCols; k <= halfCols; k++) {
    const xw = k * cellPx;
    const near = proj.floorPoint(xw, proj.zNear);
    const far = proj.floorPoint(xw, proj.zFar);
    const isMajor = k % 5 === 0;
    const g = ctx.createLinearGradient(near.x, near.y, far.x, far.y);
    g.addColorStop(0, `rgba(${C.gridMinor}, ${isMajor ? 0.55 : 0.25})`);
    g.addColorStop(1, `rgba(${C.gridMinor}, 0.05)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = isMajor ? 1.1 : 0.65;
    ctx.beginPath();
    ctx.moveTo(near.x, near.y);
    ctx.lineTo(far.x, far.y);
    ctx.stroke();
  }

  // Borde frontal (baseline cero, resaltado).
  const fl = proj.floorPoint(-halfX, proj.zNear);
  const fr = proj.floorPoint(halfX, proj.zNear);
  ctx.strokeStyle = `rgba(${C.signal}, 0.55)`;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(fl.x, fl.y);
  ctx.lineTo(fr.x, fr.y);
  ctx.stroke();

  // Referencias numéricas de los ejes (amplitud + tiempo).
  drawGridReferences3D(ctx, proj, plot, state.amplitudeStats);

  ctx.restore();
}

/** Etiquetas numéricas de los ejes: amplitud (a.u.) a la izquierda y tiempo (-Ns) al frente. */
function drawGridReferences3D(
  ctx: CanvasRenderingContext2D,
  proj: Projector,
  plot: { x: number; y: number; w: number; h: number },
  stats: { min: number; max: number; range: number },
): void {
  const range = stats.range > 1 ? stats.range : 1;

  // Escala de amplitud (unidades PPG) en el lado izquierdo, alturas h = 1..0.
  ctx.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const h = 1 - i / 4;
    const val = stats.max - (i / 4) * range;
    const p = proj.project(0, WAVE_D_FRONT, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x + 2, p.y);
    ctx.lineTo(plot.x + 8, p.y);
    ctx.stroke();
    ctx.font = `bold 10px ${FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(val.toFixed(0), plot.x + 10, p.y + 3);
  }

  // Marcas de tiempo en el borde cercano (-0s … -Ns); lo reciente a la derecha.
  const seconds = Math.floor(WINDOW_MS / 1000);
  ctx.font = `bold 10px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  for (let sBack = 0; sBack <= seconds; sBack++) {
    const u = 1 - (sBack * 1000) / WINDOW_MS;
    const xWorld = (u - 0.5) * proj.plotW;
    const p = proj.floorPoint(xWorld, proj.zNear);
    ctx.fillText(`-${sBack}s`, p.x, proj.nearY + 13);
  }
}

/**
 * Dibuja la ONDA como cinta 3D extruida sobre el piso en perspectiva.
 * Consume las MISMAS `coords` honestas del render 2D — la forma, la amplitud y el
 * tiempo son idénticos; sólo cambia la proyección.
 */
export function drawWaveRibbon3D(
  ctx: CanvasRenderingContext2D,
  state: PpgRenderState,
  coords: WaveCoord[],
  geom: WaveGeom,
): void {
  if (coords.length < 2 || geom.waveH <= 0) return;
  const proj = makeProjector(state);
  const { plot } = state.layout;
  const revealed = state.traceRevealed;

  // Amplitud normalizada honesta con soporte para valores negativos por debajo de la grilla (piso)
  const hOf = (c: WaveCoord) => clamp(c.val / ((state.waveGain || 4.2) * 10.0), -0.5, 1.2) + 0.25;
  const uOf = (c: WaveCoord) => clamp((c.x - plot.x) / plot.w, 0, 1);

  const Pf: ProjPoint[] = []; // cresta frontal (la onda honesta)
  const Pb: ProjPoint[] = []; // cresta trasera (grosor de la cinta)
  const Pfloor: ProjPoint[] = []; // huella en el piso (sombra)
  for (const c of coords) {
    const u = uOf(c);
    const h = hOf(c);
    Pf.push(proj.project(u, WAVE_D_FRONT, h));
    Pb.push(proj.project(u, WAVE_D_BACK, h));
    Pfloor.push(proj.project(u, WAVE_D_FRONT, 0));
  }
  const n = Pf.length;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1) Sombra/huella en el piso segmentada por arritmia (normal=verde, arr=rojo).
  if (revealed) {
    let s = 0;
    while (s < n - 1) {
      const isArr = coords[s].isArr;
      let e = s;
      while (e < n - 1 && coords[e].isArr === isArr) e++;
      const col = isArr ? C.arr : C.signal;
      ctx.beginPath();
      ctx.moveTo(Pfloor[s].x, Pfloor[s].y);
      for (let i = s; i < e; i++) ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
      ctx.strokeStyle = `rgba(${col}, ${isArr ? 0.35 : 0.12})`;
      ctx.lineWidth = isArr ? 8 : 6;
      ctx.shadowColor = `rgba(${col}, ${isArr ? 0.30 : 0.05})`;
      ctx.shadowBlur = isArr ? 12 : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;
      s = e;
    }
  }

  // 1b) Rayos rojos de arritmia desde el piso hacia la fuga (punto de fuga vpX, horizonY).
  if (revealed) {
    for (let i = 0; i < n; i++) {
      if (!coords[i].isArr) continue;
      const p = Pfloor[i];
      const dx = proj.vpX - p.x;
      const dy = proj.horizonY - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;
      const nx = dx / dist, ny = dy / dist;
      const fade = Math.min(1, (p.y - proj.horizonY) / (proj.nearY - proj.horizonY));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + nx * dist, p.y + ny * dist);
      ctx.strokeStyle = `rgba(${C.arr}, ${(0.08 + 0.12 * fade).toFixed(3)})`;
      ctx.lineWidth = 1.5 + 1.5 * fade;
      ctx.stroke();
    }
  }

  // 2) Cara superior de la cinta (entre cresta frontal y trasera) → grosor 3D.
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(Pf[0].x, Pf[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(Pb[i].x, Pb[i].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(${C.signalBright}, 0.16)`;
    ctx.fill();
  }

  // 3) Cara frontal (pared vertical de la cresta al piso) con degradado.
  const wallGrad = ctx.createLinearGradient(0, proj.horizonY, 0, proj.nearY);
  wallGrad.addColorStop(0, `rgba(${C.signal}, ${revealed ? 0.34 : 0.12})`);
  wallGrad.addColorStop(1, `rgba(${C.signal}, 0.02)`);
  ctx.beginPath();
  ctx.moveTo(Pfloor[0].x, Pfloor[0].y);
  for (let i = 0; i < n; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
  ctx.closePath();
  ctx.fillStyle = wallGrad;
  ctx.fill();

  // 3b) Sobre-pintado rojo translúcido en segmentos de arritmia.
  let s = 0;
  while (s < n) {
    if (!coords[s].isArr) { s++; continue; }
    let e = s;
    while (e < n && coords[e].isArr) e++;
    ctx.beginPath();
    ctx.moveTo(Pfloor[s].x, Pfloor[s].y);
    for (let i = s; i < e; i++) ctx.lineTo(Pf[i].x, Pf[i].y);
    for (let i = e - 1; i >= s; i--) ctx.lineTo(Pfloor[i].x, Pfloor[i].y);
    ctx.closePath();
    ctx.fillStyle = `rgba(${C.arr}, 0.50)`;
    ctx.fill();
    s = e;
  }

  // 4) Cresta trasera (tenue, da volumen).
  if (revealed) {
    ctx.beginPath();
    ctx.moveTo(Pb[0].x, Pb[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(Pb[i].x, Pb[i].y);
    ctx.strokeStyle = `rgba(${C.signal}, 0.28)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 5) Cresta frontal: la onda honesta con suavizado por curvas cuadráticas
  //    entre puntos medios. NO altera picos (los máximos/mínimos siguen siendo
  //    los mismos puntos, se pasan como puntos de control), pero elimina el
  //    aspecto poligonal/"robótico" del `lineTo` recto.
  //
  //    IMPORTANTE: usamos SIEMPRE el mismo trazado (misma silueta) para:
  //      - la sombra base (silueta desplazada y difuminada),
  //      - el glow tenue de fondo,
  //      - el brillo del tramo reciente,
  //      - la cresta nítida en primer plano.
  //    Esto garantiza que la sombra respete al 100% la silueta de la onda.
  const traceCrestPath = (startIdx: number, endIdx: number) => {
    if (endIdx - startIdx < 2) {
      if (endIdx > startIdx) {
        ctx.moveTo(Pf[startIdx].x, Pf[startIdx].y);
        ctx.lineTo(Pf[endIdx].x, Pf[endIdx].y);
      }
      return;
    }
    ctx.moveTo(Pf[startIdx].x, Pf[startIdx].y);
    for (let k = startIdx; k < endIdx - 1; k++) {
      const xc = (Pf[k].x + Pf[k + 1].x) * 0.5;
      const yc = (Pf[k].y + Pf[k + 1].y) * 0.5;
      ctx.quadraticCurveTo(Pf[k].x, Pf[k].y, xc, yc);
    }
    ctx.lineTo(Pf[endIdx - 1].x, Pf[endIdx - 1].y);
  };

  // Recorre segmentos homogéneos (normal / arritmia) y ejecuta un callback
  // por segmento con sus índices — evita duplicar la lógica de partición.
  const forEachSegment = (fn: (startIdx: number, endEnd: number, isArr: boolean) => void) => {
    let s = 0;
    while (s < n - 1) {
      const isArr = coords[s].isArr;
      let segEnd = s;
      while (segEnd < n - 1 && coords[segEnd].isArr === isArr) segEnd++;
      fn(s, segEnd + 1, isArr);
      s = segEnd;
    }
  };

  // 5a) SOMBRA SILUETA — una única pasada bajo la onda que sigue exactamente su
  //     contorno (misma curva), con un desplazamiento sutil hacia abajo/derecha
  //     y un blur amplio. Esto reemplaza los múltiples `shadowBlur` por trazo
  //     (que causaban parpadeo y sombras "de contorno" no orgánicas).
  if (revealed) {
    ctx.save();
    ctx.translate(1.2, 2.4);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    forEachSegment((s0, e0) => {
      ctx.beginPath();
      traceCrestPath(s0, e0);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.lineWidth = 3.2;
      ctx.stroke();
    });
    ctx.restore();
  }

  // 5b) Glow base tenue (toda la línea) — un solo pase, sin `shadowBlur` por
  //     segmento; el aura la aporta la sombra silueta anterior.
  forEachSegment((s0, e0, isArr) => {
    ctx.beginPath();
    traceCrestPath(s0, e0);
    ctx.strokeStyle = revealed
      ? (isArr ? `rgba(${C.arr}, 0.42)` : `rgba(${C.signal}, 0.48)`)
      : 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 2.4;
    ctx.stroke();
  });

  if (revealed) {
    const recentCut = Math.max(0, n - Math.floor(n * 0.35));
    const leadingCut = Math.max(0, n - Math.floor(n * 0.10));

    // 5c) Refuerzo del tramo reciente (últ. 35%): línea más nítida, sin blur.
    forEachSegment((s0, e0, isArr) => {
      const a = Math.max(s0, recentCut);
      if (a >= e0 - 1) return;
      ctx.beginPath();
      traceCrestPath(a, e0);
      ctx.strokeStyle = isArr ? `rgba(${C.arr}, 0.85)` : `rgba(${C.signalBright}, 0.9)`;
      ctx.lineWidth = 1.7;
      ctx.stroke();
    });

    // 5d) Cabeza líder (últ. 10%) — brillo cyan/blanco muy sutil.
    forEachSegment((s0, e0, isArr) => {
      const a = Math.max(s0, leadingCut);
      if (a >= e0 - 1) return;
      ctx.beginPath();
      traceCrestPath(a, e0);
      ctx.strokeStyle = isArr ? `rgb(${C.arr})` : '#ffffff';
      ctx.lineWidth = 1.3;
      ctx.stroke();
    });
  } else {
    // Trazo de punta tenue sin brillo cuando se está estabilizando
    const leadingCut = Math.max(0, n - Math.floor(n * 0.10));
    if (leadingCut < n - 1) {
      ctx.beginPath();
      traceCrestPath(leadingCut, n);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.lineWidth = 2.0;
      ctx.stroke();
    }
  }


  // 6) Marcadores fiduciales con VALORES en tiempo real: picos máximos (SYS),
  //    valles mínimos (DIA), muesca dícrota (DIC) y etiquetas de arritmia (ARR).
  if (revealed) {
    const quality = state.props.quality ?? 0;
    ctx.textAlign = 'center';
    for (let i = 2; i < n - 2; i++) {
      const v = coords[i].val;
      const isArr = coords[i].isArr;
      const prev = coords[i - 1].val;
      const next = coords[i + 1].val;
      const prev2 = coords[i - 2].val;
      const next2 = coords[i + 2].val;
      const p = Pf[i];

      // Pico sistólico (máximo local) → punto + valor + etiqueta SYS/ARR.
      if (v > prev && v > next && v > prev2 && v > next2 && v > geom.midValue) {
        const r = 2.6 + p.scale * 1.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isArr ? `rgb(${C.arr})` : '#ffffff';
        ctx.shadowColor = isArr ? `rgb(${C.arr})` : `rgb(${C.cyan})`;
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.font = `bold 9px ${FONT}`;
        ctx.fillStyle = isArr ? `rgb(${C.arr})` : `rgb(${C.cyan})`;
        ctx.fillText(v.toFixed(1), p.x, p.y - 11);
        ctx.font = `7px ${FONT}`;
        ctx.fillStyle = isArr ? '#fecaca' : 'rgba(255, 255, 255, 0.75)';
        ctx.fillText(isArr ? 'ARR' : 'SYS', p.x, p.y - 21);
        if (isArr) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${C.arr}, 0.65)`;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
      }

      // Valle diastólico (mínimo local) → anillo + valor + etiqueta DIA.
      if (v < prev && v < next && v < prev2 && v < next2 && v < geom.midValue) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.font = `bold 9px ${FONT}`;
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(v.toFixed(1), p.x, p.y + 15);
        ctx.font = `7px ${FONT}`;
        ctx.fillText('DIA', p.x, p.y + 24);
      }

      // Muesca dícrota (DIC) → punto + etiqueta si la calidad es alta.
      const d1Curr = v - prev;
      const d1Next = next - v;
      if (d1Curr < 0 && d1Next > d1Curr && d1Next < 0 && v > geom.midValue) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(103, 232, 249, 0.6)';
        ctx.fill();
        if (quality > 70) {
          ctx.font = `7px ${FONT}`;
          ctx.fillStyle = 'rgba(103, 232, 249, 0.85)';
          ctx.fillText('DIC', p.x, p.y - 7);
        }
      }
    }
  }

  // 7) Halo pulsátil en la punta conductora (cresta más reciente).
  const head = Pf[n - 1];
  const headArr = coords[n - 1].isArr;
  const pulse = Math.max(state.sweepPulse, 0.04);
  ctx.beginPath();
  ctx.arc(head.x, head.y, (6 + pulse * 8) * (0.7 + 0.3 * head.scale), 0, Math.PI * 2);
  ctx.fillStyle = revealed
    ? headArr ? `rgba(${C.arr}, 0.3)` : `rgba(${C.cyan}, 0.3)`
    : 'rgba(148, 163, 184, 0.18)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(head.x, head.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.restore();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
