# Arquitectura — Bio Beat Tracker (PPG por cámara)

Documentación alineada al código en `main`. **No es validación clínica SaMD**; describe el pipeline técnico real, sus límites y trazabilidad.

## Resumen

Aplicación React/TypeScript que estima signos vitales a partir de **fotopletismografía (PPG)** con la cámara trasera del smartphone y el **flash (torch)**. Cada valor publicado lleva (o debe llevar) `status`, `confidence`, `reason` y métricas de calidad; **no se inventan números** cuando la señal es insuficiente.

## Flujo end-to-end

```
CameraView (MediaStream, torch, capabilities/settings)
    │ requestVideoFrameCallback + FPS/jitter reales
    ▼
useSignalProcessor → PPGSignalProcessor
    │ ROI adaptativo, dedo (color + dinámica), AC/DC, bandpass, SQI frame
    ▼
ProcessedSignal
    ├─► useHeartBeatProcessor → HeartBeatProcessor
    │       PeakDetectionEnsemble (Elgendi + Pan–Tompkins PPG + espectral)
    │       → BPM, RR, isPeak, ensembleDiagnostics
    └─► useVitalSignsProcessor → VitalSignsProcessor
            ├─ SpO2 (ratio-of-ratios + calibración)
            ├─ BloodPressureProcessor (morfología + calibración individual)
            ├─ respiración (modulación PPG)
            └─ ArrhythmiaProcessor (RR + HRV)
    ▼
Index.tsx → PPGSignalMeter + DebugTelemetryPanel + Supabase
```

## Fuentes de verdad (anti-duplicación)

| Dominio | Módulo canónico |
|--------|------------------|
| Contrato de medición | `src/types/measurements.ts` (`VitalMeasurement`, `PeakDetectionResult`) |
| Umbrales fisiológicos y **gates de `VALID`** | `src/config/vitalThresholds.ts` (`VITAL_THRESHOLDS.GATES`) |
| Restricciones de captura (`getUserMedia`) | `src/config/cameraConstraints.ts` |
| DSP / picos (ventanas, BPM min/max) | `src/config/signalProcessing.ts` |
| Filtros y utilidades DSP | `src/modules/signal-processing/shared/dsp.ts` |
| SQI central | `src/modules/signal-quality/SignalQualityIndex.ts` |
| Calibración | `src/modules/vital-signs/CalibrationManager.ts` |
| Estado de adquisición | `src/lib/acquisition/resolveAcquisitionStatus.ts` |

CI ejecuta `npm run check:architecture` para impedir procesadores paralelos y rutas legacy.

## Cámara y flash

`CameraView` usa la API estándar y **constraints declarados** en `src/config/cameraConstraints.ts` (una sola fuente para `getUserMedia`):

- `getSupportedConstraints`, `getCapabilities`, `getSettings`, `applyConstraints`
- Informe `DeviceCapabilityReport`: resolución real, FPS efectivo, `timestampJitterMs`, `frameDropRatio`, torch soportado/activo

La medición **no asume** torch ni FPS solicitados: baja `confidence` o bloquea con estados técnicos (`TORCH_UNAVAILABLE`, `LOW_FPS`, etc.).

## ROI y contacto con el dedo

`PPGSignalProcessor` + `fingerSceneClassifier` / `fingerRoiPulsation`:

- ROI central y adaptativo, rechazo de saturación/subexposición
- **No se acepta dedo solo por color**: hace falta evidencia pulsátil (perfusión, estabilidad temporal)
- Estados: `NO_CONTACT`, `UNSTABLE_CONTACT`, `VALID_CONTACT`, saturación, movimiento, etc.

## Detección de picos

### Elgendi (`ElgendiPeakDetector.ts`)

Basado en medias móviles de evento (MApeak / MAbeat), offset adaptativo, un pico por bloque, distancia mínima según BPM máximo, prominencia y SQI.

### Pan–Tompkins adaptado a PPG (`PanTompkinsPPGDetector.ts`)

**No es ECG/QRS.** Pipeline PPG: bandpass → derivada (upstroke) → cuadrado → integración por ventana → umbrales adaptativos + searchback + período refractario.

### Ensemble (`PeakDetectionEnsemble.ts`)

1. Ejecuta Elgendi y Pan–Tompkins sobre la misma ventana.
2. Fusiona picos dentro de ~110 ms; registra rechazados (`NO_PAN_MATCH`, `NO_ELGENDI_MATCH`, `SPECTRAL_MISMATCH`).
3. Compara con autocorrelación/espectral (`bpmFromAutocorr` en `dsp.ts`).
4. Devuelve `PeakDetectionResult`: `peaks`, `peakTimes`, `rrIntervalsMs`, `bpmInstant`, `confidence`, `agreement`, `diagnostics` (incluye `elgendiPeakTimes`, `panTompkinsPeakTimes`, `fusedPeakTimes` para UI).

`HeartBeatProcessor` es el **único** consumidor productivo del ensemble para BPM y emite `ensembleDiagnostics` hacia la UI.

## SQI y vitales

`SignalQualityIndex` calcula SQI a partir de perfusión, SNR, periodicidad, clipping, saturación, movimiento, FPS y jitter.

`enrichMetrics()` combina el SQI de frame con el acuerdo Elgendi/Pan–Tompkins para que SpO2, PA y respiración no traten como “buena” una señal con picos incoherentes.

Reglas típicas:

| Medición | Condición para `VALID` |
|----------|-------------------------|
| BPM | dedo, ≥2 RR fisiológicos, SQI ≥ `GATES.HR_VALID_MIN_SQI`, periodicidad mínima en bundle SQI |
| SpO2 | **perfil de calibración vigente** + SQI ≥ `GATES.SPO2_VALID_MIN_SQI` + movimiento/saturación/rojo dentro de umbral |
| PA | **calibración individual vigente** + morfología PWA + SQI ≥ `GATES.BP_VALID_MIN_SQI` |
| Respiración | ventana mínima, SQI, estabilidad de frames |
| Irregularidad | RR fiables, SQI ≥ `ARRHYTHMIA.MIN_SQI`, movimiento < `GATES.ARRHYTHMIA_MAX_MOTION` |

## UI de depuración

- **PPGSignalMeter**: onda 2 s, picos ▲ Elgendi, ■ Pan–Tompkins, ● fusión ensemble, picos de latido (audio/háptico).
- **DebugTelemetryPanel**: SQI, PI, FPS, jitter, acuerdo, torch, estado de adquisición.

## Supabase

Se conservan intentos y mediciones con metadatos de calidad; **no** se deben persistir lecturas inválidas como resultados clínicos finales sin `status`/`reason`.

## Tests y CI

```bash
npm run check:all
# lint + typecheck + check:orphans + check:no-sim + test + build + check:no-sim:dist
npm run check:architecture
```

Tests relevantes: `Detectors.test.ts`, `PPGSignalProcessor.test.ts`, `fingerRoiPulsation.test.ts`, `resolveAcquisitionStatus.test.ts`.

## Limitaciones explícitas

- Estimaciones **orientativas** sin calibración de usuario (especialmente SpO2 y PA).
- Variabilidad entre dispositivos (sensor RG-Bayer, torch, FPS).
- Procesamiento en main thread (sin Web Worker aún).
- No sustituye un pulsioxímetro ni un tensiómetro certificado.

## Referencias internas

- `docs/repository-cleanup.md` — depuración previa y mapa histórico
- `docs/no-simulation-audit.md` — política anti-simulación en runtime
