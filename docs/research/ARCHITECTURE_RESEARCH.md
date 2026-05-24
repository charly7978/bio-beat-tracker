# Arquitectura de Pipeline PPG vía Cámara Web

> **Proyecto creado por Carlos Ameghino** — investigación de arquitectura para el pipeline de captura y procesamiento de señales PPG desde cámara de smartphone, con foco en viabilidad técnica de cámara dual, selección de APIs de captura y diseño de procesamiento serial vs paralelo.

## 1. Estrategias de Captura de Frames

### Comparativa de APIs

| API | Safari iOS | Android Chrome | Precisión | GPU→CPU | Ideal para |
|-----|-----------|----------------|-----------|---------|------------|
| **RAF + drawImage + getImageData** | ✅ | ✅ | ~16ms (60fps) | Sí (lectura píxeles) | Baseline compatible |
| **requestVideoFrameCallback** | ✅ (15.4+) | ✅ (83+) | Sincronizado con fotogramas reales | Sí | Evitar frames perdidos |
| **MediaStreamTrackProcessor** | ❌ (No WebCodecs) | ✅ (94+) | Frame por frame | Sí | Procesamiento RAW |
| **OffscreenCanvas (Worker)** | ✅ (16.4+) | ✅ | Sin bloqueo de UI | Sí (transferToImageBitmap) | Pipeline en paralelo |
| **WebGL texImage2D → GPU** | ✅ | ✅ | GPU-side | No (se queda en GPU) | Procesamiento GPU puro |

### Conclusión: La mejor estrategia progresiva

1. **requestVideoFrameCallback** como callback primario (sincronizado con frames reales, evita procesar frames duplicados)
2. **OffscreenCanvas + Web Worker** para procesamiento fuera del main thread (cuando haya suficiente señal)
3. **Fallback a RAF** si RVFC no está disponible

```typescript
// Pipeline ideal:
requestVideoFrameCallback(metadata) {
  // metadata.mediaTime, metadata.presentedFrames, metadata.expectedDisplayTime
  // Solo procesar si hay un frame nuevo (evitar duplicados)
  if (metadata.presentedFrames === lastPresentedFrame) return;
  
  if (workerSoportado) {
    // Opción A: OffscreenCanvas en Worker (futuro)
    offscreenCtx.drawImage(video, 0, 0);
    const bitmap = offscreenCanvas.transferToImageBitmap();
    worker.postMessage({ bitmap }, [bitmap]);
  } else {
    // Opción B: Main thread (ahora)
    ctx.drawImage(video, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);
    processFrame(imageData);
  }
}
```

## 2. Dual Camera: Viabilidad en Web Móvil

### Hallazgo CRÍTICO: Dos getUserMedia simultáneos NO es confiable

- **iOS Safari**: Solo permite UNA cámara activa por página. Intentar abrir front + back falla con `NotAllowedError` o el segundo stream nunca llega.
- **Android Chrome**: Puede funcionar en algunos dispositivos, pero el segundo stream frecuentemente:
  - Se congela después de segundos
  - Tiene FPS muy reducido
  - Consume batería agresivamente
- **Causa raíz**: El hardware de cámara móvil típicamente tiene un solo bus MIPI. Dos streams simultáneos requieren:
  - Multiplexación de hardware (solo en dispositivos high-end: iPhone XS+, Samsung S20+)
  - A nivel nativo: `AVCaptureMultiCamSession` (iOS 13+, A12 chip+) — pero esto NO está expuesto a WebKit/Safari

### Alternativas para medición dual sin dos streams simultáneos

| Estrategia | Funciona en Web | Precisa GPS | Descripción |
|------------|----------------|-------------|-------------|
| **Conmutación rápida** (time-multiplex) | ✅ | No | Alternar entre front/back cada 1-2 segundos. Suficiente para rPPG+PPG si el algoritmo tolera gaps |
| **F3Mamba offline** | Solo inferencia post-hoc | Sí | Procesa videos guardados, no en tiempo real |
| **MobilePhys** (calibración → despliegue) | ✅ | Sí | Usa cámara trasera para calibrar un modelo que luego solo necesita la frontal |
| **Una cámara, dos posiciones** | ✅ | No | Usar SOLO la trasera, primero dedo (PPG), luego cara (rPPG) |
| **Una cámara trasera + dedo** | ✅ | No | **Nuestra estrategia actual**. Medición PPG confiable con flash |

### Recomendación para dual camera (a futuro)

NO intentar dos `getUserMedia` simultáneos. En su lugar:

1. **Fase 1** (ahora): Una cámara trasera + dedo. Pipeline simple, medición robusta.
2. **Fase 2** (calibración): Usar trasera (dedo) para generar pseudo-ground-truth PPG. Entrenar modelo que luego funcione solo con cámara frontal (rPPG).
3. **Fase 3** (despliegue rPPG): Solo cámara frontal, sin dedo. Modelo ya calibrado personalizado.

Este es exactamente el enfoque de **MobilePhys** (Liu et al. 2024).

## 3. Pipeline Serie vs Paralelo

### Opción A: Serie (100% main thread)
```
RAF → drawImage → getImageData → ROI → filtro → SQI → peaks → BPM → UI
[frame n] ... [frame n+1] ...
Todo secuencial. Frame rate limitado por procesamiento.
```

### Opción B: Serie con pipeline asíncrono
```
RAF → drawImage → transferToImageBitmap → postMessage a Worker
Worker: ROI → filtro → SQI → peaks → BPM → postMessage a UI
UI: actualiza métricas
```

### Opción C: Paralelo (múltiples Workers)
```
RAF → drawImage → ImageData
  ├─ Worker 1: ROI + filtro + SQI (calidad)
  ├─ Worker 2: detección de picos (Elgendi/MSPTD)
  └─ Main: BPM, SpO2, HRV
```

### Recomendación

**Comenzar con Opción B** (serie con Worker). Razonamiento:

1. **Serial es suficiente**: PPG es 1D (una señal por frame). No hay trabajo paralelizable. Solo 320×240×4 = ~300KB de datos por frame.
2. **El cuello de botella no es CPU**: Es `getImageData` (lectura GPU→CPU). Un Worker no evita esa copia.
3. **Worker ayuda a no bloquear UI**: La UI se actualiza independientemente del procesamiento.
4. **No necesitamos opción C**: Dos Workers para una señal 1D es overkill.

### Cuando considerar paralelo REAL

Solo si añadimos **rPPG facial** (procesamiento de video completo, detección de rostro, múltiples ROIs). En ese caso:
- Worker de detección facial (WASM/ONNX)
- Worker de extracción rPPG
- Main thread solo para UI

## 4. F³Mamba: Arquitectura de Fusión Dual-Cámara (2025)

Paper: "F³Mamba: Dual Camera Smartphone PPG Dataset and Fusion Framework"

### Aportación clave
- Primer dataset dual-cámara: front (cara, rPPG) + back (dedo, PPG) **sincronizados**
- Arquitectura de fusión: Mamba blocks (State Space Models) para dependencias temporales largas
- Resolución: 128×128 px, 30 FPS, secuencias de 160 frames (5.33s)

### Arquitectura
```
video_front (rPPG) → backbone → features_front
video_back (PPG)   → backbone → features_back
                                      ↓
                          Cross-Attention Fusion
                                      ↓
                          Mamba Blocks (SSM)
                                      ↓
                          Head (HR, RR, SpO2, BP)
```

### Lecciones para nosotros
- La fusión temprana (feature-level) es mejor que fusión tardía (decision-level)
- Mamba blocks son más eficientes que Transformers para secuencias fisiológicas
- La sincronización temporal exacta entre cámaras es crítica (frame timestamps)
- **No aplica a tiempo real web** sin hardware expuesto, pero el diseño de fusión es valioso para futuro offline/native

## 5. MobilePhys: Auto-Calibración con Cámara Dual (2024)

Paper: "MobilePhys: Personalized Mobile Camera-Based Contactless Physiological Sensing"

### Estrategia brillante
1. **Calibración** (30s): Usuario pone dedo en cámara trasera → genera PPG de alta calidad (pseudo-ground-truth)
2. **Personalización**: Meta-learning (MAML) para adaptar modelo rPPG facial a ese usuario
3. **Despliegue**: Solo cámara frontal, sin dedo, medición contactless

### Pipeline
```
Fase 1 (calibración):
  Back cam (dedo) → PPG signal → pseudo labels BVP
  Front cam (cara) → video facial
  Modelo se entrena para predecir PPG facial que coincida con PPG de dedo

Fase 2 (inferencia):
  Front cam (cara) → modelo personalizado → BVP → HR/RR/SpO2
```

### Lecciones para nosotros
- **Podemos implementar Fase 1 ahora**: Nuestra cámara trasera + dedo ya genera PPG. Podríamos guardar eso como pseudo-label.
- **La personalización mejora accuracy**: Modelo genérico rPPG no funciona para todos. La calibración personalizada es clave.
- **Meta-learning con pocos ejemplos**: MAML permite adaptación con solo 1-2 minutos de calibración.

## 6. Recomendaciones Concretas de Arquitectura

### Ahora (Fase 1 — Simplificada y Robusta)

```
┌─────────────────────────────────────────────────────┐
│  CameraView (getUserMedia + torch)                   │
│    requestVideoFrameCallback (o RAF fallback)        │
│      drawImage(video → canvas) → getImageData        │
└────────────────────┬────────────────────────────────┘
                     │ ImageData (RGBA)
                     ▼
┌─────────────────────────────────────────────────────┐
│  ROI Extraction (centro 40% + canal verde)            │
│  Bandpass 0.5-5 Hz (IIR Butterworth)                 │
│  SQI (perfusión + SNR + clipping + movimiento)       │
└────────────────────┬────────────────────────────────┘
                     │ señal PPG + SQI
                     ▼
┌─────────────────────────────────────────────────────┐
│  Peak Detection (MSPTDfast >> Elgendi)               │
│  HRV / BPM / SpO2 / Respiración                     │
└────────────────────┬────────────────────────────────┘
                     │ VitalMeasurement
                     ▼
┌─────────────────────────────────────────────────────┐
│  UI (PPGSignalMeter + DebugTelemetryPanel)           │
│  Supabase (solo mediciones válidas)                  │
└─────────────────────────────────────────────────────┘
```

**Cambios clave respecto a ahora:**
1. Canal **verde** en vez de solo rojo (mejor SNR PPG: relación AC/DC ~2-3× mayor en verde)
2. **MSPTDfast** reemplaza Elgendi (F1 95%+ vs ~85%)
3. **requestVideoFrameCallback** como primario (cuando disponible)
4. Mantener todo en **main thread** hasta verificar pipeline básico funciona

### Fase 2 — Worker + Mejoras

```
Main Thread:           Worker (futuro):
  RAF/RVFC              processFrame:
  drawImage →             ROI extraction
    transferToImageBitmap → Bandpass filter
    postMessage(bitmap)    SQI
    ↓                     MSPTDfast peak detection
  UI updates:             BPM/HRV calculation
    PPG waveform          ← postMessage(results)
    BPM display
```

### Fase 3 — Calibración Personalizada

```
Modo Calibración (30s):
  Back cam + dedo → PPG → pseudo ground truth BVP
  Guardar en IndexedDB o Supabase

Modo Inferencia (después):
  Solo front cam (rPPG) o back cam (PPG clásico)
  Si es rPPG: modelo personalizado basado en calibración previa
  Si es PPG: pipeline estándar (sin cambios)
```

### Fase 4 — Fusión Dual Cámara (nativa, no web)

Si se migra a iOS/Android nativo:
- Usar `AVCaptureMultiCamSession` (iOS) o `Camera2` (Android) para dos streams sincronizados
- Arquitectura tipo F³Mamba: cross-attention + Mamba blocks
- Frame timestamps sincronizados para fusión temporal exacta
- Ideal: inferencia ONNX con modelo entrenado

## 7. Tabla Resumen de APIs y Soporte

| API | Safari iOS | Chrome Android | Notas |
|-----|-----------|----------------|-------|
| `getUserMedia` | ✅ (11+) | ✅ | Sin falla de permisos en Safari 16+ |
| `enumerateDevices` | ✅ | ✅ | Labels requieren permiso previo |
| `requestVideoFrameCallback` | ✅ (15.4+) | ✅ (83+) | **Recomendado** para frame-synced |
| `OffscreenCanvas` | ✅ (16.4+) | ✅ (69+) | Worker: solo 2D, no WebGL |
| `transferToImageBitmap` | ✅ (16.4+) | ✅ (69+) | Transferencia Worker→Main sin copia |
| `WebCodecs` | ❌ | ✅ (94+) | Safari: "no signal" — no hay soporte |
| `MediaStreamTrackProcessor` | ❌ | ✅ (94+) | Depende de WebCodecs |
| `ImageCapture` | ❌ | ✅ (59+) | Solo Chrome |
| `WebGPU` | ✅ (18+) | ✅ (113+) | Demasiado para PPG (gastas GPU) |
| Dual stream getUserMedia | ❌ | Parcial | No confiable en ningún browser mobile |
| `Navigator.wakeLock` | ✅ (16.4+) | ✅ | Ya lo tenemos |
| `ScreenOrientation.lock` | ✅ (16.4+) | ✅ | Ya lo tenemos |

## 8. Referencias

- F³Mamba (2025): https://github.com/Health-HCI-Group/F3Mamba
- MobilePhys (2024): https://ubicomplab.cs.washington.edu/pdfs/mobilephys.pdf
- rPPG-Toolbox (NeurIPS 2023): https://github.com/ubicomplab/rPPG-Toolbox
- requestVideoFrameCallback: https://web.dev/articles/requestvideoframecallback-rvfc
- WebCodecs explainer: https://github.com/w3c/webcodecs/blob/master/explainer.md
- OffscreenCanvas Worker: https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- AVCaptureMultiCamSession (iOS): https://developer.apple.com/documentation/avfoundation/avcapturemulticamsession
- Smartphone cbPPG comparison (2022): https://pubmed.ncbi.nlm.nih.gov/34892735/
- Camera-based PPG general anesthesia (2024): https://pmc.ncbi.nlm.nih.gov/articles/PMC12588653/
