import React, { useEffect, useRef } from 'react';

interface PoincarePlotProps {
  rrIntervals: number[];
  width?: number;
  height?: number;
}

export const PoincarePlot: React.FC<PoincarePlotProps> = ({
  rrIntervals,
  width = 240,
  height = 240,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Ajustar resolución por DPI de pantalla
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    // Limpiar canvas
    ctx.fillStyle = '#020617'; // bg-slate-950
    ctx.fillRect(0, 0, width, height);

    // Filtrar intervalos RR fisiológicos (ej. 300ms a 1500ms)
    const validRR = rrIntervals.filter((rr) => rr >= 300 && rr <= 1500);

    if (validRR.length < 2) {
      // Dibujar estado de datos insuficientes
      ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Datos de ritmo insuficientes', width / 2, height / 2);
      ctx.fillText('para graficar Poincaré', width / 2, height / 2 + 16);
      return;
    }

    // Generar pares RR_i vs RR_i+1
    const pairs: { x: number; y: number }[] = [];
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (let i = 0; i < validRR.length - 1; i++) {
      const x = validRR[i];
      const y = validRR[i + 1];
      pairs.push({ x, y });
      minVal = Math.min(minVal, x, y);
      maxVal = Math.max(maxVal, x, y);
    }

    // Establecer límites de escala con margen
    const padding = 100; // ms
    const minScale = Math.max(300, minVal - padding);
    const maxScale = Math.min(1500, maxVal + padding);
    const range = maxScale - minScale;

    // Funciones de mapeo de ms a píxeles
    const plotMargin = 28;
    const plotW = width - plotMargin * 2;
    const plotH = height - plotMargin * 2;

    const toX = (val: number) => {
      const pct = (val - minScale) / range;
      return plotMargin + pct * plotW;
    };

    const toY = (val: number) => {
      const pct = (val - minScale) / range;
      // Invertir Y para que valores mayores estén arriba
      return plotMargin + (1 - pct) * plotH;
    };

    // 1. Dibujar cuadricula de fondo y límites
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.25)'; // slate-700/25
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const val = minScale + (range / steps) * i;
      const x = toX(val);
      const y = toY(val);

      // Líneas verticales
      ctx.beginPath();
      ctx.moveTo(x, plotMargin);
      ctx.lineTo(x, height - plotMargin);
      ctx.stroke();

      // Líneas horizontales
      ctx.beginPath();
      ctx.moveTo(plotMargin, y);
      ctx.lineTo(width - plotMargin, y);
      ctx.stroke();

      // Etiquetas de los ejes
      ctx.fillStyle = '#64748b'; // slate-500
      ctx.font = '8px monospace';
      ctx.setLineDash([]);
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(val)}`, x, height - plotMargin + 10);
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(val)}`, plotMargin - 4, y + 3);
      ctx.setLineDash([4, 4]);
    }
    ctx.setLineDash([]);

    // Dibujar etiquetas de los ejes
    ctx.font = 'bold 8px sans-serif';
    ctx.fillStyle = '#94a3b8'; // slate-400
    ctx.textAlign = 'center';
    ctx.fillText('RR n (ms)', width / 2, height - 4);
    ctx.save();
    ctx.translate(6, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('RR n+1 (ms)', 0, 0);
    ctx.restore();

    // 2. Dibujar Línea de Identidad (Identidad Diagonal x = y)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)'; // slate-400/15
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(toX(minScale), toY(minScale));
    ctx.lineTo(toX(maxScale), toY(maxScale));
    ctx.stroke();

    // 3. Calcular métricas SD1 y SD2 de HRV
    let sumDiffSq = 0;
    let sumSumSq = 0;
    const n = pairs.length;

    // Calcular medias
    let sumX = 0;
    let sumY = 0;
    for (const p of pairs) {
      sumX += p.x;
      sumY += p.y;
    }
    const meanX = sumX / n;
    const meanY = sumY / n;

    // Desviaciones cuadráticas
    for (const p of pairs) {
      const diff = p.x - p.y;
      const sumTerm = p.x + p.y - (meanX + meanY);
      sumDiffSq += diff * diff;
      sumSumSq += sumTerm * sumTerm;
    }

    const sd1 = Math.sqrt((sumDiffSq / (2 * n)));
    const sd2 = Math.sqrt((sumSumSq / (2 * n)));

    // 4. Dibujar Elipse de Confianza Poincaré (si hay suficientes puntos)
    if (n >= 4) {
      ctx.save();
      // El centro de la elipse es el centro geométrico de los puntos (meanX, meanY)
      const cx = toX(meanX);
      const cy = toY(meanY);

      // El ángulo de rotación de la elipse es siempre 45 grados (-pi/4 en coordenadas del canvas)
      ctx.translate(cx, cy);
      ctx.rotate(-Math.PI / 4);

      // Escalar ms a píxeles de longitud
      const pixelPerMs = plotW / range;
      const rx = sd2 * pixelPerMs; // Semieje mayor a lo largo de la diagonal (SD2)
      const ry = sd1 * pixelPerMs; // Semieje menor perpendicular (SD1)

      // Dibujar la elipse de dispersión
      ctx.strokeStyle = 'rgba(139, 92, 246, 0.4)'; // violet-500/40
      ctx.fillStyle = 'rgba(139, 92, 246, 0.05)'; // violet-500/5
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Mostrar valores SD1/SD2 en la esquina superior izquierda
      ctx.fillStyle = 'rgba(139, 92, 246, 0.85)';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`SD1 (corto plazo): ${Math.round(sd1)}ms`, plotMargin + 4, plotMargin + 10);
      ctx.fillText(`SD2 (largo plazo): ${Math.round(sd2)}ms`, plotMargin + 4, plotMargin + 20);
    }

    // 5. Dibujar los Puntos del Gráfico de Poincaré
    pairs.forEach((p, idx) => {
      const x = toX(p.x);
      const y = toY(p.y);

      // Calcular si el punto es un outlier o latido irregular (diferencia > 20% de la media)
      const isIrregular = Math.abs(p.x - p.y) > meanX * 0.15;

      ctx.beginPath();
      ctx.arc(x, y, isIrregular ? 3.5 : 2.5, 0, Math.PI * 2);
      
      if (isIrregular) {
        ctx.fillStyle = '#ef4444'; // red-500 para latidos irregulares
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        // Degradado de color según el índice temporal para ver la evolución
        const progress = idx / pairs.length;
        ctx.fillStyle = `rgb(${Math.floor(34 + progress * 70)}, ${Math.floor(197 - progress * 40)}, ${Math.floor(94 + progress * 140)})`; // emerald a cyan
      }
      ctx.fill();
    });

  }, [rrIntervals, width, height]);

  return (
    <div className="relative flex flex-col items-center justify-center p-2 bg-slate-950 border border-slate-800 rounded-xl overflow-hidden shadow-lg shadow-purple-950/10">
      <div className="text-[10px] font-bold text-purple-400 tracking-wider mb-1 uppercase">
        Espacio HRV (Gráfico de Poincaré)
      </div>
      <canvas ref={canvasRef} className="rounded-lg" />
      <div className="text-[8px] text-slate-500 mt-1 max-w-[200px] text-center leading-normal">
        Los puntos sobre la línea diagonal indican regularidad cardíaca. La dispersión transversal representa HRV rápida.
      </div>
    </div>
  );
};
