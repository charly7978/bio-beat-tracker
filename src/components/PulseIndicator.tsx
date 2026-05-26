import { Heart } from 'lucide-react';

interface PulseIndicatorProps {
  showPulse: boolean;
}

export function PulseIndicator({ showPulse }: PulseIndicatorProps) {
  return (
    <div className="absolute z-10 flex items-center gap-2 pointer-events-none" style={{ top: '8px', left: '120px' }}>
      <div
        className={`p-1 rounded-full transition-all duration-100 ${
          showPulse ? 'bg-red-500/40 scale-125' : 'bg-emerald-500/0'
        }`}
      >
        <Heart
          className={`w-3.5 h-3.5 transition-all duration-100 ${
            showPulse ? 'text-red-300' : 'text-emerald-400/0'
          }`}
          fill={showPulse ? 'currentColor' : 'none'}
        />
      </div>
      {/* Activity icon removed — was invisible (text-emerald-400/0) */}
    </div>
  );
}
