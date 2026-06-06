/**
 * FINGER CONTACT MANAGER - Responsabilidad: Detección y gestión de contacto de dedo
 * 
 * Separa toda la lógica de detección de contacto del procesador principal.
 * Maneja:
 * - Detección instantánea de dedo
 * - Estados de contacto (NO_CONTACT, UNSTABLE_CONTACT, STABLE_CONTACT)
 * - Histéresis y estabilización de contacto
 * - Ensemble detection (color + pulsatilidad)
 */

import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import type { FingerPlacementMode } from '@/types/signal';
import type { ROIMetrics } from '../roi/ROIExtractor';
import {
  hasFingerHemoglobinSignature,
  type FingerRgbSnapshot,
} from '@/lib/finger/fingerContactSignature';
import {
  classifyFingerPlacement,
  placementHintText,
  smoothPlacementMode,
} from '@/lib/finger/fingerPlacementProfile';
import {
  isExposureFlickerNotFingerPulse,
  passesFingerAcquire,
  passesFingerMaintain,
  passesLiveFingerContact,
  passesPulsatileAcquire,
  updateFingerDetection,
} from '@/lib/finger/fingerSceneClassifier';
import type { CameraRuntimeHints } from '@/lib/device/cameraDeviceProfile';

export type ContactState = 'NO_CONTACT' | 'UNSTABLE_CONTACT' | 'STABLE_CONTACT';

export interface ContactManagerState {
  contactState: ContactState;
  fingerDetected: boolean;
  fingerConfidenceCount: number;
  fingerLostCount: number;
  stableContactCount: number;
  instantLostStreak: number;
  liveFingerMissStreak: number;
  noContactHardStreak: number;
  lastInstantFinger: boolean;
  placementMode: FingerPlacementMode;
  placementStreak: { mode: FingerPlacementMode; count: number };
  consecutiveNoContactFrames: number;
}

export interface ContactManagerConfig {
  cameraHints: CameraRuntimeHints;
  fingerConfirmFrames: number;
  smoothedRed: number;
  smoothedGreen: number;
  smoothedBlue: number;
  smoothedCoverage: number;
  smoothedFingerScore: number;
  lastRoiRedCv: number;
  cachedPI: number;
  lastEnsembleScore: number;
  motionScore: number;
}

export interface ContactDiagnostics {
  message: string;
  hasPulsatility: boolean;
  pulsatilityValue: number;
  coverageRatio: number;
  placementMode: FingerPlacementMode;
  placementHint: string;
  fingerPressure: 'LIGHT' | 'IDEAL' | 'HEAVY';
  status: string;
  acquisitionStage: string;
  acquisitionConfidence: number;
  acquisitionProgress: number;
}

export class FingerContactManager {
  private state: ContactManagerState;
  private readonly RGB_SMOOTH_ALPHA = 0.08;
  private readonly COVERAGE_SMOOTH_ALPHA = 0.10;

  constructor() {
    this.state = {
      contactState: 'NO_CONTACT',
      fingerDetected: false,
      fingerConfidenceCount: 0,
      fingerLostCount: 0,
      stableContactCount: 0,
      instantLostStreak: 0,
      liveFingerMissStreak: 0,
      noContactHardStreak: 0,
      lastInstantFinger: false,
      placementMode: 'hybrid',
      placementStreak: { mode: 'hybrid', count: 0 },
      consecutiveNoContactFrames: 0,
    };
  }

  getState(): ContactManagerState {
    return { ...this.state };
  }

  setState(newState: Partial<ContactManagerState>): void {
    this.state = { ...this.state, ...newState };
  }

  /**
   * Procesa un frame y actualiza el estado de contacto
   */
  processFrame(
    roi: ROIMetrics,
    config: ContactManagerConfig,
    grayBuffer: Uint8ClampedArray | null
  ): {
    contactState: ContactState;
    fingerDetected: boolean;
    smoothedValues: {
      red: number;
      green: number;
      blue: number;
      coverage: number;
      fingerScore: number;
    };
    placementMode: FingerPlacementMode;
  } {
    // Suavizar valores RGB
    const smoothed = this.smoothRgbValues(roi, config);

    // Detectar dedo instantáneo
    const instantDetected = this.detectFingerInstant(roi, smoothed, config, grayBuffer);
    this.state.lastInstantFinger = instantDetected;

    // Actualizar estado de contacto
    this.updateContactState(instantDetected, config);

    // Actualizar modo de colocación
    this.updatePlacementMode(smoothed, config);

    return {
      contactState: this.state.contactState,
      fingerDetected: this.state.fingerDetected,
      smoothedValues: smoothed,
      placementMode: this.state.placementMode,
    };
  }

  /**
   * Suaviza valores RGB con EMA
   */
  private smoothRgbValues(
    roi: ROIMetrics,
    config: ContactManagerConfig
  ): {
    red: number;
    green: number;
    blue: number;
    coverage: number;
    fingerScore: number;
  } {
    const { rawRed, rawGreen, rawBlue, coverageRatio, fingerScore } = roi;
    const { smoothedRed, smoothedGreen, smoothedBlue, smoothedCoverage, smoothedFingerScore } = config;

    let red = smoothedRed;
    let green = smoothedGreen;
    let blue = smoothedBlue;
    let coverage = smoothedCoverage;
    let fScore = smoothedFingerScore;

    if (smoothedRed === 0) {
      red = rawRed;
      green = rawGreen;
      blue = rawBlue;
      coverage = coverageRatio;
      fScore = fingerScore;
    } else {
      const a = this.RGB_SMOOTH_ALPHA;
      const ca = this.COVERAGE_SMOOTH_ALPHA;
      red = smoothedRed * (1 - a) + rawRed * a;
      green = smoothedGreen * (1 - a) + rawGreen * a;
      blue = smoothedBlue * (1 - a) + rawBlue * a;
      coverage = smoothedCoverage * (1 - ca) + coverageRatio * ca;
      fScore = smoothedFingerScore * (1 - ca) + fingerScore * ca;
    }

    return { red, green, blue, coverage, fingerScore: fScore };
  }

  /**
   * Detecta si hay dedo en el frame actual
   */
  private detectFingerInstant(
    roi: ROIMetrics,
    smoothed: {
      red: number;
      green: number;
      blue: number;
      coverage: number;
      fingerScore: number;
    },
    config: ContactManagerConfig,
    grayBuffer: Uint8ClampedArray | null
  ): boolean {
    const F = VITAL_THRESHOLDS.FINGER;
    const { rawRed, rawGreen, rawBlue, coverageRatio, fingerScore } = roi;

    if (config.motionScore > F.ACQUIRE_MAX_MOTION_SOFT) return false;
    if (rawRed > 254 && rawGreen > 254 && rawBlue > 254) return false;

    const placementInstant = classifyFingerPlacement({
      coverageRatio: smoothed.coverage,
      roiRedCv: config.lastRoiRedCv,
      perfusionIndex: config.cachedPI,
    });

    const pulsatileContact = passesPulsatileAcquire(
      { red: rawRed, green: rawGreen, blue: rawBlue, coverage: coverageRatio, fingerScore },
      smoothed,
      { coverageRatio, fingerScore, fingerTileCount: roi.fingerTileCount },
      config.lastRoiRedCv,
      config.lastEnsembleScore
    );

    if (
      !this.state.fingerDetected &&
      !config.cameraHints.constrained &&
      placementInstant !== 'pad' &&
      isExposureFlickerNotFingerPulse(config.lastRoiRedCv, smoothed, F.PULSATILE_ACQUIRE_RB) &&
      !pulsatileContact &&
      config.lastEnsembleScore < F.ENSEMBLE_FINGER_THRESHOLD * 0.7
    ) {
      return false;
    }

    const fingerByPulse =
      (pulsatileContact || config.lastEnsembleScore > F.ENSEMBLE_FINGER_THRESHOLD * 0.7) &&
      smoothed.coverage >= F.MIN_COVERAGE * 0.5;

    if (!passesLiveFingerContact(
      { red: rawRed, green: rawGreen, blue: rawBlue, coverage: coverageRatio, fingerScore },
      smoothed,
      { coverageRatio, fingerScore, fingerTileCount: roi.fingerTileCount },
      config.lastEnsembleScore
    )) {
      return fingerByPulse;
    }

    if (this.state.fingerDetected) return true;

    return (
      passesFingerAcquire(
        { red: rawRed, green: rawGreen, blue: rawBlue, coverage: coverageRatio, fingerScore },
        smoothed,
        { coverageRatio, fingerScore, fingerTileCount: roi.fingerTileCount },
        {
          roiRedCv: config.lastRoiRedCv,
          perfusionIndex: config.cachedPI,
          ensembleScore: config.lastEnsembleScore,
        }
      ) || fingerByPulse
    );
  }

  /**
   * Actualiza el estado de contacto con histéresis
   */
  private updateContactState(instantDetected: boolean, config: ContactManagerConfig): void {
    const previousState = this.state.contactState;
    const hints = config.cameraHints;
    const confirmFrames = config.fingerConfirmFrames;

    if (instantDetected) {
      this.state.instantLostStreak = 0;
      this.state.noContactHardStreak = 0;
      this.state.fingerLostCount = 0;
      this.state.fingerConfidenceCount = Math.min(this.state.fingerConfidenceCount + 1, 100);
      this.state.stableContactCount++;

      if (this.state.fingerConfidenceCount >= confirmFrames) {
        this.state.fingerDetected = true;
        this.state.contactState = 'UNSTABLE_CONTACT';
      }
    } else {
      this.state.instantLostStreak++;
      const decay = hints.constrained ? 1 : 3;
      this.state.fingerConfidenceCount = Math.max(0, this.state.fingerConfidenceCount - decay);
      this.state.fingerLostCount++;
      this.state.stableContactCount = Math.max(0, this.state.stableContactCount - (hints.constrained ? 1 : 2));

      const rawSnap = { 
        red: config.smoothedRed, 
        green: config.smoothedGreen, 
        blue: config.smoothedBlue,
        coverage: config.smoothedCoverage,
        fingerScore: config.smoothedFingerScore
      };
      const flashOpen = false; // isOpenFlashWithoutContact se maneja en fingerSceneClassifier

      if (flashOpen) {
        this.setNoContact(true);
      } else if (this.state.fingerDetected) {
        if (this.state.instantLostStreak <= hints.instantLostToUnstable) {
          this.state.contactState = 'UNSTABLE_CONTACT';
        } else if (this.state.instantLostStreak <= hints.instantLostToNoContact) {
          this.state.contactState = 'NO_CONTACT';
          this.state.noContactHardStreak++;
          if (this.state.noContactHardStreak >= hints.bufferResetAfterNoContact) {
            this.setNoContact(true);
          }
        } else {
          this.setNoContact(true);
        }
      } else if (this.state.instantLostStreak <= hints.instantLostToUnstable) {
        this.state.contactState = 'UNSTABLE_CONTACT';
      } else if (this.state.instantLostStreak <= hints.instantLostToNoContact) {
        this.state.contactState = 'NO_CONTACT';
      } else {
        this.setNoContact(true);
      }
    }

    if (previousState === 'NO_CONTACT' && this.state.contactState !== 'NO_CONTACT') {
      this.state.consecutiveNoContactFrames = 0;
      this.state.noContactHardStreak = 0;
    } else if (this.state.contactState !== 'NO_CONTACT') {
      this.state.consecutiveNoContactFrames = 0;
      this.state.noContactHardStreak = 0;
    }
  }

  /**
   * Establece estado de no contacto
   */
  private setNoContact(hardReset: boolean): void {
    this.state.contactState = 'NO_CONTACT';
    this.state.fingerDetected = false;
    this.state.fingerConfidenceCount = 0;
    this.state.stableContactCount = 0;
    this.state.instantLostStreak = 0;
    this.state.lastInstantFinger = false;
    this.state.liveFingerMissStreak = 0;

    if (hardReset) {
      this.state.consecutiveNoContactFrames++;
    }
  }

  /**
   * Actualiza el modo de colocación del dedo
   */
  private updatePlacementMode(
    smoothed: {
      red: number;
      green: number;
      blue: number;
      coverage: number;
      fingerScore: number;
    },
    config: ContactManagerConfig
  ): void {
    const placementInstant = classifyFingerPlacement({
      coverageRatio: smoothed.coverage,
      roiRedCv: config.lastRoiRedCv,
      perfusionIndex: config.cachedPI,
    });

    const smoothedPlacement = smoothPlacementMode(
      this.state.placementMode,
      placementInstant,
      this.state.placementStreak
    );

    this.state.placementMode = smoothedPlacement.mode;
    this.state.placementStreak = smoothedPlacement.streak;
  }

  /**
   * Reconcilia contacto estable
   */
  reconcileStableContact(
    smoothed: {
      red: number;
      green: number;
      blue: number;
      coverage: number;
      fingerScore: number;
    },
    config: ContactManagerConfig
  ): void {
    if (!this.state.fingerDetected || !this.state.lastInstantFinger) {
      if (this.state.contactState === 'STABLE_CONTACT') {
        this.state.contactState = 'UNSTABLE_CONTACT';
      }
      return;
    }

    const minPi = VITAL_THRESHOLDS.QUALITY.MIN_PI;
    const F = VITAL_THRESHOLDS.FINGER;
    const snap: FingerRgbSnapshot = { 
      red: smoothed.red, 
      green: smoothed.green, 
      blue: smoothed.blue,
      coverage: smoothed.coverage,
      fingerScore: smoothed.fingerScore
    };
    const padLike = this.state.placementMode === 'pad';

    const pulseOk =
      hasFingerHemoglobinSignature(snap) &&
      smoothed.coverage >= F.MIN_COVERAGE * (padLike ? 0.82 : 0.92) &&
      (padLike || config.lastRoiRedCv >= F.ROI_RED_CV_MIN * 0.88);

    const piOk = config.cachedPI >= minPi * 0.75;
    const stable =
      this.state.stableContactCount >= VITAL_THRESHOLDS.QUALITY.STABLE_FRAMES_REQ &&
      (piOk || pulseOk) &&
      smoothed.coverage >= F.MIN_COVERAGE * (padLike ? 0.82 : 0.92);

    this.state.contactState = stable ? 'STABLE_CONTACT' : 'UNSTABLE_CONTACT';
  }

  /**
   * Verifica si es un frame de dedo vivo
   */
  isLiveFingerFrame(
    roi: ROIMetrics,
    smoothed: {
      red: number;
      green: number;
      blue: number;
      coverage: number;
      fingerScore: number;
    },
    ensembleScore: number,
    config: ContactManagerConfig
  ): boolean {
    const F = VITAL_THRESHOLDS.FINGER;
    const raw = { red: roi.rawRed, green: roi.rawGreen, blue: roi.rawBlue, coverage: roi.coverageRatio, fingerScore: roi.fingerScore };
    const spatial = { coverageRatio: roi.coverageRatio, fingerScore: roi.fingerScore, fingerTileCount: roi.fingerTileCount };

    if (this.state.fingerDetected) {
      if (ensembleScore > F.ENSEMBLE_FINGER_THRESHOLD * 0.8) return true;
      if (passesFingerMaintain(raw, smoothed, spatial, ensembleScore)) return true;
      if (
        config.cachedPI >= F.PULSE_HOLD_MIN_PI &&
        raw.red >= F.PULSE_HOLD_MIN_RED &&
        raw.red / Math.max(1, raw.green) >= F.PULSE_HOLD_RG &&
        raw.red / Math.max(1, raw.blue) >= F.PULSE_HOLD_RB &&
        spatial.coverageRatio >= F.PULSE_HOLD_COVERAGE &&
        config.motionScore <= F.PULSE_HOLD_MAX_MOTION
      ) {
        return true;
      }
    }

    return passesLiveFingerContact(raw, smoothed, spatial, ensembleScore);
  }

  /**
   * Estima la presión del dedo
   */
  estimateFingerPressure(
    roi: ROIMetrics,
    cachedPI: number
  ): 'LIGHT' | 'IDEAL' | 'HEAVY' {
    if (this.state.contactState === 'NO_CONTACT') return 'LIGHT';

    const pi = cachedPI;
    const coverage = roi.coverageRatio;

    if (coverage < 0.70) {
      return 'LIGHT';
    }

    if (coverage > 0.88 && pi < 0.0006) {
      return 'HEAVY';
    }

    if (coverage >= 0.70 && coverage < 0.82) {
      return 'LIGHT';
    }

    return 'IDEAL';
  }

  /**
   * Decaer valores suavizados rápidamente
   */
  decaySmoothedValuesFast(currentValues: {
    red: number;
    green: number;
    blue: number;
    coverage: number;
    fingerScore: number;
  }): {
    red: number;
    green: number;
    blue: number;
    coverage: number;
    fingerScore: number;
  } {
    const k = 0.55;
    const red = currentValues.red * (1 - k);
    const green = currentValues.green * (1 - k);
    const blue = currentValues.blue * (1 - k);
    const coverage = currentValues.coverage * (1 - k);
    const fingerScore = currentValues.fingerScore * (1 - k);

    return {
      red: red < 2 ? 0 : red,
      green,
      blue,
      coverage: coverage < 0.02 ? 0 : coverage,
      fingerScore,
    };
  }

  reset(): void {
    this.state = {
      contactState: 'NO_CONTACT',
      fingerDetected: false,
      fingerConfidenceCount: 0,
      fingerLostCount: 0,
      stableContactCount: 0,
      instantLostStreak: 0,
      liveFingerMissStreak: 0,
      noContactHardStreak: 0,
      lastInstantFinger: false,
      placementMode: 'hybrid',
      placementStreak: { mode: 'hybrid', count: 0 },
      consecutiveNoContactFrames: 0,
    };
  }
}
