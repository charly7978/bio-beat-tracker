import React, { useEffect, useRef } from 'react';
import type { CortexFrame } from '../types';

interface Props {
  frame: CortexFrame | null;
  sessionActive: boolean;
}

const stageLabels: Record<string, { label: string; color: string }> = {
  see: { label: 'OBSERVAR', color: '#60a5fa' },
  analyze: { label: 'ANALIZAR', color: '#f59e0b' },
  check: { label: 'VERIFICAR', color: '#8b5cf6' },
  reason: { label: 'RAZONAR', color: '#10b981' },
  decide: { label: 'DECIDIR', color: '#ef4444' },
};

const severityColors: Record<string, string> = {
  info: '#60a5fa',
  hint: '#f59e0b',
  warn: '#ef4444',
  error: '#dc2626',
};

const stateLabels: Record<string, string> = {
  NO_FINGER: 'Sin dedo',
  PARTIAL_COVERAGE: 'Cobertura parcial',
  CENTERED_LOW_PRESSURE: 'Poca presión',
  CENTERED_GOOD: 'Colocado bien',
  CENTERED_HIGH_PRESSURE: 'Exceso de presión',
  MOVEMENT: 'Movimiento',
  UNKNOWN: 'Desconocido',
};

export function CortexConsole({ frame, sessionActive }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const framesRef = useRef<CortexFrame[]>([]);

  if (frame) {
    framesRef.current.push(frame);
    if (framesRef.current.length > 48) framesRef.current.shift();
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [framesRef.current.length]);

  const dir = typeof window !== 'undefined' && document.dir;
  const isRTL = dir === 'rtl';

  const pg = frame?.placementGuidance;
  const severityColor = pg ? (severityColors[pg.severity] ?? '#666') : '#666';

  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden ${isRTL ? 'text-right' : 'text-left'}`}
         style={{ fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace" }}>
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${sessionActive ? 'bg-green-500' : 'bg-zinc-600'}`} />
          <span className="text-xs font-bold text-zinc-300 tracking-wider">
            CORTEX CONSOLE
          </span>
        </div>
        <span className="text-xs text-zinc-500">
          {sessionActive ? 'LIVE' : 'IDLE'}
        </span>
      </div>

      {/* Guidance bar */}
      {pg && pg.state !== 'CENTERED_GOOD' && (
        <div
          className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2"
          style={{ backgroundColor: severityColor + '15' }}
        >
          <span className="text-lg" style={{ color: severityColor }}>
            {pg.action === 'none' ? '✓' : pg.action === 'less_pressure' ? '↓' : pg.action === 'more_pressure' ? '↑' : pg.action === 'center' ? '⊙' : pg.action === 'steady' ? '—' : '?'}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold" style={{ color: severityColor }}>
              {(stateLabels as any)[pg.state] ?? pg.state}
            </div>
            <div className="text-[10px] text-zinc-400 truncate">{pg.guidance}</div>
          </div>
          <span className="text-[10px] text-zinc-600">
            {(pg.confidence * 100).toFixed(0)}%
          </span>
        </div>
      )}

      <div ref={scrollRef} className="p-2 space-y-1 overflow-y-auto" style={{ maxHeight: '360px' }}>
        {framesRef.current.length === 0 ? (
          <div className="text-xs text-zinc-600 py-4 text-center">
            {sessionActive ? 'Esperando señal...' : 'Coloca el dedo para iniciar'}
          </div>
        ) : (
          framesRef.current.slice(-24).reverse().map((f, idx) => (
            <div key={f.timestamp + '-' + idx} className="border-b border-zinc-800/50 pb-1 mb-1 last:border-0">
              {f.stages.map((stage) => {
                const meta = stageLabels[stage.stage] ?? { label: stage.stage, color: '#666' };
                return (
                  <div key={stage.timestamp} className="flex gap-1.5 text-xs leading-5">
                    <span className="shrink-0 font-bold" style={{ color: meta.color, width: '6ch' }}>
                      {`<${meta.label.toLowerCase()}>`}
                    </span>
                    <span className="text-zinc-400 break-words">{stage.content}</span>
                  </div>
                );
              })}
              {f.decision && (
                <div className="flex flex-wrap gap-1 mt-1 pt-1 border-t border-zinc-800/30">
                  <Chip label="BPM" value={f.decision.bpm.toFixed(0)} color="#60a5fa" />
                  <Chip label="CONF" value={(f.decision.bpmConfidence * 100).toFixed(0)} color="#f59e0b" />
                  {f.decision.spo2 != null && <Chip label="SpO₂" value={f.decision.spo2.toFixed(0)} color="#10b981" />}
                  <Chip label="Q" value={(f.decision.signalQuality * 100).toFixed(0)} color="#8b5cf6" />
                  <span className="text-xs text-zinc-600 ml-auto">
                    {stageLabel(f.decision.hemodynamicState)}
                  </span>
                </div>
              )}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function Chip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium"
      style={{ backgroundColor: color + '20', color }}
    >
      {label} <span className="font-bold">{value}</span>
    </span>
  );
}

const hemodynamicStateLabels: Record<string, string> = {
  normal: 'Normal',
  hypoperfusion: 'Hipoperfusión',
  hyperdynamic: 'Hiperdinámico',
  arrhythmic: 'Arrítmico',
  motion_artifact: 'Artefacto',
  contact_pressure: 'Presión',
  unstable: 'Inestable',
};

function stageLabel(s: string): string {
  return (hemodynamicStateLabels as any)[s] ?? s;
}
