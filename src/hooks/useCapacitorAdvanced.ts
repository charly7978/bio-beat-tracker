import { useState, useEffect, useCallback } from 'react';
import { healthBridge } from '../lib/capacitor/healthBridge';
import { backgroundMonitor } from '../lib/capacitor/backgroundMonitor';
import { Preferences } from '@capacitor/preferences';
import type { VitalSignsResult } from '../modules/vital-signs/VitalSignsProcessor';

export function useCapacitorAdvanced() {
  const [healthAvailable, setHealthAvailable] = useState(false);
  const [healthPermission, setHealthPermission] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);

  useEffect(() => {
    healthBridge.checkAvailability().then(setHealthAvailable);
    backgroundMonitor.initialize();
    setPreferencesReady(true);
  }, []);

  const requestHealthPermission = useCallback(async () => {
    const granted = await healthBridge.requestPermissions();
    setHealthPermission(granted);
    return granted;
  }, []);

  const saveToHealth = useCallback(async (vitals: VitalSignsResult) => {
    return healthBridge.saveVitals(vitals);
  }, []);

  const startBackgroundMonitor = useCallback(() => {
    backgroundMonitor.startSession();
  }, []);

  const stopBackgroundMonitor = useCallback(() => {
    backgroundMonitor.endSession();
  }, []);

  const updateBackgroundMetrics = useCallback((
    hr: number, spo2: number, bpSys: number, bpDia: number,
  ) => {
    backgroundMonitor.updateMetrics(hr, spo2, bpSys, bpDia);
  }, []);

  const storePreference = useCallback(async (key: string, value: string) => {
    await Preferences.set({ key, value });
  }, []);

  const getPreference = useCallback(async (key: string): Promise<string | null> => {
    const result = await Preferences.get({ key });
    return result.value;
  }, []);

  const removePreference = useCallback(async (key: string) => {
    await Preferences.remove({ key });
  }, []);

  return {
    healthAvailable, healthPermission, preferencesReady,
    requestHealthPermission, saveToHealth,
    startBackgroundMonitor, stopBackgroundMonitor, updateBackgroundMetrics,
    storePreference, getPreference, removePreference,
  };
}
