import { CalibrationInfo } from '../../types/measurements';

export type CalibrationType = 'SPO2' | 'BP' | 'DEVICE' | 'PPG_BASELINE';

export interface CalibrationProfile {
  id: string;
  type: CalibrationType;
  deviceId: string;
  modelName: string;
  coefficients: Record<string, number>;
  referenceValues: Record<string, number>;
  createdAt: number;
  expiresAt: number;
  method: string;
}

export class CalibrationManager {
  private static instance: CalibrationManager;
  private profiles: Map<string, CalibrationProfile> = new Map();
  private activeProfileId: string | null = null;

  private constructor() {
    this.loadFromStorage();
  }

  public static getInstance(): CalibrationManager {
    if (!CalibrationManager.instance) {
      CalibrationManager.instance = new CalibrationManager();
    }
    return CalibrationManager.instance;
  }

  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem('calibration_profiles');
      if (stored) {
        const parsed = JSON.parse(stored);
        Object.keys(parsed).forEach(id => {
          this.profiles.set(id, parsed[id]);
        });
      }
      this.activeProfileId = localStorage.getItem('active_calibration_id');
    } catch (e) {
      console.error('Error loading calibrations:', e);
    }
  }

  private saveToStorage(): void {
    try {
      const obj: Record<string, CalibrationProfile> = {};
      this.profiles.forEach((p, id) => {
        obj[id] = p;
      });
      localStorage.setItem('calibration_profiles', JSON.stringify(obj));
      if (this.activeProfileId) {
        localStorage.setItem('active_calibration_id', this.activeProfileId);
      }
    } catch (e) {
      console.error('Error saving calibrations:', e);
    }
  }

  public addProfile(profile: CalibrationProfile): void {
    this.profiles.set(profile.id, profile);
    this.activeProfileId = profile.id;
    this.saveToStorage();
  }

  public getProfile(id: string): CalibrationProfile | undefined {
    return this.profiles.get(id);
  }

  public getActiveProfile(type: CalibrationType): CalibrationProfile | undefined {
    if (this.activeProfileId) {
      const p = this.profiles.get(this.activeProfileId);
      if (p && p.type === type && p.expiresAt > Date.now()) {
        return p;
      }
    }
    
    // Fallback search for latest valid of type
    const valid = Array.from(this.profiles.values())
      .filter(p => p.type === type && p.expiresAt > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt);
    
    return valid[0];
  }

  public getCalibrationInfo(type: CalibrationType): CalibrationInfo {
    let profile = this.getActiveProfile(type);
    if (!profile) {
      const candidates = Array.from(this.profiles.values())
        .filter((p) => p.type === type)
        .sort((a, b) => b.createdAt - a.createdAt);
      profile = candidates[0];
    }
    const now = Date.now();
    const expired = !!(profile && profile.expiresAt <= now);
    return {
      required: type === 'BP' || type === 'SPO2',
      available: !!profile && !expired,
      expired,
      profileId: profile?.id,
      lastCalibrationAt: profile?.createdAt,
      expiresAt: profile?.expiresAt,
      method: profile?.method
    };
  }

  /** Aplica offsets de perfil BP vigente (referencia tensiómetro). */
  public applyBloodPressureCalibration(
    systolic: number,
    diastolic: number,
  ): { systolic: number; diastolic: number; applied: boolean } {
    const profile = this.getActiveProfile('BP');
    if (!profile || profile.expiresAt <= Date.now()) {
      return { systolic, diastolic, applied: false };
    }
    const sbpOff = profile.coefficients.sbpOffset ?? profile.coefficients.systolicOffset ?? 0;
    const dbpOff = profile.coefficients.dbpOffset ?? profile.coefficients.diastolicOffset ?? 0;
    return {
      systolic: systolic + sbpOff,
      diastolic: diastolic + dbpOff,
      applied: sbpOff !== 0 || dbpOff !== 0,
    };
  }

  public reset(): void {
    this.profiles.clear();
    this.activeProfileId = null;
    localStorage.removeItem('calibration_profiles');
    localStorage.removeItem('active_calibration_id');
  }
}
