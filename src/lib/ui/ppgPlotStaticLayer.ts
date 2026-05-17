/**
 * Capa estática del plot PPG (fondo + cuadrícula tipo papel ECG) para cachear en
 * canvas y blitear con `drawImage` — menos trabajo por frame en móvil.
 */

export type PlotGridPalette = {
  GRID_MINOR: string;
  GRID_MAJOR: string;
  GRID_SEC: string;
  BASELINE: string;
  PANEL_BORDER: string;
};

/**
 * Dibuja en coordenadas locales (0,0)-(plotW, plotH); `centerY` suele ser plotH/2.
 */
export function drawPlotGridStaticLayer(
  ctx: CanvasRenderingContext2D,
  plotW: number,
  plotH: number,
  centerY: number,
  colors: PlotGridPalette,
): void {
  const grad = ctx.createLinearGradient(0, 0, 0, plotH);
  grad.addColorStop(0, 'rgba(6, 12, 22, 0.70)');
  grad.addColorStop(0.5, 'rgba(10, 18, 30, 0.60)');
  grad.addColorStop(1, 'rgba(6, 12, 22, 0.70)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, plotW, plotH);

  const pxPerMm = Math.max(4, Math.min(8, plotH / 30));
  const minor = pxPerMm;
  const major = pxPerMm * 5;

  ctx.strokeStyle = colors.GRID_MINOR;
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let x = 0; x <= plotW; x += minor) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, plotH);
  }
  for (let y = 0; y <= plotH; y += minor) {
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
  }
  ctx.stroke();

  ctx.strokeStyle = colors.GRID_MAJOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= plotW; x += major) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, plotH);
  }
  for (let y = 0; y <= plotH; y += major) {
    ctx.moveTo(0, y);
    ctx.lineTo(plotW, y);
  }
  ctx.stroke();

  const oneSec = 25 * pxPerMm;
  ctx.strokeStyle = colors.GRID_SEC;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let x = plotW; x >= 0; x -= oneSec) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, plotH);
  }
  ctx.stroke();

  ctx.strokeStyle = colors.BASELINE;
  ctx.lineWidth = 1;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(plotW, centerY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = colors.PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, plotW, plotH);
}

/**
 * Contexto 2D optimizado para latencia en Chrome/Android (`desynchronized`),
 * con fallback si el motor lo rechaza.
 */
export function acquireCanvas2dContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  const fast: CanvasRenderingContext2DSettings = {
    alpha: false,
    desynchronized: true,
  };
  const ctx = canvas.getContext('2d', fast) ?? canvas.getContext('2d', { alpha: false });
  return ctx;
}
