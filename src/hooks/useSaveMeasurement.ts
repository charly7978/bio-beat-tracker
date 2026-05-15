import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import { toast } from '@/hooks/use-toast';
import {
  buildAttemptDiagnostics,
  evaluateFinalMeasurementSave,
} from '@/lib/measurements/savePolicy';

interface MeasurementData {
  vitalSigns: VitalSignsResult;
  signalQuality: number;
}

async function insertMeasurementAttempt(
  userId: string,
  outcome: string,
  signalQuality: number,
  diagnostics: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from('measurement_attempts').insert({
    user_id: userId,
    outcome,
    signal_quality: Math.round(signalQuality),
    diagnostics: diagnostics as Json,
  });
  if (error) {
    console.warn('[measurement_attempts]', error.message);
  }
}

/**
 * Guarda intentos siempre que haya sesión (auditoría) y solo escribe en `measurements`
 * cuando la política clínica/técnica permite una fila final válida.
 */
export const useSaveMeasurement = () => {
  const saveMeasurement = useCallback(async (data: MeasurementData): Promise<boolean> => {
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();

      if (authError || !user) {
        console.log('⚠️ Usuario no autenticado, medición no guardada');
        return false;
      }

      const sq = Math.round(data.signalQuality);
      const { canSaveFinal, outcome, reasons } = evaluateFinalMeasurementSave(
        data.vitalSigns,
        sq
      );
      const diagnostics = buildAttemptDiagnostics(data.vitalSigns, sq, reasons);

      if (!canSaveFinal) {
        await insertMeasurementAttempt(user.id, outcome, sq, diagnostics);
        console.log('⚠️ Medición no válida como final — solo intento registrado:', reasons.join(', '));
        toast({
          title: 'Medición no guardada en historial',
          description: 'La señal o los estados no cumplen criterios para una fila clínica final. Se registró el intento.',
          duration: 4500,
        });
        return false;
      }

      const vs = data.vitalSigns;
      const hr = Math.round(vs.heartRate.value ?? 0);
      const spo2 = vs.spo2.status === 'VALID' && vs.spo2.value != null ? Math.round(vs.spo2.value) : 0;
      const sys =
        vs.bloodPressure.status === 'VALID' && vs.bloodPressure.value
          ? Math.round(vs.bloodPressure.value.systolic)
          : 0;
      const dia =
        vs.bloodPressure.status === 'VALID' && vs.bloodPressure.value
          ? Math.round(vs.bloodPressure.value.diastolic)
          : 0;

      const measurementRecord = {
        user_id: user.id,
        heart_rate: hr,
        spo2,
        systolic: sys,
        diastolic: dia,
        arrhythmia_count: vs.arrhythmia.value.count || 0,
        quality: sq,
        measured_at: new Date().toISOString(),
      };

      const { error: insertError } = await supabase.from('measurements').insert(measurementRecord);

      if (insertError) {
        console.error('❌ Error guardando medición:', insertError);
        await insertMeasurementAttempt(user.id, 'rejected_incomplete', sq, {
          ...diagnostics,
          insertError: insertError.message,
        });
        toast({
          title: 'Error al guardar',
          description: 'No se pudo guardar la medición',
          variant: 'destructive',
          duration: 3000,
        });
        return false;
      }

      await insertMeasurementAttempt(user.id, 'valid_saved', sq, diagnostics);

      console.log('✅ Medición guardada exitosamente');
      toast({
        title: '✅ Medición guardada',
        description: 'Los resultados se guardaron en tu historial',
        duration: 3000,
      });

      return true;
    } catch (error) {
      console.error('❌ Error inesperado:', error);
      return false;
    }
  }, []);

  return { saveMeasurement };
};
