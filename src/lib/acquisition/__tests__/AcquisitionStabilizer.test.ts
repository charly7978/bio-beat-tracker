import { describe, it, expect } from 'vitest';
import {
  createAcquisitionState,
  updateAcquisition,
  instantAcquisitionConfidence,
  isAcquisitionReady,
  type AcquisitionSample,
} from '../AcquisitionStabilizer';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

const A = VITAL_THRESHOLDS.ACQUISITION;

function goodSample(over: Partial<AcquisitionSample> = {}): AcquisitionSample {
  return {
    fingerDetected: true,
    contactState: 'STABLE_CONTACT',
    perfusionIndex: 0.004,
    periodicity: 0.5,
    sqi: 60,
    motionScore: 0.1,
    coverageRatio: 0.2,
    ...over,
  };
}

function poorSample(over: Partial<AcquisitionSample> = {}): AcquisitionSample {
  return {
    fingerDetected: true,
    contactState: 'STABLE_CONTACT',
    perfusionIndex: 0,
    periodicity: 0,
    sqi: 0,
    motionScore: 0,
    coverageRatio: 0,
    ...over,
  };
}

function noContactSample(): AcquisitionSample {
  return {
    fingerDetected: false,
    contactState: 'NO_CONTACT',
    perfusionIndex: 0,
    periodicity: 0,
    sqi: 0,
    motionScore: 0,
    coverageRatio: 0,
  };
}

describe('AcquisitionStabilizer', () => {
  it('arranca en SEARCHING con confianza y progreso a cero', () => {
    const s = createAcquisitionState();
    expect(s.stage).toBe('SEARCHING');
    expect(s.confidence).toBe(0);
    expect(s.progress).toBe(0);
    expect(isAcquisitionReady(s)).toBe(false);
  });

  it('instantAcquisitionConfidence: buenas métricas → alta, nulas → 0', () => {
    expect(instantAcquisitionConfidence(goodSample())).toBeGreaterThan(0.9);
    expect(instantAcquisitionConfidence(poorSample())).toBe(0);
  });

  it('el movimiento alto degrada la confianza instantánea', () => {
    const still = instantAcquisitionConfidence(goodSample({ motionScore: 0.1 }));
    const shaky = instantAcquisitionConfidence(goodSample({ motionScore: 1.2 }));
    expect(shaky).toBeLessThan(still);
  });

  it('sin contacto se mantiene en SEARCHING y la confianza decae', () => {
    const s = createAcquisitionState();
    // Sembrar algo de confianza primero.
    for (let i = 0; i < 10; i++) updateAcquisition(s, goodSample());
    const before = s.confidence;
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) updateAcquisition(s, noContactSample());
    expect(s.stage).toBe('SEARCHING');
    expect(s.confidence).toBeLessThan(before);
    expect(s.framesInContact).toBe(0);
  });

  it('respeta el warm-up: no pasa a READY antes de WARMUP_FRAMES', () => {
    const s = createAcquisitionState();
    const halfWarm = Math.floor(A.WARMUP_FRAMES / 2);
    for (let i = 0; i < halfWarm; i++) updateAcquisition(s, goodSample());
    // Confianza ya alta, pero aún no ha cumplido el warm-up temporal.
    expect(s.confidence).toBeGreaterThanOrEqual(A.CONF_ENTER_READY);
    expect(s.stage).toBe('STABILIZING');
  });

  it('alcanza READY con métricas buenas sostenidas', () => {
    const s = createAcquisitionState();
    for (let i = 0; i < A.WARMUP_FRAMES + A.READY_DWELL_FRAMES + 5; i++) {
      updateAcquisition(s, goodSample());
    }
    expect(s.stage).toBe('READY');
    expect(isAcquisitionReady(s)).toBe(true);
    expect(s.progress).toBeGreaterThan(0.9);
  });

  it('histéresis: un bache breve no abandona READY (lectura firme)', () => {
    const s = createAcquisitionState();
    for (let i = 0; i < A.WARMUP_FRAMES + A.READY_DWELL_FRAMES + 5; i++) {
      updateAcquisition(s, goodSample());
    }
    expect(s.stage).toBe('READY');
    // Pocos frames pobres: no debe caer de READY.
    for (let i = 0; i < 4; i++) updateAcquisition(s, poorSample());
    expect(s.stage).toBe('READY');
  });

  it('una caída sostenida de calidad sí abandona READY', () => {
    const s = createAcquisitionState();
    for (let i = 0; i < A.WARMUP_FRAMES + A.READY_DWELL_FRAMES + 5; i++) {
      updateAcquisition(s, goodSample());
    }
    expect(s.stage).toBe('READY');
    for (let i = 0; i < 50; i++) updateAcquisition(s, poorSample());
    expect(s.stage).not.toBe('READY');
    expect(s.confidence).toBeLessThan(A.CONF_EXIT_READY);
  });

  it('NO llega a READY sin pulso periódico real (anti "verde falso")', () => {
    const s = createAcquisitionState();
    // Dedo que tapa con buena cobertura/PI/SQI pero SIN pulso (periodicidad 0):
    // p.ej. un objeto inerte o un dedo sin buen acoplamiento. No debe ponerse verde.
    const noPulse = () => goodSample({ periodicity: 0 });
    for (let i = 0; i < A.WARMUP_FRAMES + A.READY_DWELL_FRAMES + 20; i++) {
      updateAcquisition(s, noPulse());
    }
    expect(s.stage).not.toBe('READY');
    expect(isAcquisitionReady(s)).toBe(false);
  });

  it('pierde READY si el pulso periódico desaparece de forma sostenida', () => {
    const s = createAcquisitionState();
    for (let i = 0; i < A.WARMUP_FRAMES + A.READY_DWELL_FRAMES + 5; i++) {
      updateAcquisition(s, goodSample());
    }
    expect(s.stage).toBe('READY');
    // Métricas DC siguen buenas pero se pierde la periodicidad → debe abandonar READY.
    for (let i = 0; i < A.EXIT_DWELL_FRAMES + 3; i++) {
      updateAcquisition(s, goodSample({ periodicity: 0 }));
    }
    expect(s.stage).not.toBe('READY');
  });

  it('el progreso es mayormente monótono mientras sube (sin saltos bruscos)', () => {
    const s = createAcquisitionState();
    let prev = s.progress;
    for (let i = 0; i < A.WARMUP_FRAMES; i++) {
      updateAcquisition(s, goodSample());
      // No retrocede de golpe y respeta la subida máxima por frame.
      expect(s.progress).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(s.progress - prev).toBeLessThanOrEqual(A.PROGRESS_MAX_RISE + 1e-6);
      prev = s.progress;
    }
  });
});
