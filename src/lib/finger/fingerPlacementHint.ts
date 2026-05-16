import type { ContactState } from '@/types/signal';

export function getFingerPlacementHint(opts: {
  fingerDetected: boolean;
  contactState: ContactState;
  coverageRatio: number;
  motionArtifact?: boolean;
}): string {
  const cov = opts.coverageRatio;
  if (opts.motionArtifact) {
    return 'Mantén el teléfono y el dedo quietos';
  }
  if (!opts.fingerDetected) {
    if (cov < 0.04) {
      return 'Cubre el recuadro con la yema del índice (flash + lente debajo)';
    }
    if (cov < 0.08) {
      return 'Centra el dedo en el recuadro — cubre más área roja';
    }
    return 'Presiona suave y fija el dedo; no tapes solo un borde';
  }
  if (opts.contactState === 'UNSTABLE_CONTACT') {
    if (cov < 0.12) {
      return 'Extiende un poco el dedo dentro del recuadro';
    }
    return 'Quédate quieto 5–10 s hasta que aparezca la onda cardíaca';
  }
  if (opts.contactState === 'STABLE_CONTACT') {
    return 'Perfecto — mantén la misma presión';
  }
  return 'Ajusta el dedo sobre el recuadro';
}
