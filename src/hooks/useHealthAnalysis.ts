import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import { toast } from '@/hooks/use-toast';

interface AnalysisInput {
  vitalSigns: VitalSignsResult;
  quality: number;
}

export const useHealthAnalysis = () => {
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const analyzeVitals = useCallback(async (data: AnalysisInput) => {
    if (isAnalyzing) return;

    const { vitalSigns, quality } = data;
    const hr = vitalSigns.heartRate.value;

    if ((hr == null || hr <= 0) && (vitalSigns.spo2.value == null || vitalSigns.spo2.value <= 0)) {
      toast({
        title: "Datos insuficientes",
        description: "Se necesitan datos de medición válidos para el análisis.",
        variant: "destructive",
        duration: 3000
      });
      return;
    }

    if (vitalSigns.heartRate.status !== 'VALID' || quality < 40) {
      toast({
        title: "Calidad insuficiente",
        description: "El análisis IA requiere HR en estado VALID y señal razonablemente estable.",
        variant: "destructive",
        duration: 3500
      });
      return;
    }

    // Solo enviar datos que realmente se midieron — sin valores ficticios de relleno
    const bodyPayload: Record<string, unknown> = {
      quality,
      arrhythmiaCount: vitalSigns.arrhythmia.value.count,
    };
    if (hr > 0) bodyPayload.heartRate = hr;
    if (vitalSigns.spo2.value != null && vitalSigns.spo2.value > 0) bodyPayload.spo2 = vitalSigns.spo2.value;
    const bpVal = vitalSigns.bloodPressure.value;
    if (bpVal && bpVal.systolic > 0) bodyPayload.systolic = bpVal.systolic;
    if (bpVal && bpVal.diastolic > 0) bodyPayload.diastolic = bpVal.diastolic;

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
