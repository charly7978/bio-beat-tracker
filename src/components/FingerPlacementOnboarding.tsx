import React, { useEffect, useState } from "react";
import { Flashlight, Fingerprint, X } from "lucide-react";

const STORAGE_KEY = "finger_onboarding_seen_v1";

interface FingerPlacementOnboardingProps {
  onDismiss?: () => void;
}

/**
 * Tutorial de una sola vez: se muestra antes de la primera medición para
 * enseñar, con un diagrama simple, exactamente dónde va el dedo respecto a la
 * cámara trasera y el flash. Sustituye la expectativa de que el usuario
 * "adivine" la posición ideal por una demostración explícita.
 */
const FingerPlacementOnboarding: React.FC<FingerPlacementOnboardingProps> = ({ onDismiss }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = localStorage.getItem(STORAGE_KEY) === "true";
    if (!seen) setVisible(true);
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    setVisible(false);
    onDismiss?.();
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 backdrop-blur-sm animate-fade-in">
      <div className="bg-zinc-950 border border-emerald-500/25 rounded-2xl max-w-xs w-[90%] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="px-4 py-3 flex items-center justify-between border-b border-zinc-900">
          <h3 className="text-white text-sm font-bold tracking-wide">Cómo colocar el dedo</h3>
          <button
            onClick={dismiss}
            aria-label="Cerrar"
            className="p-1.5 rounded-full bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 flex flex-col items-center gap-4">
          {/* Diagrama esquemático del teléfono visto desde atrás */}
          <div className="relative w-28 h-52 rounded-[1.6rem] bg-zinc-900 border-2 border-zinc-700 flex flex-col items-center justify-center">
            <div className="absolute top-4 left-0 right-0 flex items-center justify-center gap-3">
              <div className="w-5 h-5 rounded-full bg-zinc-800 border border-zinc-600 flex items-center justify-center">
                <div className="w-2.5 h-2.5 rounded-full bg-cyan-400/70" />
              </div>
              <div className="w-3.5 h-3.5 rounded-sm bg-amber-300/80 flex items-center justify-center">
                <Flashlight className="w-2.5 h-2.5 text-amber-900" />
              </div>
            </div>

            {/* Huella animada cubriendo lente + flash */}
            <div className="absolute top-2 left-0 right-0 flex items-center justify-center">
              <div className="w-14 h-14 rounded-full bg-rose-400/25 border-2 border-rose-400/70 animate-pulse flex items-center justify-center">
                <Fingerprint className="w-7 h-7 text-rose-300" />
              </div>
            </div>

            <p className="absolute bottom-3 text-[8px] text-zinc-500 font-mono tracking-wide">CÁMARA TRASERA</p>
          </div>

          <ul className="text-zinc-300 text-[11px] leading-relaxed space-y-1.5 w-full">
            <li>• Apoyá la yema cubriendo <b>a la vez</b> la lente y el flash.</li>
            <li>• Presión media y constante — ni flojo ni aplastando.</li>
            <li>• Quedate quieto unos segundos hasta ver el aro verde.</li>
            <li>• Si el aro está rojo o amarillo, seguí la sugerencia en pantalla.</li>
          </ul>

          <button
            onClick={dismiss}
            className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm transition-colors"
          >
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
};

export default FingerPlacementOnboarding;
