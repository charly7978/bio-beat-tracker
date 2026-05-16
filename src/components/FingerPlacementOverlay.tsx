import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { ContactState } from '@/types/signal';

const ROI_FRAC = VITAL_THRESHOLDS.FINGER.ROI_SIZE_FRACTION;

interface FingerPlacementOverlayProps {
  visible: boolean;
  fingerDetected: boolean;
  contactState: ContactState;
  coverageRatio: number;
  hint: string;
}

export default function FingerPlacementOverlay({
  visible,
  fingerDetected,
  contactState,
  coverageRatio,
  hint,
}: FingerPlacementOverlayProps) {
  if (!visible) return null;

  const pct = Math.round(coverageRatio * 100);
  const minCov = VITAL_THRESHOLDS.FINGER.MIN_COVERAGE;
  const signalOk =
    fingerDetected &&
    contactState === 'STABLE_CONTACT' &&
    coverageRatio >= minCov;

  const border = signalOk
    ? 'border-emerald-400 shadow-[0_0_24px_rgba(52,211,153,0.45)]'
    : fingerDetected
      ? 'border-amber-400/90 shadow-[0_0_18px_rgba(251,191,36,0.35)]'
      : 'border-white/50 shadow-[0_0_12px_rgba(255,255,255,0.15)] animate-pulse';

  const label = signalOk
    ? 'SEÑAL OK'
    : fingerDetected
      ? 'AJUSTANDO…'
      : 'COLOCA EL DEDO';

  return (
    <div className="pointer-events-none absolute inset-0 z-[15] flex flex-col items-center justify-center">
      <div
        className={`relative rounded-2xl border-2 border-dashed ${border} bg-black/20 backdrop-blur-[1px]`}
        style={{
          width: `${ROI_FRAC * 100}%`,
          maxWidth: `${ROI_FRAC * 100}vmin`,
          aspectRatio: '1',
        }}
      >
        <div className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/70 px-2 py-0.5 text-[10px] font-bold tracking-wider text-white/90">
          {label}
          {fingerDetected ? ` · ${pct}%` : ''}
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-3 w-3 rounded-full bg-white/25 ring-2 ring-white/40" title="Centro óptico" />
        </div>
        <div className="absolute bottom-2 left-0 right-0 text-center text-[9px] font-mono text-white/50">
          flash + lente
        </div>
      </div>

      <p className="mt-4 max-w-[min(92%,20rem)] text-center text-xs font-medium leading-snug text-white drop-shadow-md px-2">
        {hint}
      </p>
    </div>
  );
}
