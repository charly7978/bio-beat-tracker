import React from 'react';
import {
  contactHintText,
  CONTACT_ACQUIRE_THRESHOLD,
  CONTACT_WARM_THRESHOLD,
  type ContactHintKind,
} from '@/lib/finger/fingerContactScore';

export interface FingerAcquisitionGuideProps {
  /** Se muestra solo durante la fase de colocación (antes de READY). */
  visible: boolean;
  /** Puntaje de contacto universal [0..1]. */
  contactScore: number;
  /** Hint accionable (dirección/presión). */
  contactHint: ContactHintKind;
}

const RADIUS = 92;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * GUÍA DE COLOCACIÓN — medidor de proximidad "caliente/frío".
 *
 * Convierte la búsqueda a ciegas del "punto exacto" en una guía visible: el aro
 * se llena y cambia de color con el {@link contactScore} continuo, y un hint
 * direccional/de presión le dice al usuario qué corregir. La cámara real se ve
 * por detrás (el lienzo del monitor queda transparente durante la adquisición),
 * así el usuario ve su dedo y el enrojecimiento en vivo mientras lo centra.
 */
export const FingerAcquisitionGuide: React.FC<FingerAcquisitionGuideProps> = ({
  visible,
  contactScore,
  contactHint,
}) => {
  if (!visible) return null;

  const score = Math.max(0, Math.min(1, contactScore));
  const acquired = score >= CONTACT_ACQUIRE_THRESHOLD;
  const warm = score >= CONTACT_WARM_THRESHOLD;

  // Frío (azul) → templado (ámbar) → contacto (esmeralda).
  const ringColor = acquired ? '#22c55e' : warm ? '#f59e0b' : '#38bdf8';
  const glow = acquired ? 'rgba(34,197,94,0.45)' : warm ? 'rgba(245,158,11,0.35)' : 'rgba(56,189,248,0.28)';
  const dash = CIRCUMFERENCE * (1 - score);

  const hintText = contactHintText(contactHint);
  const arrow = ARROW_FOR_HINT[contactHint];

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col items-center justify-center">
      <div className="relative flex items-center justify-center" style={{ width: 240, height: 240 }}>
        {/* Halo pulsante que respira con la proximidad */}
        <div
          className="absolute rounded-full animate-pulse"
          style={{
            width: 220,
            height: 220,
            boxShadow: `0 0 60px 12px ${glow}`,
            opacity: 0.6 + score * 0.4,
          }}
        />

        <svg width={240} height={240} className="absolute -rotate-90">
          {/* Pista */}
          <circle
            cx={120}
            cy={120}
            r={RADIUS}
            fill="none"
            stroke="rgba(148,163,184,0.22)"
            strokeWidth={8}
          />
          {/* Progreso de contacto */}
          <circle
            cx={120}
            cy={120}
            r={RADIUS}
            fill="none"
            stroke={ringColor}
            strokeWidth={8}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dash}
            style={{ transition: 'stroke-dashoffset 120ms linear, stroke 200ms linear' }}
          />
        </svg>

        {/* Centro transparente: se ve el dedo/cámara. Marca de mira sutil. */}
        <div
          className="absolute rounded-full border"
          style={{
            width: 150,
            height: 150,
            borderColor: `${ringColor}66`,
          }}
        />
        <div className="absolute flex flex-col items-center">
          {arrow ? (
            <span
              className="text-3xl font-bold animate-pulse"
              style={{ color: ringColor }}
            >
              {arrow}
            </span>
          ) : (
            <span className="text-2xl font-bold" style={{ color: ringColor }}>
              {acquired ? '✓' : `${Math.round(score * 100)}%`}
            </span>
          )}
        </div>
      </div>

      {/* Estado + hint accionable */}
      <div className="mt-6 flex flex-col items-center gap-1 px-8 text-center">
        <p
          className="text-sm font-bold tracking-wide"
          style={{ color: ringColor }}
        >
          {acquired ? 'CONTACTO' : warm ? 'CASI…' : 'BUSCANDO DEDO'}
        </p>
        {hintText && (
          <p className="text-[12px] font-medium text-white/85 max-w-[260px] leading-snug">
            {hintText}
          </p>
        )}
      </div>
    </div>
  );
};

const ARROW_FOR_HINT: Partial<Record<ContactHintKind, string>> = {
  'move-left': '←',
  'move-right': '→',
  'move-up': '↑',
  'move-down': '↓',
};

export default FingerAcquisitionGuide;
