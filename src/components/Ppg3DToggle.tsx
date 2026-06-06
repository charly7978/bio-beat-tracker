/**
 * Ppg3DToggle — Conmuta la capa de profundidad 3D del monitor cardíaco.
 *
 * 3D = grilla en perspectiva (profundidad) + onda como cinta extruida.
 * 2D = monitor clásico. La detección y la onda honesta son idénticas en ambos modos;
 * sólo cambia la presentación (ver `src/lib/ui/ppg3dProjection.ts`).
 */
import { Box } from 'lucide-react';
import { usePpg3dSettings } from '@/store/ppg3dSettings';

export function Ppg3DToggle() {
  const enabled = usePpg3dSettings((s) => s.enabled);
  const toggle = usePpg3dSettings((s) => s.toggle);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      title={enabled ? 'Vista 3D activa · toca para 2D' : 'Vista 2D · toca para 3D'}
      className={`absolute bottom-14 right-2 z-20 flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold transition-colors ${
        enabled
          ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-300'
          : 'border-slate-600/50 bg-slate-800/70 text-slate-300'
      }`}
    >
      <Box className="h-3 w-3" />
      {enabled ? '3D' : '2D'}
    </button>
  );
}
