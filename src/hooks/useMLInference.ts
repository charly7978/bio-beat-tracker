import { useRef, useEffect, useState, useCallback } from 'react';
import { ppgClassifier, type PPGClassification } from '../lib/ml/ppgClassifier';
import { healthRiskAnalyzer, type HealthRiskScore } from '../lib/ml/riskAnalyzer';
import type { VitalSignsResult } from '../modules/vital-signs/VitalSignsProcessor';

export function useMLInference() {
  const [mlReady, setMlReady] = useState(false);
  const [ppgClass, setPpgClass] = useState<PPGClassification | null>(null);
  const [riskScore, setRiskScore] = useState<HealthRiskScore | null>(null);
  const classifierRef = useRef(ppgClassifier);
  const analyzerRef = useRef(healthRiskAnalyzer);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    ppgClassifier.initialize().then(() => setMlReady(true)).catch(() => setMlReady(true));
  }, []);

  const classifySignal = useCallback((
    signalBuffer: Float64Array,
    sampleRate: number,
    sqi: number,
  ): PPGClassification => {
    const result = classifierRef.current.classify(signalBuffer, sampleRate, sqi);
    setPpgClass(result);
    return result;
  }, []);

  const analyzeVitals = useCallback((
    vitals: VitalSignsResult,
    age?: number,
  ): HealthRiskScore => {
    const result = analyzerRef.current.analyze(vitals, undefined, age);
    setRiskScore(result);
    return result;
  }, []);

  return { mlReady, ppgClass, riskScore, classifySignal, analyzeVitals };
}
