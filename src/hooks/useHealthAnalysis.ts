import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import { toast } from '@/hooks/use-toast';

interface AnalysisInput {
  heartRate: number;
  vitalSigns: VitalSignsResult;
  quality: number;
}

export const useHealthAnalysis = () => {
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const analyzeVitals = useCallback(async (data: AnalysisInput) => {
    if (isAnalyzing) return;

    const { heartRate, vitalSigns, quality } = data;

    if (heartRate <= 0 && vitalSigns.spo2.value <= 0) {
      toast({
        title: "Datos insuficientes",
        description: "Se necesitan datos de medición válidos para el análisis.",
        variant: "destructive",
        duration: 3000
      });
      return;
    }

    // Solo enviar datos que realmente se midieron — sin valores ficticios de relleno
    const bodyPayload: Record<string, unknown> = {
      quality,
      confidence: vitalSigns.measurementConfidence,
      arrhythmiaCount: vitalSigns.arrhythmiaCount,
    };
    if (heartRate > 0) bodyPayload.heartRate = heartRate;
    if (vitalSigns.spo2.value > 0) bodyPayload.spo2 = vitalSigns.spo2.value;
    if (vitalSigns.bloodPressure.value.systolic > 0) bodyPayload.systolic = vitalSigns.bloodPressure.value.systolic;
    if (vitalSigns.bloodPressure.value.diastolic > 0) bodyPayload.diastolic = vitalSigns.bloodPressure.value.diastolic;

    setIsAnalyzing(true);
    setAnalysis(null);

    try {
      const { data: result, error } = await supabase.functions.invoke('analyze-vitals', {
        body: bodyPayload
      });


      if (error) {
        throw new Error(error.message || 'Error al analizar');
      }

      setAnalysis(result.analysis);
    } catch (err: any) {
      console.error('Error análisis AI:', err);
      const msg = err?.message || 'Error desconocido';
      if (msg.includes('429') || msg.includes('rate')) {
        toast({ title: "Demasiadas solicitudes", description: "Intenta de nuevo en unos segundos.", variant: "destructive", duration: 4000 });
      } else if (msg.includes('402') || msg.includes('payment') || msg.includes('créditos')) {
        toast({ title: "Créditos agotados", description: "Añade créditos para usar el análisis AI.", variant: "destructive", duration: 4000 });
      } else {
        toast({ title: "Error de análisis", description: msg, variant: "destructive", duration: 4000 });
      }
    } finally {
      setIsAnalyzing(false);
    }
  }, [isAnalyzing]);

  const clearAnalysis = useCallback(() => {
    setAnalysis(null);
  }, []);

  return { analysis, isAnalyzing, analyzeVitals, clearAnalysis };
};
