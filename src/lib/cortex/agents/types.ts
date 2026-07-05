export type FingerPlacementState =
  | 'NO_FINGER'
  | 'PARTIAL_COVERAGE'
  | 'CENTERED_LOW_PRESSURE'
  | 'CENTERED_GOOD'
  | 'CENTERED_HIGH_PRESSURE'
  | 'MOVEMENT'
  | 'UNKNOWN';

export type GuidanceAction =
  | 'none'
  | 'shift_left'
  | 'shift_right'
  | 'shift_up'
  | 'shift_down'
  | 'center'
  | 'more_pressure'
  | 'less_pressure'
  | 'steady'
  | 'rotate'
  | 'move_closer';

export type GuidanceSeverity = 'info' | 'hint' | 'warn' | 'error';

export interface PlacementGuidance {
  text: string;
  action: GuidanceAction;
  severity: GuidanceSeverity;
}

export interface PlacementMetrics {
  coverage: number;
  perfusion: number;
  motion: number;
  pressure: string;
  placementMode: string;
  redCv: number;
  fingerDetected: boolean;
  contactState: string;
  quality: number;
}

export interface FingerPlacementDecision {
  state: FingerPlacementState;
  confidence: number;
  guidance: PlacementGuidance;
  metrics: PlacementMetrics;
  reasoning: string;
  stages: {
    see: string;
    analyze: string;
    check: string;
    reason: string;
    decide: string;
  };
  inference?: {
    label: string;
    modelConfidence: number;
    modelGuidance: string;
    frameRgb: string;
  };
}
