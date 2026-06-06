import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json, TablesInsert } from '@/integrations/supabase/types';
import { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import { toast } from '@/hooks/use-toast';
import {
  buildAttemptDiagnostics,
  evaluateFinalMeasurementSave,
  type ArtifactMetrics,
} from '@/lib/measurements/savePolicy';
import { ValidationDataset } from '@/modules/vital-signs/ValidationDataset';
import { CalibrationManager } from '@/modules/vital-signs/CalibrationManager';
import { createLogger } from '@/utils/logger';

const log = createLogger('useSaveMeasurement');

interface MeasurementData {
  vitalSigns: VitalSignsResult;
  signalQuality: number;
  artifactMetrics?: ArtifactMetrics;
}

async function insertMeasurementAttempt(
  userId: string,
  outcome: string,
  signalQuality: number,
  diagnostics: Record<string, unknown>
): Promise<void> {
  const row: TablesInsert<'measurement_attempts'> = {
    user_id: userId,
    outcome,
    signal_quality: Math.round(signalQuality),
    diagnostics: diagnostics as Json,
  };
  const { error } = await supabase.from('measurement_attempts').insert(row);
  if (error) {
    log.warn('[measurement_attempts]', error.message);
  }
}

/**
 * Guarda intentos siempre que haya sesión (auditoría) y solo escribe en `measurements`
 * cuando la política clínica/técnica permite una fila final válida.
 */
export const useSaveMeasurement = () => {
  const saveMeasurement = useCallback(async (data: MeasurementData): Promise<boolean> => {
    try {
      const sq = Math.round(data.signalQuality);
      const artifactMetrics = data.artifactMetrics;
      const { canSaveFinal, outcome, reasons } = evaluateFinalMeasurementSave(
        data.vitalSigns,
        sq,
        artifactMetrics,
      );
      const diagnostics = buildAttemptDiagnostics(data.vitalSigns, sq, reasons, artifactMetrics);

      if (!canSaveFinal) {
        // Guardar intento si el usuario tiene sesión (auditoría en la nube)
        try {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            await insertMeasurementAttempt(user.id, outcome, sq, diagnostics);
          }
        } catch {
          log.debug('Offline — measurement attempt skipped');
        }

        log.warn('Medición no válida como final — solo intento registrado:', reasons.join(', '));
        toast({
          title: 'Medición no guardada en historial',
          description: 'La señal o los estados no cumplen criterios para una fila clínica final.',
          duration: 4500,
        });
        return false;
      }

      // Preparar valores
      const vs = data.vitalSigns;
      const hr = Math.round(vs.heartRate.value ?? 0);
      const spo2 = Math.round(vs.spo2.value ?? 0);
      const sys = Math.round(vs.bloodPressure.value?.systolic ?? 0);
      const dia = Math.round(vs.bloodPressure.value?.diastolic ?? 0);

      // Add to Validation Dataset
      try {
        const calib = CalibrationManager.getInstance();
        const bpProfile = calib.getActiveProfile('BP');
        const spo2Profile = calib.getActiveProfile('SPO2');

        ValidationDataset.addEntry({
          timestamp: new Date().toISOString(),
          device: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
          quality: {
            sqi: sq,
            pi: vs.heartRate.signalQuality?.perfusionIndex ?? 0,
            fps: vs.heartRate.signalQuality?.fpsEffective ?? 30,
            jitter: vs.heartRate.signalQuality?.timestampJitterMs ?? 0,
          },
          rr: [],
          vitals: vs,
          reference: {
            bpm: null,
            spo2: (spo2Profile?.referenceValues as Record<string, number | undefined>)?.spo2 ?? null,
            systolic: bpProfile?.referenceValues?.systolic ?? null,
            diastolic: bpProfile?.referenceValues?.diastolic ?? null,
          }
        });
      } catch (e) {
        log.warn('Failed to add to validation dataset:', e);
      }

      // Intentar obtener usuario
      let user = null;
      let authError = null;
      try {
        const authRes = await supabase.auth.getUser();
        user = authRes.data.user;
        authError = authRes.error;
      } catch (e) {
        authError = e;
      }

      let savedLocally = false;

      if (authError || !user) {
        console.log('⚠️ Guardando medición localmente (sin sesión activa o red offline)...');
        const localMeasurementsStr = localStorage.getItem('local_measurements');
        const localMeasurements = localMeasurementsStr ? JSON.parse(localMeasurementsStr) : [];
        
        const newRecord = {
          id: `local_${Date.now()}`,
          heart_rate: hr,
          spo2,
          systolic: sys,
          diastolic: dia,
          arrhythmia_count: vs.arrhythmia.value?.count ?? 0,
          quality: sq,
          measured_at: new Date().toISOString(),
        };

        localMeasurements.push(newRecord);
        localStorage.setItem('local_measurements', JSON.stringify(localMeasurements));
        savedLocally = true;

        toast({
          title: '✅ Guardado localmente',
          description: 'Medición guardada en el historial de este dispositivo.',
          duration: 3000,
        });
      }

      if (!savedLocally && user) {
        const measurementRecord = {
          user_id: user.id,
          heart_rate: hr,
          spo2,
          systolic: sys,
          diastolic: dia,
          arrhythmia_count: vs.arrhythmia.value?.count ?? 0,
          quality: sq,
          measured_at: new Date().toISOString(),
        };

        const { error: insertError } = await supabase.from('measurements').insert(measurementRecord);

        if (insertError) {
          log.error('Error guardando en Supabase:', insertError);
          await insertMeasurementAttempt(user.id, 'rejected_incomplete', sq, {
            ...diagnostics,
            insertError: insertError.message,
          });

          // Fallback a localStorage si falla la escritura en la nube
          const localMeasurementsStr = localStorage.getItem('local_measurements');
          const localMeasurements = localMeasurementsStr ? JSON.parse(localMeasurementsStr) : [];
          localMeasurements.push({
            id: `local_${Date.now()}`,
            heart_rate: hr,
            spo2,
            systolic: sys,
            diastolic: dia,
            arrhythmia_count: vs.arrhythmia.value?.count ?? 0,
            quality: sq,
            measured_at: new Date().toISOString(),
          });
          localStorage.setItem('local_measurements', JSON.stringify(localMeasurements));

          toast({
            title: '⚠️ Guardado localmente',
            description: 'No se pudo subir a la nube. Guardado en este dispositivo.',
            duration: 4000,
          });
          return true;
        }

        await insertMeasurementAttempt(user.id, 'valid_saved', sq, diagnostics);

        log.info('Medición guardada exitosamente en la nube');
        toast({
          title: '✅ Medición sincronizada',
          description: 'Los resultados se sincronizaron con tu cuenta en la nube.',
          duration: 3000,
        });
      }

      return true;
    } catch (error) {
      log.error('Error inesperado al guardar medición:', error);
      return false;
    }
  }, []);

  return { saveMeasurement };
};
