import type { VitalSignsResult } from '../../modules/vital-signs/VitalSignsProcessor';

export interface HealthMetric {
  type: 'HEART_RATE' | 'BLOOD_PRESSURE' | 'SPO2' | 'RESPIRATORY_RATE';
  value: number;
  unit: string;
  timestamp: number;
  source: string;
}

let healthPlugin: any = null;

async function getHealthPlugin() {
  if (healthPlugin) return healthPlugin;
  try {
    const mod = await import('@capgo/capacitor-health');
    healthPlugin = mod.Health;
    return healthPlugin;
  } catch {
    return null;
  }
}

export class HealthBridge {
  private available = false;
  private checked = false;

  async checkAvailability(): Promise<boolean> {
    if (this.checked) return this.available;
    this.checked = true;
    const plugin = await getHealthPlugin();
    if (!plugin) return false;
    try {
      const result = await plugin.isAvailable();
      this.available = result.available;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  get isAvailable(): boolean { return this.available; }

  async requestPermissions(): Promise<boolean> {
    const plugin = await getHealthPlugin();
    if (!plugin) return false;
    try {
      const result = await plugin.requestPermissions();
      return result.granted;
    } catch {
      return false;
    }
  }

  async saveVitals(vitals: VitalSignsResult): Promise<boolean> {
    const plugin = await getHealthPlugin();
    if (!plugin) return false;

    const metrics: HealthMetric[] = [];
    const now = Date.now();

    if (vitals.heartRate.value && vitals.heartRate.value > 0) {
      metrics.push({
        type: 'HEART_RATE', value: vitals.heartRate.value,
        unit: 'bpm', timestamp: now, source: 'bio-beat-tracker',
      });
    }

    if (vitals.bloodPressure.value?.systolic && vitals.bloodPressure.value.systolic > 0) {
      metrics.push({
        type: 'BLOOD_PRESSURE', value: vitals.bloodPressure.value.systolic,
        unit: 'mmHg', timestamp: now, source: 'bio-beat-tracker',
      });
    }

    if (vitals.spo2.value && vitals.spo2.value > 0) {
      metrics.push({
        type: 'SPO2', value: vitals.spo2.value,
        unit: '%', timestamp: now, source: 'bio-beat-tracker',
      });
    }

    if (metrics.length === 0) return false;

    try {
      for (const metric of metrics) {
        await plugin.saveHealthData(metric);
      }
      return true;
    } catch {
      return false;
    }
  }

  async readRecentHeartRate(minutes: number = 60): Promise<HealthMetric[]> {
    const plugin = await getHealthPlugin();
    if (!plugin) return [];
    try {
      const result = await plugin.queryHealthData({
        type: 'HEART_RATE',
        startDate: Date.now() - minutes * 60 * 1000,
        endDate: Date.now(),
      });
      return result?.data || [];
    } catch {
      return [];
    }
  }
}

export const healthBridge = new HealthBridge();
