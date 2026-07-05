# Visión IA en vivo — Monitoreo casi frame-a-frame con modelos reales

> **Objetivo**: una IA de verdad "detrás de la puerta de la cámara", mirando
> **casi frame a frame**, que entiende qué sucede en el lente y por qué,
> reacciona hacia el resto del código (informar / preparar / decodificar) y es
> el **asistente y guía en vivo** del usuario — con voz — durante toda su
> experiencia con la app.
>
> **Restricción**: costo cero (capas gratuitas con API key propia + modelos
> locales gratuitos). Verificado contra la documentación y límites vigentes
> (julio 2026).

---

## El problema físico y su solución: la Pirámide de Vigilancia

Ninguna API gratuita del mundo acepta 30 solicitudes por segundo. Pero eso NO
significa mirar "cada tanto": significa **apilar tres IAs reales a tres
velocidades**, cada una cubriendo el hueco de la de arriba. El resultado neto:
**ningún frame queda sin ser visto por una red neuronal real, y ningún
segundo queda sin ser visto por un modelo de frontera.**

```
┌────────────────────────────────────────────────────────────────────┐
│ NIVEL A · "La Retina"    SigLIP/CLIP local (WebGPU)     20–30 fps  │
│   IA real (red neuronal zero-shot) viendo CADA frame, en el        │
│   dispositivo, gratis, offline. Entiende semántica: "dedo",        │
│   "manzana", "caracol", "cara", "lente tapado", "movimiento"…      │
├────────────────────────────────────────────────────────────────────┤
│ NIVEL B · "El Vigía"     Gemini Live API (WebSocket)     1 fps     │
│   Modelo de frontera EN SESIÓN CONTINUA: recibe el video en        │
│   streaming, VE la cámara en vivo, y HABLA (audio nativo) con el   │
│   usuario en tiempo real. Capa gratuita.                           │
├────────────────────────────────────────────────────────────────────┤
│ NIVEL C · "El Analista"  Gemini Flash REST / Groq Llama 4          │
│   Razonamiento profundo bajo demanda con truco de "filmstrip":     │
│   8 frames en mosaico por solicitud → 15 req/min cubren ~2 fps     │
│   de contenido real. Salida JSON estructurada hacia el código.     │
└────────────────────────────────────────────────────────────────────┘
        todos publican en → VisionBus → PPG pipeline · UI · Guía
```

### Números verificados (julio 2026)

| Capa | Tecnología | Cobertura | Costo |
|---|---|---|---|
| A | SigLIP/CLIP vía `@huggingface/transformers` + WebGPU | **20+ fps por frame, local** | $0, offline |
| B | Gemini Live API (`gemini-*-flash-live-preview`) | **video streaming continuo a 1 fps + voz bidireccional** | Free tier (sesiones audio+video de 2 min, renovables con session-resumption) |
| C | Gemini Flash/Flash-Lite REST | 15–30 req/min, 1.500 req/día, multimodal, JSON mode | Free tier (API key gratis, sin tarjeta) |
| C' | Groq — Llama 4 Scout (visión) | 30 req/min, 1.000 req/día, inferencia ultrarrápida | Free tier |

La clave que hace esto posible: **la Retina local a 20-30 fps ES una IA real**
(CLIP corre en el navegador con WebGPU a más de 20 fps, 100% local, verificado
por Hugging Face). El Vigía no necesita ver 30 fps: a 1 fps continuo un modelo
de frontera ve *todo lo que un humano narraría* de la escena, y la Retina cubre
los 29 frames intermedios con comprensión semántica genuina.

---

## FASE 1 — "La Retina" (IA local mirando cada frame)

**Entregable**: cada frame de la cámara pasa por una red neuronal real que lo
entiende semánticamente, a 20–30 fps, sin salir del dispositivo.

### Cómo

- `@huggingface/transformers` (**ya está en package.json, sin uso**) con
  SigLIP-base o CLIP ViT-B/16 cuantizado (~90–150 MB, descarga única,
  cacheado). `device: 'webgpu'`, `dtype: 'fp16'`; fallback WASM `q8` (~5–10
  fps, sigue siendo "casi constante").
- **Zero-shot con banco de prompts**: los embeddings de texto se calculan UNA
  vez ("una yema de dedo cubriendo el lente", "un dedo parcialmente apoyado",
  "una manzana", "un caracol", "una cara", "una habitación oscura", "lente
  sucio o borroso"…) y cada frame se compara por coseno en <1 ms. Agregar una
  categoría nueva = agregar una frase, sin reentrenar nada.
- Corre en `src/workers/vision.worker.ts` (Web Worker dedicado); el tap de
  frames se cuelga del loop existente (`useFrameLoop`) vía
  `createImageBitmap` transferido (zero-copy). **El pipeline PPG jamás
  espera**: si la Retina está ocupada, el frame se pisa con el siguiente.
- Además calcula por frame las señales físicas baratas (exposición,
  movimiento, nitidez, cobertura por cuadrantes) que alimentan el PPG.

### Componentes

| Archivo | Rol |
|---|---|
| `src/workers/vision.worker.ts` | Worker: SigLIP + features físicas por frame |
| `src/lib/vision/VisionBus.ts` | Pub/sub tipado; el sistema nervioso |
| `src/lib/vision/promptBank.ts` | Banco de categorías zero-shot (editable) |
| `src/lib/vision/types.ts` | `SceneState`, `FrameVerdict`, contratos |
| `src/hooks/useVisionTap.ts` | Tap al frame loop existente |

### Definition of Done

- ≥15 fps de veredictos semánticos en gama media con WebGPU (≥5 fps WASM).
- 0 impacto medible en el fps del pipeline PPG.
- HUD debug (`?visionDebug=1`): label + score en vivo por frame.
- Demo: manzana vs. caracol distinguidos en vivo, frame a frame, sin red.

---

## FASE 2 — "El Vigía" (modelo de frontera en sesión continua)

**Entregable**: Gemini conectado por WebSocket **mirando el video de la cámara
en streaming (1 fps) durante toda la sesión**, entendiendo la escena a nivel
humano y respondiendo por voz y texto en tiempo real.

### Cómo

- **Gemini Live API** (SDK `@google/genai`, WebSocket directo desde el
  dispositivo): se abre sesión al iniciar la app/medición y se le envía un
  frame JPEG 768×768 por segundo + (opcional) el audio del micrófono.
- **System prompt de dominio**: el Vigía sabe que es el asistente de un
  monitor cardíaco PPG: qué es un dedo bien apoyado, qué arruina la señal,
  y recibe inyectado el estado real del PPG (quality, acquisitionStage,
  perfusionIndex) + los veredictos de la Retina como contexto de texto
  (baratísimo en tokens).
- **Sesiones renovables**: la capa gratuita limita audio+video a ~2 min por
  sesión → `LiveSessionManager` con *context window compression* y *session
  resumption* del propio API: reconexión automática transparente, el Vigía
  no "olvida" la conversación.
- **BYOK (Bring Your Own Key)**: el usuario pega su API key gratuita de
  Google AI Studio en Ajustes (se guarda en Capacitor Preferences, nunca en
  el repo). Pantalla de onboarding explica cómo obtenerla gratis en 1 minuto.
- Salidas del Vigía → `VisionBus`: texto/voz para el usuario y *function
  calling* (el Live API lo soporta) para acciones sobre el código:
  `set_torch`, `adjust_roi`, `notify_user`, `flag_measurement`.

### Fallbacks (escalera de degradación)

1. Sin WebSocket/Live disponible → **Nivel C**: Gemini Flash REST con
   **filmstrip**: mosaico 3×3 de frames capturados a ~3 fps enviado cada
   3–4 s (una solicitud cubre 9 frames de contenido; 15 RPM alcanzan
   sobradas) + JSON mode → misma información, cadencia continua.
2. Sin key de Google → **Groq + Llama 4 Scout** (visión, 30 RPM gratis,
   inferencia más rápida del mercado) con el mismo adaptador.
3. Sin red / sin key → la app funciona con Retina sola (Fase 1) exactamente
   como hoy + semántica local.

```ts
interface VisionBrainProvider {
  start(ctx: SessionContext): Promise<void>;
  sendFrame(jpeg: Blob, meta: FrameMeta): void;      // streaming o batched
  onUnderstanding(cb: (u: SceneUnderstanding) => void): void;
  onAssistantSpeech(cb: (audio: AudioChunk | string) => void): void;
  stop(): Promise<void>;
}
// implementaciones: GeminiLiveProvider · GeminiRestFilmstripProvider
//                   GroqLlamaProvider · (off) RetinaOnlyProvider
```

### Definition of Done

- Sesión Live de 10 min ininterrumpidos (con renovaciones invisibles) viendo
  la cámara a 1 fps y narrando cambios de escena en <2 s de latencia.
- Presupuesto free respetado: contador local de RPM/RPD con backoff.
- Demo: usuario muestra un objeto cualquiera → el Vigía lo describe en voz
  alta y explica por qué no es un dedo.

---

## FASE 3 — "El Guía" (la experiencia de asistente en vivo)

**Entregable**: la fusión de Retina (frame a frame) + Vigía (frontera,
continuo) + estado real del PPG, convertida en guía humana oportuna y en
acciones automáticas — la experiencia visible.

### Cómo

- `VisionGuide` (máquina de estados): decide QUIÉN habla y CUÁNDO.
  - Reflejos (≤100 ms, de la Retina): "mové el dedo hacia abajo", "encendé
    la linterna" → overlay existente (`placementHint` en `PPGSignalMeter`)
    + háptica (`@capacitor/haptics`, ya instalada).
  - Conversación (del Vigía): voz nativa del Live API o Web Speech como
    fallback; el usuario puede PREGUNTARLE ("¿por qué no arranca?") y el
    Vigía responde viendo lo que pasa en el lente en ese momento.
- **Anti-spam**: histéresis 700 ms, cooldown 5 s por tipo, prioridad
  crítica > corrección > preparación > educativa, y **silencio sagrado**
  durante medición estable (READY + quality alta) salvo crítica.
- **Acciones automáticas** vía function calling + VisionBus:
  - *preparar*: la Retina ve el dedo acercándose → pre-encender torch y
    fijar exposición (`CameraView.optimizeForFinger`) antes del contacto.
  - *decodificar*: cobertura parcial detectada → ROI adaptativo en
    `PPGSignalProcessor` hacia el cuadrante con mejor perfusión.
  - *informar*: burbuja `VisionAssistant.tsx` + voz + telemetría del ciclo
    percepción→acción (`usePerfTelemetry`).

### Definition of Done

- Usuario nuevo, sin instrucciones, logra una medición válida guiado solo
  por el asistente (voz + overlay).
- Cero interrupciones en 60 s de medición estable.
- Toggles en Ajustes: asistente on/off, voz on/off, nivel B on/off
  (apagado todo = app idéntica a hoy).

---

## Presupuesto free — la cuenta completa

| Recurso | Límite free | Consumo de diseño | Margen |
|---|---|---|---|
| Gemini Live (sesión) | 2 min audio+video, renovable | renovación automática c/110 s | sesiones "infinitas" percibidas |
| Gemini REST | 15–30 RPM · 1.500 req/día | filmstrip: ~15–20 req/min solo como fallback | 1 usuario típico: 100–300 req/día |
| Groq Llama 4 Scout | 30 RPM · 1.000 req/día | solo fallback | amplio |
| SigLIP local | ∞ | 20–30 fps siempre | ∞ |
| Descargas de modelos | HF CDN gratis | ~90–150 MB una vez (aviso Wi-Fi) | cacheado |

## Orden de trabajo

| Fase | Riesgo | Dependencias | Valor al mergear |
|---|---|---|---|
| 1 · Retina | bajo | ninguna | IA real por frame + eventos útiles al PPG ya |
| 2 · Vigía | medio (WebSocket en WebView Android, gestión de sesión) | Fase 1 (contexto + gating) | el modelo de frontera en vivo |
| 3 · Guía | bajo | Fase 1; Fase 2 opcional (degrada) | la experiencia completa |

Cada fase entra por feature flag, mergeable sola, app idéntica con el flag
apagado.
