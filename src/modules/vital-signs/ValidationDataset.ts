import { VitalSignsResult } from './VitalSignsProcessor';

export interface ValidationDatasetEntry {
  timestamp: string;
  device: string;
  quality: {
    sqi: number;
    pi: number;
    fps: number;
    jitter: number;
  };
  rr: number[];
  vitals: VitalSignsResult;
  reference: {
    bpm: number | null;
    spo2: number | null;
    systolic: number | null;
    diastolic: number | null;
  };
}

export class ValidationDataset {
  private static readonly STORAGE_KEY = 'biobeat_validation_dataset';

  public static addEntry(entry: ValidationDatasetEntry): void {
    const data = this.getDataset();
    data.push(entry);
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
  }

  public static getDataset(): ValidationDatasetEntry[] {
    const raw = localStorage.getItem(this.STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  }

  public static exportJSON(): string {
    return JSON.stringify(this.getDataset(), null, 2);
  }

  public static clear(): void {
    localStorage.removeItem(this.STORAGE_KEY);
  }
}
