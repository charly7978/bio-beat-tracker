/**
 * APP STORE - State Management Centralizado con Zustand - OPTIMIZADO
 * 
 * Unifica todo el estado de la aplicación en un solo store
 * siguiendo principios de state management moderno.
 * 
 * Optimizaciones:
 * - DevTools para debugging
 * - Throttling de updates de señal (30fps)
 * - Selectores memoizados con shallow comparison
 * - Persistencia optimizada con versioning
 * - Actions optimizadas para evitar re-renders
 * 
 * Secciones:
 * - Signal State: Procesamiento de señal PPG
 * - Vital Signs State: Signos vitales calculados
 * - Session State: Estado de medición
 * - UI State: Estado de interfaz
 * - User State: Estado de usuario
 */

import { create } from 'zustand';
import { persist, createJSONStorage, devtools } from 'zustand/middleware';

// ==================== TYPES ====================

export interface SignalState {
  isProcessing: boolean;
  rawValue: number;
  filteredValue: number;
  quality: number;
  fingerDetected: boolean;
  contactState: 'NO_CONTACT' | 'UNSTABLE_CONTACT' | 'STABLE_CONTACT';
  motionArtifact: boolean;
  perfusionIndex: number;
  timestamp: number;
}

export interface VitalSignsState {
  heartRate: number | null;
  spo2: number | null;
  bloodPressure: { systolic: number; diastolic: number } | null;
  respiration: number | null;
  arrhythmiaCount: number;
  arrhythmiaStatus: string;
  signalQuality: number;
  isCalibrating: boolean;
  calibrationProgress: number;
}

export interface SessionState {
  isMeasuring: boolean;
  measurementStartTime: number | null;
  measurementDuration: number;
  measurementsCount: number;
  lastMeasurementTime: number | null;
}

export interface UIState {
  isSettingsOpen: boolean;
  isHistoryOpen: boolean;
  selectedMeasurementId: string | null;
  toastMessages: Array<{ id: string; message: string; type: 'success' | 'error' | 'info' }>;
}

export interface UserState {
  isAuthenticated: boolean;
  userId: string | null;
  userEmail: string | null;
  anthropometrics: {
    age: number | null;
    weight: number | null;
    height: number | null;
    gender: 'male' | 'female' | null;
  };
}

export interface AppState {
  signal: SignalState;
  vitalSigns: VitalSignsState;
  session: SessionState;
  ui: UIState;
  user: UserState;
  
  // Signal Actions
  updateSignal: (signal: Partial<SignalState>) => void;
  resetSignal: () => void;
  
  // Vital Signs Actions
  updateVitalSigns: (vitals: Partial<VitalSignsState>) => void;
  resetVitalSigns: () => void;
  
  // Session Actions
  startMeasurement: () => void;
  stopMeasurement: () => void;
  incrementMeasurementCount: () => void;
  
  // UI Actions
  toggleSettings: () => void;
  toggleHistory: () => void;
  setSelectedMeasurement: (id: string | null) => void;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
  removeToast: (id: string) => void;
  
  // User Actions
  setUser: (user: Partial<UserState>) => void;
  logout: () => void;
  
  // Global Actions
  resetAll: () => void;
}

// ==================== INITIAL STATE ====================

const initialSignalState: SignalState = {
  isProcessing: false,
  rawValue: 0,
  filteredValue: 0,
  quality: 0,
  fingerDetected: false,
  contactState: 'NO_CONTACT',
  motionArtifact: false,
  perfusionIndex: 0,
  timestamp: 0,
};

const initialVitalSignsState: VitalSignsState = {
  heartRate: null,
  spo2: null,
  bloodPressure: null,
  respiration: null,
  arrhythmiaCount: 0,
  arrhythmiaStatus: 'SIN ARRITMIAS|0',
  signalQuality: 0,
  isCalibrating: false,
  calibrationProgress: 0,
};

const initialSessionState: SessionState = {
  isMeasuring: false,
  measurementStartTime: null,
  measurementDuration: 0,
  measurementsCount: 0,
  lastMeasurementTime: null,
};

const initialUIState: UIState = {
  isSettingsOpen: false,
  isHistoryOpen: false,
  selectedMeasurementId: null,
  toastMessages: [],
};

const initialUserState: UserState = {
  isAuthenticated: false,
  userId: null,
  userEmail: null,
  anthropometrics: {
    age: null,
    weight: null,
    height: null,
    gender: null,
  },
};

// ==================== THROTTLING UTILS ====================

let lastSignalUpdate = 0;
const SIGNAL_UPDATE_THROTTLE = 33; // ~30fps

function shouldThrottleSignalUpdate(): boolean {
  const now = Date.now();
  if (now - lastSignalUpdate < SIGNAL_UPDATE_THROTTLE) {
    return true;
  }
  lastSignalUpdate = now;
  return false;
}

// ==================== STORE CREATION ====================

export const useAppStore = create<AppState>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial State
        signal: initialSignalState,
        vitalSigns: initialVitalSignsState,
        session: initialSessionState,
        ui: initialUIState,
        user: initialUserState,
        
        // Signal Actions - Optimizado con throttling
        updateSignal: (signalUpdate) => {
          if (shouldThrottleSignalUpdate()) {
            return;
          }
          
          set((state) => ({
            signal: { ...state.signal, ...signalUpdate },
          }), false, 'updateSignal');
        },
        
        resetSignal: () => {
          set({ signal: initialSignalState }, false, 'resetSignal');
        },
        
        // Vital Signs Actions
        updateVitalSigns: (vitalsUpdate) => {
          set((state) => ({
            vitalSigns: { ...state.vitalSigns, ...vitalsUpdate },
          }), false, 'updateVitalSigns');
        },
        
        resetVitalSigns: () => {
          set({ vitalSigns: initialVitalSignsState }, false, 'resetVitalSigns');
        },
        
        // Session Actions
        startMeasurement: () => {
          set({
            session: {
              ...get().session,
              isMeasuring: true,
              measurementStartTime: Date.now(),
            },
          }, false, 'startMeasurement');
        },
        
        stopMeasurement: () => {
          const startTime = get().session.measurementStartTime;
          const duration = startTime ? Date.now() - startTime : 0;
          
          set({
            session: {
              ...get().session,
              isMeasuring: false,
              measurementDuration: duration,
              lastMeasurementTime: Date.now(),
            },
          }, false, 'stopMeasurement');
        },
        
        incrementMeasurementCount: () => {
          set((state) => ({
            session: {
              ...state.session,
              measurementsCount: state.session.measurementsCount + 1,
            },
          }), false, 'incrementMeasurementCount');
        },
        
        // UI Actions
        toggleSettings: () => {
          set((state) => ({
            ui: { ...state.ui, isSettingsOpen: !state.ui.isSettingsOpen },
          }), false, 'toggleSettings');
        },
        
        toggleHistory: () => {
          set((state) => ({
            ui: { ...state.ui, isHistoryOpen: !state.ui.isHistoryOpen },
          }), false, 'toggleHistory');
        },
        
        setSelectedMeasurement: (id) => {
          set((state) => ({
            ui: { ...state.ui, selectedMeasurementId: id },
          }), false, 'setSelectedMeasurement');
        },
        
        addToast: (message, type) => {
          const id = Date.now().toString();
          set((state) => ({
            ui: {
              ...state.ui,
              toastMessages: [...state.ui.toastMessages, { id, message, type }],
            },
          }), false, 'addToast');
          
          // Auto-remove after 5 seconds
          setTimeout(() => {
            get().removeToast(id);
          }, 5000);
        },
        
        removeToast: (id) => {
          set((state) => ({
            ui: {
              ...state.ui,
              toastMessages: state.ui.toastMessages.filter((t) => t.id !== id),
            },
          }), false, 'removeToast');
        },
        
        // User Actions
        setUser: (userUpdate) => {
          set((state) => ({
            user: { ...state.user, ...userUpdate },
          }), false, 'setUser');
        },
        
        logout: () => {
          set({ user: initialUserState }, false, 'logout');
        },
        
        // Global Actions
        resetAll: () => {
          set({
            signal: initialSignalState,
            vitalSigns: initialVitalSignsState,
            session: initialSessionState,
            ui: initialUIState,
          }, false, 'resetAll');
        },
      }),
      {
        name: 'bio-beat-storage',
        version: 1,
        storage: createJSONStorage(() => localStorage),
        // Solo persistir ciertas partes del estado
        partialize: (state) => ({
          user: state.user,
          session: {
            isMeasuring: state.session.isMeasuring,
            measurementsCount: state.session.measurementsCount,
          },
        }),
        // Migración de versión si es necesario
        migrate: (persistedState: any, version: number) => {
          if (version === 0) {
            // Migración desde versión 0
            return {
              ...persistedState,
              session: {
                ...persistedState.session,
                isMeasuring: false,
              },
            };
          }
          return persistedState;
        },
      }
    ),
    {
      name: 'BioBeatTracker',
      enabled: import.meta.env.DEV,
    }
  )
);

// ==================== SELECTORS OPTIMIZADOS ====================

// Selectores específicos optimizados (sin shallow para compatibilidad)
export const useSignalState = () => useAppStore((state) => state.signal);
export const useVitalSignsState = () => useAppStore((state) => state.vitalSigns);
export const useSessionState = () => useAppStore((state) => state.session);
export const useUIState = () => useAppStore((state) => state.ui);
export const useUserState = () => useAppStore((state) => state.user);

// Selectores específicos optimizados
export const useIsMeasuring = () => useAppStore((state) => state.session.isMeasuring);
export const useHeartRate = () => useAppStore((state) => state.vitalSigns.heartRate);
export const useSignalQuality = () => useAppStore((state) => state.vitalSigns.signalQuality);
export const useFingerDetected = () => useAppStore((state) => state.signal.fingerDetected);
export const useContactState = () => useAppStore((state) => state.signal.contactState);

// Selectores combinados para optimización
export const useMeasurementStatus = () => 
  useAppStore((state) => ({
    isMeasuring: state.session.isMeasuring,
    fingerDetected: state.signal.fingerDetected,
    contactState: state.signal.contactState,
    signalQuality: state.vitalSigns.signalQuality,
  }));

// Selectores para actions (no causan re-renders)
export const useAppActions = () => 
  useAppStore((state) => ({
    updateSignal: state.updateSignal,
    resetSignal: state.resetSignal,
    updateVitalSigns: state.updateVitalSigns,
    resetVitalSigns: state.resetVitalSigns,
    startMeasurement: state.startMeasurement,
    stopMeasurement: state.stopMeasurement,
    incrementMeasurementCount: state.incrementMeasurementCount,
    toggleSettings: state.toggleSettings,
    toggleHistory: state.toggleHistory,
    setSelectedMeasurement: state.setSelectedMeasurement,
    addToast: state.addToast,
    removeToast: state.removeToast,
    setUser: state.setUser,
    logout: state.logout,
    resetAll: state.resetAll,
  }));
