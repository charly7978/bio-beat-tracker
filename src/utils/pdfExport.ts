/**
 * Generación de reporte PDF vía window.print().
 * Sin dependencias externas; usa una ventana nueva con estilos inline
 * y CSS @media print para generar un PDF limpio desde cualquier navegador.
 */

import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';

interface HrvSummary {
  meanHR: number;
  meanRR: number;
  sdnn: number;
  rmssd: number;
  pnn50: number;
  cv: number;
  poincare?: { sd1: number; sd2: number; sd1_sd2_ratio: number };
  frequency?: { vlf: number; lf: number; hf: number; lfHfRatio: number; totalPower: number; lfNu: number; hfNu: number };
}

export interface PdfReportData {
  /** Marca ISO del momento de la medición */
  timestamp: string;
  /** Duración total de la sesión en segundos */
  durationSec: number;
  /** Signos vitales al finalizar */
  vitals: VitalSignsResult;
  /** Reporte HRV (opcional, solo si ≥5 min) */
  hrv?: HrvSummary | null;
  /** Resumen de latidos */
  beats: { total: number; arrhythmia: number; normalPercent: number };
}

function fmtHR(v: number | null | undefined): string {
  if (v == null || v <= 0) return '--';
  return `${Math.round(v)} bpm`;
}

function fmtSpO2(v: number | null | undefined): string {
  if (v == null || v < 75) return '--';
  return `${Math.round(v)}%`;
}

function fmtBP(bp: { systolic?: number; diastolic?: number } | null | undefined): string {
  if (!bp?.systolic || !bp?.diastolic) return '--';
  return `${Math.round(bp.systolic)}/${Math.round(bp.diastolic)} mmHg`;
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number, d = 1): string {
  return v.toFixed(d);
}

export function generatePdfHtml(data: PdfReportData): string {
  const date = new Date(data.timestamp);
  const dateStr = date.toLocaleDateString('es-ES', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = date.toLocaleTimeString('es-ES', {
    hour: '2-digit', minute: '2-digit',
  });
  const durMin = Math.floor(data.durationSec / 60);
  const durSec = data.durationSec % 60;
  const durStr = `${durMin}:${durSec.toString().padStart(2, '0')} min`;

  const hr = data.vitals.heartRate?.value;
  const spo2 = data.vitals.spo2?.value;
  const bp = data.vitals.bloodPressure?.value;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporte Clínico - Bio Beat Tracker</title>
<style>
  @page { margin: 20mm 15mm; size: A4; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; line-height: 1.5; }
  .header { text-align: center; margin-bottom: 28px; padding-bottom: 16px; border-bottom: 3px solid #2563eb; }
  .header h1 { font-size: 20pt; color: #2563eb; margin-bottom: 4px; }
  .header .subtitle { font-size: 10pt; color: #6b7280; }
  .header .datetime { font-size: 9pt; color: #9ca3af; margin-top: 6px; }

  h2 { font-size: 13pt; color: #1e40af; margin: 20px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; }

  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 10px 0; }
  .card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; text-align: center; }
  .card .label { font-size: 8pt; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 16pt; font-weight: 700; color: #1e293b; margin-top: 4px; }

  .hrv-section { margin: 16px 0; }
  .hrv-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .hrv-item { display: flex; justify-content: space-between; padding: 6px 10px; background: #f1f5f9; border-radius: 4px; font-size: 10pt; }
  .hrv-item .label { color: #475569; }
  .hrv-item .value { font-weight: 600; color: #0f172a; }

  .poincare { margin: 16px 0; text-align: center; }
  .poincare .vals { display: flex; justify-content: center; gap: 24px; margin-top: 8px; }
  .poincare .val { text-align: center; }
  .poincare .val .num { font-size: 14pt; font-weight: 700; color: #1e293b; }
  .poincare .val .lbl { font-size: 8pt; color: #6b7280; }

  .lfhf { margin: 12px 0; }
  .lfhf table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  .lfhf th { background: #eff6ff; color: #1e40af; padding: 6px 10px; text-align: left; }
  .lfhf td { padding: 5px 10px; border-bottom: 1px solid #e5e7eb; }
  .lfhf td:last-child { text-align: right; font-weight: 600; }

  .beats { margin: 12px 0; }
  .beats table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  .beats th { background: #fef2f2; color: #991b1b; padding: 6px 10px; text-align: left; }
  .beats td { padding: 5px 10px; border-bottom: 1px solid #e5e7eb; }
  .beats td:last-child { text-align: right; font-weight: 600; }

  .footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 8pt; color: #9ca3af; text-align: center; }
</style>
</head>
<body>
<div class="header">
  <h1>Bio Beat Tracker</h1>
  <div class="subtitle">Reporte Clínico de Signos Vitales</div>
  <div class="datetime">${dateStr} &middot; ${timeStr} &middot; Duración: ${durStr}</div>
</div>

<h2>Signos Vitales</h2>
<div class="grid-3">
  <div class="card"><div class="label">Frecuencia Cardíaca</div><div class="value">${fmtHR(hr)}</div></div>
  <div class="card"><div class="label">SpO₂</div><div class="value">${fmtSpO2(spo2)}</div></div>
  <div class="card"><div class="label">Presión Arterial</div><div class="value">${fmtBP(bp)}</div></div>
</div>

${data.hrv ? `<h2>Análisis HRV (Variabilidad del Ritmo Cardíaco)</h2>
<div class="hrv-section">
  <div class="hrv-grid">
    <div class="hrv-item"><span class="label">FC media</span><span class="value">${fmtNum(data.hrv.meanHR)} bpm</span></div>
    <div class="hrv-item"><span class="label">RR medio</span><span class="value">${fmtMs(data.hrv.meanRR)}</span></div>
    <div class="hrv-item"><span class="label">SDNN</span><span class="value">${fmtMs(data.hrv.sdnn)}</span></div>
    <div class="hrv-item"><span class="label">RMSSD</span><span class="value">${fmtMs(data.hrv.rmssd)}</span></div>
    <div class="hrv-item"><span class="label">pNN50</span><span class="value">${fmtPct(data.hrv.pnn50)}</span></div>
    <div class="hrv-item"><span class="label">CV</span><span class="value">${fmtPct(data.hrv.cv)}</span></div>
  </div>
</div>

${data.hrv.poincare ? `<div class="poincare">
  <h2>Poincaré (Análisis No Lineal)</h2>
  <div class="vals">
    <div class="val"><div class="num">${fmtMs(data.hrv.poincare.sd1)}</div><div class="lbl">SD1 (rama corta)</div></div>
    <div class="val"><div class="num">${fmtMs(data.hrv.poincare.sd2)}</div><div class="lbl">SD2 (rama larga)</div></div>
    <div class="val"><div class="num">${fmtPct(data.hrv.poincare.sd1_sd2_ratio)}</div><div class="lbl">SD1/SD2</div></div>
  </div>
</div>` : ''}

${data.hrv.frequency ? `<div class="lfhf">
  <h2>Análisis Espectral (Lomb–Scargle)</h2>
  <table>
    <tr><th>Banda</th><th>Potencia</th></tr>
    <tr><td>VLF (0.003–0.04 Hz)</td><td>${fmtMs(data.hrv.frequency.vlf)}</td></tr>
    <tr><td>LF (0.04–0.15 Hz)</td><td>${fmtMs(data.hrv.frequency.lf)}</td></tr>
    <tr><td>HF (0.15–0.40 Hz)</td><td>${fmtMs(data.hrv.frequency.hf)}</td></tr>
    <tr><td>Potencia Total</td><td>${fmtMs(data.hrv.frequency.totalPower)}</td></tr>
    <tr><td>LF/HF</td><td>${fmtNum(data.hrv.frequency.lfHfRatio, 2)}</td></tr>
    <tr><td>LF n.u.</td><td>${fmtPct(data.hrv.frequency.lfNu)}</td></tr>
    <tr><td>HF n.u.</td><td>${fmtPct(data.hrv.frequency.hfNu)}</td></tr>
  </table>
</div>` : ''}` : ''}

<h2>Resumen de Latidos</h2>
<div class="beats">
  <table>
    <tr><th>Métrica</th><th>Valor</th></tr>
    <tr><td>Total de latidos</td><td>${data.beats.total}</td></tr>
    <tr><td>Latidos arrítmicos</td><td>${data.beats.arrhythmia}</td></tr>
    <tr><td>Ritmo normal</td><td>${data.beats.normalPercent}%</td></tr>
  </table>
</div>

<div class="footer">
  Bio Beat Tracker &mdash; Reporte generado el ${dateStr} a las ${timeStr}
  <br>Este reporte no constituye un diagnóstico médico. Consulte a su profesional de la salud.
</div>

<script>
window.onload = function() { window.print(); setTimeout(function() { window.close(); }, 500); };
</script>
</body>
</html>`;
}

export function openPdfReport(data: PdfReportData): void {
  const html = generatePdfHtml(data);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'width=800,height=700,scrollbars=yes');
  if (!win) {
    // Fallback: pop-up bloqueado; abrimos en la misma ventana
    const fallback = window.open('about:blank', '_self');
    if (fallback) {
      fallback.document.write(html);
      fallback.document.close();
    }
  }
  // Liberar URL tras 30 s (tiempo suficiente para cargar)
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
