interface ActionButtonsProps {
  isMonitoring: boolean;
  onStartMeasurement: () => void;
  onReset: () => void;
}

export function ActionButtons({ isMonitoring, onStartMeasurement, onReset }: ActionButtonsProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 h-12 grid grid-cols-2 z-10">
      <button
        onClick={onStartMeasurement}
        className={`font-semibold text-sm transition-colors border-t border-slate-700/60 ${
          isMonitoring
            ? 'bg-red-500/20 hover:bg-red-500/30 active:bg-red-500/40 text-red-300 border-r'
            : 'bg-emerald-600/20 hover:bg-emerald-600/30 active:bg-emerald-600/40 text-emerald-300 border-r'
        }`}
      >
        {isMonitoring ? 'DETENER' : 'INICIAR'}
      </button>
      <button
        onClick={onReset}
        className="bg-slate-700/20 hover:bg-slate-700/30 active:bg-slate-700/40 text-slate-300 font-semibold text-sm transition-colors border-t border-slate-700/60"
      >
        RESET
      </button>
    </div>
  );
}
