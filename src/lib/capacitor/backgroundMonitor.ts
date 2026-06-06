import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory } from '@capacitor/filesystem';

interface MonitorState {
  isMonitoring: boolean;
  lastHeartRate: number;
  lastSpO2: number;
  lastBPSys: number;
  lastBPDia: number;
  sessionStartTime: number;
  totalFrames: number;
}

const STORAGE_KEY = 'bb-monitor-state';

export class BackgroundMonitor {
  private state: MonitorState = {
    isMonitoring: false, lastHeartRate: 0, lastSpO2: 0,
    lastBPSys: 0, lastBPDia: 0, sessionStartTime: 0, totalFrames: 0,
  };

  async initialize(): Promise<void> {
    try {
      const stored = await Preferences.get({ key: STORAGE_KEY });
      if (stored.value) this.state = JSON.parse(stored.value);
    } catch { /* use defaults */ }

    App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) this.persistState();
    });
  }

  async updateMetrics(hr: number, spo2: number, bpSys: number, bpDia: number): Promise<void> {
    this.state.lastHeartRate = hr || this.state.lastHeartRate;
    this.state.lastSpO2 = spo2 || this.state.lastSpO2;
    this.state.lastBPSys = bpSys || this.state.lastBPSys;
    this.state.lastBPDia = bpDia || this.state.lastBPDia;
    this.state.totalFrames++;
  }

  startSession(): void {
    this.state = {
      isMonitoring: true, lastHeartRate: 0, lastSpO2: 0,
      lastBPSys: 0, lastBPDia: 0, sessionStartTime: Date.now(), totalFrames: 0,
    };
  }

  endSession(): void {
    this.state.isMonitoring = false;
    this.persistState();
    this.exportSessionData();
  }

  async persistState(): Promise<void> {
    await Preferences.set({
      key: STORAGE_KEY,
      value: JSON.stringify(this.state),
    });
  }

  async exportSessionData(): Promise<void> {
    if (this.state.totalFrames === 0) return;
    const data = JSON.stringify(this.state, null, 2);
    const filename = `session-${this.state.sessionStartTime}.json`;
    try {
      await Filesystem.writeFile({
        path: filename,
        data,
        directory: Directory.Documents,
      });
    } catch (e) {
      console.warn('[BackgroundMonitor] Export failed:', e);
    }
  }

  getState(): MonitorState { return { ...this.state }; }
}

export const backgroundMonitor = new BackgroundMonitor();
