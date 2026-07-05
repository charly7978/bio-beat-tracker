# Visión IA en vivo — Diseño de implementación en 3 fases

> **Objetivo**: un "alguien detrás de la puerta de la cámara" que ve cada frame,
> entiende **qué** está pasando en el lente y **por qué**, reacciona en
> milisegundos hacia el resto del código (informar / preparar / decodificar),
> y actúa como **asistente y guía en vivo** del usuario.
>
> **Restricción dura**: costo cero. Todo corre **en el dispositivo** (navegador
> o WebView de Capacitor). Sin APIs pagas, sin servidor, sin enviar imágenes a
> ningún lado → además de gratis, es privado por diseño.

---

## Principio arquitectónico: dos velocidades, un solo bus

Ningún modelo único puede a la vez correr a 30 fps y "entender" como una IA
grande. La solución es la misma que usa la biología: **reflejos rápidos +
corteza lenta**.

```
Cámara (CameraView.tsx)
   │  frames reales (~30 fps)
   ├──────────────► PPG pipeline actual (useFrameLoop → processFrame)  ← INTOCABLE
   │
   └── tap ──► vision.worker.ts (Web Worker dedicado, zero-copy ImageBitmap)
                 │
                 ├─ FASE 1 · "El Portero"  — reflejos <5 ms/frame, 30 fps
                 │    heurísticas + clasificador liviano → SceneState
                 │
                 ├─ FASE 2 · "El Cerebro"  — VLM on-device, 1 inferencia
                 │    por keyframe (~0.3–1 Hz) → SceneUnderstanding
                 │
                 └─ VisionBus (eventos tipados) ────► cientos de sectores:
                        • PPG pipeline  (preparar, decodificar, ajustar ROI)
                        • UI / overlay  (informar)
                        • FASE 3 · "El Guía" (asistente en vivo del usuario)
```

Regla de oro: **el pipeline PPG nunca espera a la visión**. El tap de frames
usa `createImageBitmap` + `postMessage` con transferencia (zero-copy); si el
worker de visión está ocupado, el frame se descarta (política "última foto
gana"), jamás se encola.

---

## FASE 1 — "El Portero" (reflejos por frame)

**Qué hace**: para *cada* frame decide en <5 ms qué hay delante del lente y lo
publica como evento tipado. Es el que "sabe inmediatamente qué está
sucediendo" y dispara reacciones en el resto del código.

### Componentes nuevos

| Archivo | Rol |
|---|---|
| `src/workers/vision.worker.ts` | Worker dedicado; recibe ImageBitmap 160×160 |
| `src/lib/vision/VisionBus.ts` | Event emitter tipado (patrón pub/sub, sin deps) |
| `src/lib/vision/sceneReflex.ts` | Features baratas por frame (puro, testeable) |
| `src/lib/vision/types.ts` | `SceneState`, `SceneEvent`, contratos del bus |
| `src/hooks/useVisionTap.ts` | Engancha el tap al frame loop existente |

### Señales que calcula (por frame, sin modelo)

- **Dominancia roja / perfusión óptica**: ratio R/(G+B) + saturación → dedo
  cubriendo el lente vs. escena abierta (ya existe intuición de esto en
  `fingerPlacementProfile.ts`; acá se formaliza y se emite como evento).
- **Exposición**: histograma de 16 bins → `TOO_DARK`, `OVEREXPOSED`,
  `TORCH_SUGGESTED` (se conecta con los controles ya existentes de
  `CameraView.tsx`: torch, exposureCompensation, iso).
- **Movimiento inter-frame**: diff absoluto sobre grilla dispersa (misma
  técnica que `frameSignature()` en `useFrameLoop.ts`) → `MOTION_HIGH`,
  `STABLE`, y detección de **keyframe** (cambio real de escena) que es el
  disparador de la Fase 2.
- **Nitidez** (varianza del laplaciano 3×3) → `LENS_DIRTY_SUSPECT` /
  desenfoque.
- **Cobertura parcial**: cuadrantes del frame con dominancia roja desigual →
  `FINGER_PARTIAL` con dirección ("mové el dedo hacia abajo-izquierda") →
  alimenta directamente el `placementHint` que ya renderiza
  `PPGSignalMeter`.

### Clasificador liviano de objetos (la "manzana vs. caracol" rápida)

MediaPipe Tasks Vision — `ImageClassifier` con **EfficientNet-Lite0**
(~4.5 MB, licencia Apache-2, corre 20–30 fps en WASM/WebGL en gama media).
Reconoce ~1000 clases ImageNet: manzana, caracol, cara, mano, taza… Se usa
**solo cuando NO hay dedo** (cuando hay dedo el frame es rojo uniforme y no
hay nada que clasificar), típicamente 2–4 veces por segundo.

### Contrato de salida (lo que consume todo el código)

```ts
type SceneState =
  | { kind: 'FINGER_FULL'; redness: number; stability: number }
  | { kind: 'FINGER_PARTIAL'; coverage: number; offsetHint: 'up'|'down'|'left'|'right' }
  | { kind: 'NO_FINGER'; topLabels: { label: string; score: number }[] }
  | { kind: 'TOO_DARK' | 'OVEREXPOSED' | 'MOTION_HIGH' | 'LENS_DIRTY_SUSPECT' };

// VisionBus: cualquier módulo se suscribe sin acoplarse a la visión
visionBus.on('scene', (s: SceneState) => { ... });
visionBus.on('keyframe', (bitmap) => { ... });   // dispara Fase 2
```

### Criterio de salida de Fase 1 (Definition of Done)

- p95 < 5 ms/frame de cómputo en el worker (medido con `usePerfTelemetry`).
- 0 fps de impacto medible en el pipeline PPG.
- HUD de debug (flag `?visionDebug=1`) que muestra el SceneState en vivo.
- Tests unitarios de `sceneReflex.ts` con frames sintéticos (rojo pleno,
  mitad rojo, negro, blanco quemado, ruido).

---

## FASE 2 — "El Cerebro" (VLM on-device, semántica real)

**Qué hace**: la comprensión profunda — no solo "hay una manzana" sino "hay
una manzana roja sobre una mesa de madera, la imagen está borrosa porque la
cámara está enfocando de cerca". Un **modelo visión-lenguaje real** corriendo
en el dispositivo, gratis.

### La pieza ya está instalada

`@huggingface/transformers` (transformers.js v4) **ya figura en
`package.json`** y no se usa — es exactamente la librería para esto. Ejecuta
modelos ONNX con **WebGPU** (rápido) o **WASM** (fallback universal).

### Modelo elegido y alternativas

| Modelo | Peso (q4) | Qué da | Velocidad esperada |
|---|---|---|---|
| **SmolVLM-256M-Instruct** (elegido) | ~250 MB | VQA libre: "¿qué ves? ¿qué pasa?" responde en lenguaje natural | 1–3 s/inferencia WebGPU; 4–8 s WASM |
| Florence-2-base | ~230 MB | Caption + detección + OCR estructurados | similar |
| Moondream 0.5B | ~500 MB | VQA de más calidad | más lento |

Se descarga **una sola vez** desde el CDN de Hugging Face (gratis) y queda
cacheado en Cache Storage → segunda apertura: cero red. En Capacitor/Android
el WebView moderno soporta WASM SIMD siempre y WebGPU en Android 12+.

### Cuándo corre (presupuesto estricto)

- **Nunca por frame.** Corre por **keyframe** (Fase 1 detecta cambio real de
  escena) o a demanda del Guía (Fase 3) — típico: 1 inferencia cada 2–10 s.
- Cola de tamaño 1, "última foto gana": si llega un keyframe con una
  inferencia en curso, reemplaza al pendiente, no se apila.
- Prompt con contexto de Fase 1 y **salida JSON estructurada**:

```ts
type SceneUnderstanding = {
  what: string;          // "una manzana roja sobre fondo claro"
  happening: string;     // "el objeto está siendo acercado a la cámara"
  ppgRelevance: string;  // "no es un dedo; la medición no puede empezar"
  suggestion: string;    // "apoyá la yema del índice cubriendo todo el lente"
};
```

### Degradación elegante (crítico para "gratis en cualquier equipo")

`initVisionBrain()` hace feature-detection: WebGPU → q4 GPU; sin WebGPU pero
con RAM → WASM q4; equipo muy limitado o usuario sin datos → **Fase 2 apagada
y la app queda exactamente como hoy + Fase 1**. Flag persistente en
Preferences para que el usuario decida si descargar el modelo (aviso de
~250 MB la primera vez, solo con Wi-Fi por defecto).

### Criterio de salida de Fase 2

- Demo reproducible: mostrar manzana → `what` la describe; mostrar caracol →
  lo distingue; apoyar el dedo → `ppgRelevance` lo reconoce.
- Ninguna inferencia bloquea el hilo principal (todo en el worker).
- Cache verificado: segunda apertura sin red funciona.

---

## FASE 3 — "El Guía" (asistente en vivo del usuario)

**Qué hace**: convierte percepción (Fase 1) + comprensión (Fase 2) + estado
real de la medición (quality, acquisitionStage, perfusionIndex que ya emiten
`useSignalProcessor` y `resolveAcquisitionStatus`) en **guía humana en el
momento justo** — y en acciones automáticas sobre el código.

### Componentes

| Archivo | Rol |
|---|---|
| `src/lib/vision/VisionGuide.ts` | Máquina de estados + motor de reglas |
| `src/lib/vision/guideMessages.ts` | Catálogo de mensajes (ES), priorizados |
| `src/components/VisionAssistant.tsx` | Burbuja/overlay del asistente en la UI |
| Voz opcional | Web Speech API (`speechSynthesis`) — nativa, gratis, offline |

### Motor de reglas (anti-spam, esto es lo que separa "guía" de "molestia")

- **Prioridades**: crítica (no hay dedo y la medición corre) > corrección
  (dedo parcial, mover) > preparación (encendé la linterna) > educativa
  (dato curioso de Fase 2).
- **Histéresis**: un estado debe sostenerse ≥ 700 ms antes de generar mensaje;
  cooldown de 5 s por tipo de mensaje; máximo 1 mensaje visible.
- **Silencio sagrado**: durante medición estable (READY + quality alta) el
  Guía **no habla** salvo prioridad crítica.

### Acciones automáticas (la IA "reaccionando a cientos de sectores")

Vía `VisionBus`, sin acoplar módulos:

- **preparar**: `NO_FINGER→FINGER_PARTIAL` detectado → pre-encender torch y
  pre-fijar exposición (`CameraView.optimizeForFinger`) *antes* de que el
  usuario termine de apoyar el dedo → arranque de medición ~1 s más rápido.
- **decodificar**: `FINGER_PARTIAL` con offset → informar al pipeline PPG qué
  cuadrante del frame tiene mejor perfusión → ROI adaptativo en
  `PPGSignalProcessor`.
- **informar**: overlay del asistente + `placementHint` existente + voz
  opcional; y telemetría (`usePerfTelemetry`) del ciclo percepción→guía.

### Criterio de salida de Fase 3

- Sesión de prueba guiada completa: usuario nuevo, sin instrucciones, logra
  una medición válida solo siguiendo al asistente.
- Cero mensajes durante una medición estable de 60 s.
- Toggle de voz y de asistente en ajustes; apagado = app idéntica a hoy.

---

## Orden de trabajo y esfuerzo relativo

| Fase | Riesgo | Esfuerzo | Valor inmediato |
|---|---|---|---|
| 1 · Portero | bajo | ~3–5 sesiones | detección de escena + eventos ya útiles para el PPG |
| 2 · Cerebro | medio (peso del modelo, WebGPU en Android) | ~4–6 sesiones | comprensión real tipo "manzana vs caracol" |
| 3 · Guía | bajo (es orquestación) | ~3–4 sesiones | la experiencia visible para el usuario |

Cada fase se mergea sola, detrás de feature flag, con la app funcionando
idéntica si el flag está apagado. Fase 1 no depende de nada; Fase 2 depende
de 1; Fase 3 consume 1 y opcionalmente 2 (funciona degradada solo con 1).
