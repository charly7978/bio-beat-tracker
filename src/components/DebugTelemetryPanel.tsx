import React, { useState } from 'react';

interface DebugTelemetryPanelProps {
  camera?: Record<string, unknown>;
  contactState?: string;
  sqm?: {
    sqi?: number;
    perfusionIndex?: number;
    fpsEffective?: number;
    timestampJitterMs?: number;
    detectorAgreement?: number | null;
    elgendiConfidence?: number | null;
    panTompkinsConfidence?: number | null;
  };
  acquisitionStatus?: string;
  peakDetection?: Record<string, unknown>;
}

export const DebugTelemetryPanel: React.FC<DebugTelemetryPanelProps> = ({
  camera,
  sqm,
  acquisitionStatus,
  peakDetection,
  contactState: contactStateProp,
}) => {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute bottom-2 left-2 z-30 rounded bg-black/55 px-2 py-1 text-[9px] font-mono uppercase tracking-wider text-emerald-300/90"
      >
        Debug
      </button>
    );
  }

  const pd = peakDetection ?? {};
  const res = camera?.resolution as { width?: number; height?: number } | undefined;

  return (
    <div className="absolute bottom-2 left-2 z-30 max-w-[min(100%,320px)] rounded-lg border border-emerald-500/25 bg-black/88 p-2 text-[9px] font-mono text-slate-300 shadow-lg">
      <div className="flex items-center justify-between border-b border-white/10 pb-1 mb-1">
        <span className="text-emerald-400 font-bold uppercase tracking-widest">Telemetría</span>
        <button type="button" onClick={() => setOpen(false)} className="text-slate-500 hover:text-white">
          ✕
        </button>
      </div>
      <div className="space-y-0.5 max-h-40 overflow-y-auto">
        <Row k="contact" v={contactStateProp ?? '—'} />
        <Row
          k="perfil"
          v={
            camera?.tclLike === true
              ? 'TCL/estricto'
              : camera?.motorolaLike === true
                ? 'Moto/tolerante'
                : camera?.constrained === true
                  ? 'tolerante'
                  : 'normal'
          }
        />
        <Row k="acquire" v={acquisitionStatus ?? '—'} />
        <Row k="SQI" v={sqm?.sqi != null ? `${Math.round(sqm.sqi)}` : '—'} />
        <Row k="PI" v={sqm?.perfusionIndex != null ? sqm.perfusionIndex.toFixed(4) : '—'} />
        <Row k="FPS" v={sqm?.fpsEffective != null ? sqm.fpsEffective.toFixed(1) : '—'} />
        <Row k="jitter" v={sqm?.timestampJitterMs != null ? `${sqm.timestampJitterMs.toFixed(0)}ms` : '—'} />
        <Row k="agree" v={fmtPct(sqm?.detectorAgreement)} />
        <Row k="Elgendi" v={fmtPct(sqm?.elgendiConfidence)} />
        <Row k="PanTomp" v={fmtPct(sqm?.panTompkinsConfidence)} />
        <Row
          k="picos"
          v={
            pd.fusedPeakCount != null
              ? `F${pd.fusedPeakCount} E${arrLen(pd.elgendiPeakTimes)} PT${arrLen(pd.panTompkinsPeakTimes)}`
              : '—'
          }
        />
        <Row
          k="torch"
          v={
            camera?.torchActive === true
              ? 'ON'
              : camera?.torchSupported === false
                ? 'N/A'
                : '—'
          }
        />
        <Row k="res" v={res?.width ? `${res.width}×${res.height}` : '—'} />
      </div>
    </div>
  );
};

function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-emerald-500/80">{k}</span>
      <span className="text-white/90">{v}</span>
    </div>
  );
}
