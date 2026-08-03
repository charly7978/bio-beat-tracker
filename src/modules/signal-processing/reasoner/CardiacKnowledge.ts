export class CardiacKnowledge {
  static readonly CARDIA_CYCLE = {
    systolicPhaseMs: { min: 200, max: 400 },
    diastolicPhaseMs: { min: 400, max: 800 },
    isovolumetricContractionMs: { min: 30, max: 70 },
    isovolumetricRelaxationMs: { min: 50, max: 90 },
    normalHeartRateBpm: { min: 60, max: 100 },
    fullRangeBpm: { min: 30, max: 220 },
    hrvPercent: { min: 5, max: 15 },
    arrhythmiaThreshold: 0.20,
  };

  static readonly PPG_SIGNAL = {
    acDcRatio: { min: 0.01, max: 0.15 },
    cardiacBandHz: { min: 0.5, max: 4.0 },
    systolicRiseSlope: { min: 0.3, max: 1.0 },
    diastolicDecaySlope: { min: -0.5, max: -0.1 },
    hasDicroticNotch: true,
    notchPositionRatio: { min: 0.5, max: 0.75 },
  };

  static readonly BEER_LAMBERT = {
    greenWavelength: 525,
    redWavelength: 660,
    nearIRWavelength: 940,
    hemoglobinExtinction: {
      hbO2: { green: 0.5, red: 0.1, nir: 0.3 },
      hb: { green: 0.4, red: 0.8, nir: 0.2 },
    },
    spo2Normal: { min: 95, max: 100 },
    spo2Critical: 90,
  };

  static readonly HEMODYNAMICS = {
    mapNormal: { min: 70, max: 100 },
    systolicNormal: { min: 100, max: 130 },
    diastolicNormal: { min: 60, max: 80 },
    windkesselDefault: {
      R1: 0.05,
      C: 1.5,
      R2: 0.15,
    },
  };

  static readonly ARRHYTHMIA = {
    normalHrvPercent: { min: 5, max: 15 },
    atrialFibrillationThreshold: 0.30,
    prematureBeatRrRatio: 0.60,
    compensatoryPauseRatio: 1.20,
    minIntervalsForDetection: 8,
  };

  static readonly RESPIRATORY = {
    normalRateBpm: { min: 12, max: 20 },
    eupneaHz: { min: 0.2, max: 0.34 },
    ppgAmplitudeModulationPercent: { min: 5, max: 15 },
    ppgBaselineModulationPercent: { min: 2, max: 10 },
  };
}
