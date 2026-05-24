# Signal Divider — Arquitectura de Procesamiento por Señal Exclusiva

> **Idea original: Carlos Ameghino** — concibió, diseñó y validó este concepto durante 2025-2026, partiendo de cero en programación, mientras enfrentaba pérdidas personales y laborales. Su convicción de que era posible construir un monitor de signos vitales con un smartphone lo llevó a investigar, prototipar y refinar esta arquitectura contra todo escepticismo. Este documento es la formalización de su visión.

## La Idea

> "¿Y si desde la cámara hacemos un divisor de señal? Para que cada procesador reciba solo y tan solo lo que necesita. Señal clasificada y exclusiva para cada signo vital."

**Inspiración multidisciplinaria:**
- **SDR (Software Defined Radio)**: Una antena recibe todo el espectro. Un divisor IQ + banco de filtros demodula cada canal por separado (FM, AM, digital, etc.)
- **Consola de audio**: Cada canal (voz, guitarra, batería) tiene su propia cadena de procesamiento (EQ, compresor, reverberación)
- **Multi-task learning**: Shared backbone extrae features comunes; task-specific heads procesan exclusivamente para cada tarea
- **ROS (Robot Operating System)**: Un tópico publicado puede ser remapeado y transformado para cada suscriptor

## Arquitectura Conceptual

```
             ┌──────────────────────────────────────┐
             │           CÁMARA (RAW)                │
             │   ROI → Canal Verde → Señal PPG Bruta │
             └────────────────┬─────────────────────┘
                              │ Señal PPG cruda (0-20 Hz)
                              ▼
             ┌──────────────────────────────────────┐
             │        PREPROCESADOR COMÚN            │
             │  (Filtro pasa altas 0.3 Hz para DC)   │
             │  (Detección de movimiento frame)       │
             │  (SQI base: perfusión, clipping, SNR) │
             └────────────────┬─────────────────────┘
                              │ Señal pre-limpiada
                              ▼
        ╔═══════════════════════════════════════════╗
        ║         DIVISOR DE SEÑAL (SPLITTER)       ║
        ║  Cada rama recibe preprocessing exclusivo ║
        ╚═══════════════════════════════════════════╝
            │         │         │         │
            ▼         ▼         ▼         ▼
    ┌──────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
    │ CANAL HR │ │CANAL   │ │CANAL   │ │CANAL     │
    │          │ │SpO2    │ │HRV     │ │RESPIRACIÓN│
    └──────────┘ └────────┘ └────────┘ └──────────┘
```

## División por Canales

### Canal HR (Frecuencia Cardíaca)

| Etapa | Procesamiento | Por qué |
|-------|---------------|---------|
| **Filtro** | Bandpass 0.8-3.0 Hz (48-180 BPM), Butterworth orden 4, zero-phase | Rango cardíaco típico, elimina respiración y ruido HF |
| **Énfasis** | Pre-énfasis de picos (diferenciación + rectificación suave) | Resalta el componente sistólico para detección de picos |
| **Peak detection** | MSPTDfast (optimizado para HR) | SOTA en precisión de picos |
| **SQI específico** | Periodicidad espectral, consistencia RR | Solo importa que los picos sean regulares |
| **Salida** | BPM, RR intervals, confidence, timestamps | Solo lo que necesita HR |

### Canal SpO2 (Saturación de Oxígeno)

| Etapa | Procesamiento | Por qué |
|-------|---------------|---------|
| **Filtro** | Bandpass 0.5-5.0 Hz con preservación de DC | SpO2 necesita relación AC/DC, no puede eliminar DC |
| **Separación** | Split en AC (0.5-5 Hz) y DC (0-0.5 Hz) por separado | Ratio-of-ratios requiere ambas componentes |
| **Canales múltiples** | Rojo (R) e Infrarrojo (IR) o canales RGB equivalentes | SpO2 = f(R_AC/R_DC, IR_AC/IR_DC) |
| **Normalización** | División AC/DC por canal | Obtener relación de perfusión independiente de iluminación |
| **SQI específico** | Estabilidad de ratio, sin clipping en ningún canal | Un canal clip arruina el ratio |
| **Salida** | SpO2 %, PI (Perfusion Index), confidence | Solo lo que necesita SpO2 |

### Canal HRV (Variabilidad Cardíaca)

| Etapa | Procesamiento | Por qué |
|-------|---------------|---------|
| **Filtro** | Bandpass 0.5-3.0 Hz, **cero-fase estricto (filtfilt)** | HRV requiere precisión temporal de ms, no puede tener distorsión de fase |
| **Peak detection** | MSPTDfast con **sub-sample precision** (interpolación parabólica) | La diferencia de 1 muestra a 30Hz = 33ms que arruina HRV |
| **Detección de artefactos** | IBI outlier rejection (MAD, ventana deslizante) | Latidos ectópicos o ruido destruyen métricas HRV |
| **SQI específico** | pNN50, RMSSD sobre ventana, porcentaje de latidos válidos | Solo importa calidad de intervalos NN |
| **Salida** | SDNN, RMSSD, pNN50, LF/HF ratio, confidence | Solo lo que necesita HRV |

### Canal Respiración (Frecuencia Respiratoria)

| Etapa | Procesamiento | Por qué |
|-------|---------------|---------|
| **Filtro** | Bandpass 0.1-0.5 Hz (6-30 resp/min), Butterworth orden 2 | Rango respiratorio típico |
| **Extracción** | Modulación de amplitud de la onda PPG (envelope + demodulación) | La respiración modula la línea base y amplitud del PPG |
| **Método alternativo** | Modulación de frecuencia (desplazamiento de picos) o derivada | La respiración desplaza la línea base y el espaciado entre picos |
| **SQI específico** | Relación pico-espectral en banda respiratoria | La respiración debe tener energía dominante en 0.1-0.5 Hz |
| **Salida** | RR (resp/min), depth, confidence | Solo lo que necesita respiración |

### Canal Presión Arterial (BP) — Experimental

| Etapa | Procesamiento | Por qué |
|-------|---------------|---------|
| **Filtro** | Bandpass 0.5-8.0 Hz, preservación de morfología | BP usa características morfológicas (PEP, PTF, área) |
| **Morfología** | Preservación de inflexiones (derivadas 1ra y 2da) sin suavizado excesivo | Las inflexiones sistólica/dicrótica contienen info de BP |
| **Normalización** | Amplitud normalizada por perfusión media | Compensa variaciones de presión del dedo |
| **Calibración** | Modelo de regresión calibrado vs esfigmomanómetro referenciado | BP requiere calibración individual |
| **SQI específico** | Calidad de fiduciales, estabilidad morfológica, calibración vigente | BP es la más sensible a calidad de señal |
| **Salida** | SBP, DBP, MAP, confidence, calibración status | Solo lo que necesita BP |

## Implementación en Código

### Interfaz del Divisor

```typescript
// Cada canal define su propio pipeline de procesamiento
interface SignalChannel<T> {
  name: string
  // Filtros específicos del canal (encadenados)
  filters: FilterStage[]
  // Detector/configuración específica
  processor: SignalProcessor<T>
  // Métrica de calidad específica
  qualityMetric: (signal: number[], metadata: FrameMetadata) => number
}

// El divisor recibe la señal cruda y produce señales exclusivas
class SignalDivider {
  private channels: Map<string, SignalChannel<any>>
  
  addChannel<T>(name: string, channel: SignalChannel<T>): void
  
  // Entrada: señal PPG pre-limpiada + metadata del frame
  // Salida: { [channelName]: { signal, quality, result } }
  divide(
    rawPpg: Float64Array,
    metadata: FrameMetadata
  ): Record<string, ChannelOutput>
}

// Uso
const divider = new SignalDivider()

divider.addChannel('hr', {
  name: 'Heart Rate',
  filters: [
    { type: 'bandpass', low: 0.8, high: 3.0, order: 4 },
    { type: 'preemphasis', alpha: 0.95 }
  ],
  processor: new MSPTDFastDetector({ minBpm: 40, maxBpm: 200 }),
  qualityMetric: spectralPeriodicity
})

divider.addChannel('spo2', {
  name: 'SpO2',
  filters: [
    { type: 'lowpass', cutoff: 5.0 },  // AC path
    { type: 'highpass', cutoff: 0.5 }  // DC path
  ],
  processor: new SpO2Processor({ channels: ['red', 'nir'] }),
  qualityMetric: ratioStability
})

divider.addChannel('hrv', {
  name: 'HRV',
  filters: [
    { type: 'bandpass', low: 0.5, high: 3.0, order: 4, zeroPhase: true }
  ],
  processor: new HRVProcessor({ artifactRejection: 'mad' }),
  qualityMetric: beatConsistency
})

divider.addChannel('respiration', {
  name: 'Respiration',
  filters: [
    { type: 'bandpass', low: 0.1, high: 0.5, order: 2 }
  ],
  processor: new RespirationProcessor({ method: 'amplitudeModulation' }),
  qualityMetric: spectralDominance
})

divider.addChannel('bp', {
  name: 'Blood Pressure',
  filters: [
    { type: 'bandpass', low: 0.5, high: 8.0, order: 4 },
    { type: 'morphologyPreserve' }
  ],
  processor: new BloodPressureProcessor({ calibrationId: 'user_123' }),
  qualityMetric: fiducialQuality
})
```

### Flujo de Datos

```
Frame n (cámara):
  video → drawImage → getImageData → ROI → rawPPG (Float64Array)
                                         ↓
                                  preprocessComun(rawPPG)
                                    │ DC removal
                                    │ motion detection
                                    │ base SQI
                                    ▼
                              preprocessedSignal
                                    ↓
                            SignalDivider.divide()
                              ├──→ channel 'hr':  [filters hr] → MSPTD → {bpm, rr}
                              ├──→ channel 'spo2': [filters spo2] → ratio → {spo2, pi}
                              ├──→ channel 'hrv':  [filters hrv] → peaks → {sdnn, rmssd}
                              ├──→ channel 'resp': [filters resp] → envelope → {rr, depth}
                              └──→ channel 'bp':   [filters bp] → morphology → {sbp, dbp}
                                    ↓
                              signalQualityManager()
                                    ↓
                              frameResults → buffer circular (8s)
                                              ↓
                                        VitalSignsProcessor
                                        (ventana deslizante, median filtering)
                                              ↓
                                        UI update
```

## Ventajas de este Diseño

1. **Aislamiento total**: Un canal ruidoso no afecta a los demás
2. **Precisión máxima**: Cada signo vital recibe preprocessing optimizado para su fenotipo de señal
3. **SQI granular**: Cada canal reporta su propia confianza
4. **Extensible**: Nuevos procesadores se agregan como canales sin modificar el pipeline existente
5. **Testeable**: Cada canal se prueba independientemente
6. **Perfomance**: Filtros más angostos = menos CPU. SpO2 solo procesa 0.5-5 Hz, no el rango completo
7. **Backpressure**: Si un canal está saturado, solo ese canal se degrada

## Analogías con Otros Dominios

| Dominio | Concepto | Equivalente en nuestro sistema |
|---------|----------|-------------------------------|
| **SDR** | IQ Demodulator + Filter Bank | SignalDivider con múltiples canales de filtros |
| **Audio** | Mixing Console (Aux Bus) | Cada canal vital tiene su cadena de efectos |
| **MTL** | Shared Backbone + Task Heads | Preprocesador común + procesadores específicos |
| **ROS** | Topic Remapping + Nodelets | Cada suscriptor recibe el tópico transformado para su necesidad |
| **Video** | GPU MRT (Multiple Render Targets) | Un shader escribe a múltiples targets simultáneamente |
| **Sistemas operativos** | Interrupts por dispositivo | Cada canal es un "dispositivo virtual" con su driver |

## Extensión: Preprocesamiento Visual por Canal (Frame-Level)

El divisor no opera solo sobre la señal 1D promediada — opera **sobre el frame RAW** antes de promediar tiles. Cada canal aplica transformaciones de imagen sintéticas sobre el mismo frame, adaptando la exposición, color y textura a su signo vital.

### Arquitectura

```
              ┌──────────────────────────────────────┐
              │           CÁMARA (RAW FRAME)          │
              │         ImageData (RGBA, 8-bit)       │
              └──────────┬───────────────────────────┘
                         │
                         ▼
              ┌──────────────────────────────────────┐
              │        DIVISOR VISUAL (per channel)   │
              │  DUP → channel 'hr':  transform HR   │
              │  DUP → channel 'spo2': transform SpO2 │
              │  DUP → channel 'bp':   transform BP   │
              └──────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
    ┌─────────────────┐   ┌─────────────────┐
    │ Frame transform  │   │ Frame transform  │
    │ HR               │   │ SpO2             │
    │ (green boost,    │   │ (red/IR balance, │
    │  gamma 0.8)      │   │  gamma 1.2)      │
    └────────┬─────────┘   └────────┬─────────┘
             │                      │
             ▼                      ▼
    ┌─────────────────┐   ┌─────────────────┐
    │ ROI + Tiles (HR) │   │ ROI + Tiles (SpO2)│
    │ pixelStride N    │   │ pixelStride M    │
    └────────┬─────────┘   └────────┬─────────┘
             │                      │
             ▼                      ▼
    ┌─────────────────┐   ┌─────────────────┐
    │ Filtros señal HR │   │ Filtros señal   │
    │ (0.8-3.0 Hz)     │   │ SpO2 (AC/DC)    │
    └─────────────────┘   └─────────────────┘
```

### Tabla de Transformaciones Visuales por Canal

| Parámetro Visual | HR | SpO₂ | HRV | Respiración | PA (BP) |
|---|---|---|---|---|---|
| **Canal dominante** | Verde (G) | Rojo (R) + Verde (G) | Verde (G) | Verde (G) | Rojo (R) |
| **Boost de canal** | G×1.5, R×0.7, B×0.5 | R×1.3, G×1.0, B×0.6 | G×1.3, R×0.8, B×0.6 | G×1.2, R×0.9, B×0.8 | R×1.4, G×0.8, B×0.5 |
| **Gamma** | 0.8 (aclara sombras) | 1.2 (estira rango) | 1.0 (lineal) | 0.9 (suave) | 0.7 (realza detalle) |
| **Brillo offset** | +5 | -3 | 0 | +2 | +8 |
| **Contraste** | 1.2× | 1.0× | 1.1× | 0.9× | 1.4× |
| **Sharpening** | No | No | No | No | Sí (kernel 3×3, preserva inflexiones dicróticas) |
| **Balance blancos** | Daylight (5500K) | Tungsten (3200K) | Daylight | Daylight | Daylight |
| **Eliminar DC visual** | Sí (restar media por tile) | No (preservar DC para ratio) | Sí | Sí | Parcial |
| **Clamp dinámico** | 10-250 | 20-240 | 5-250 | 20-250 | 15-250 |
| **Normalización** | Por tile (mean centering) | Global (min-max por frame) | Por tile (z-score) | Global (mean centering) | Por tile (z-score parcial) |

### Costo Computacional

Las transformaciones se aplican **directamente sobre el ImageData** antes de promediar tiles, sin alocar frames intermedios:

```typescript
// Misma operación que el LUT de tiles — operaciones O(N) sobre el ROI
function applyChannelTransform(
  data: Uint8ClampedArray,  // ImageData.data in-place
  transform: VisualTransform,
  roi: RoiRect
): void {
  const { startX, startY, endX, endY, width } = roi
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const i = (y * width + x) * 4
      data[i]     = clamp(transform.rScale * data[i]     + transform.brightness, 0, 255)
      data[i + 1] = clamp(transform.gScale * data[i + 1] + transform.brightness, 0, 255)
      data[i + 2] = clamp(transform.bScale * data[i + 2] + transform.brightness, 0, 255)
    }
  }
}
```

Cada transformación es una multiplicación de canal + suma de brillo + clamp. Para un ROI de ~100×100 píxeles: ~10K pix × 3 ops = **30K operaciones por canal**. A 30 fps con 4 canales: ~3.6M ops/s — trivial para JavaScript moderno (<< 1ms).

### Sharpening para Presión Arterial

La PA requiere preservar la morfología de la onda, incluyendo la **incisura dicrótica** (punto de cierre de la válvula aórtica). Un kernel de sharpening 3×3 sobre el canal rojo mejora la detección de este fiducial:

```typescript
// Kernel Laplaciano: [0 -1 0; -1 5 -1; 0 -1 0] sobre canal R
// Aplica solo en modo BP (canal más demandante)
```

### Por qué esto funciona

1. **El frame RAW contiene toda la información óptica** — brillo, color, textura, contraste. Cada signo vital usa un subconjunto diferente de esta información.

2. **No hay costo de captura extra** — un solo ImageData, N transformaciones en paralelo (o secuencial rápido).

3. **Es pura aritmética de enteros** — Uint8ClampedArray, sin float, sin alocaciones, sin WebGL.

4. **Se complementa con los filtros de señal 1D** — lo visual enfatiza el contenido espectral correcto ANTES de promediar, los filtros 1D limpian DESPUÉS. Doble filtrado ortogonal.

5. **Sustituye la necesidad de AGC/exposición adaptativa** — en vez de pelear con la cámara para que exponga perfecto para todos los signos, cada canal "se expone" sintéticamente sobre el mismo RAW.

### Implementación en Código (extensión de SignalChannel)

```typescript
interface VisualTransform {
  rScale: number     // Multiplicador canal rojo
  gScale: number     // Multiplicador canal verde
  bScale: number     // Multiplicador canal azul
  brightness: number // Offset de brillo (±255)
  gamma: number      // Corrección gamma (1.0 = lineal)
  contrast: number   // Factor de contraste
  clampMin: number   // Piso dinámico
  clampMax: number   // Techo dinámico
  sharpen?: number   // Intensidad de sharpening (0=desactivado)
}

interface SignalChannel<T> {
  name: string
  visual?: VisualTransform       // ← NUEVO: transformación visual antes de ROI
  pixelStride?: number           // ← NUEVO: stride específico del canal
  filters: FilterStage[]
  processor: SignalProcessor<T>
  qualityMetric: (signal: number[], metadata: FrameMetadata) => number
}
```

### Ejemplo: Canales HR y PA

```typescript
const hrChannel: SignalChannel<HRResult> = {
  name: 'Heart Rate',
  visual: {
    rScale: 0.7, gScale: 1.5, bScale: 0.5,  // Green dominance
    brightness: 5,
    gamma: 0.8,
    contrast: 1.2,
    clampMin: 10, clampMax: 250,
  },
  pixelStride: 3,
  filters: [
    { type: 'bandpass', low: 0.8, high: 3.0, order: 4 },
  ],
  processor: new MSPTDFastDetector({ minBpm: 40, maxBpm: 200 }),
  qualityMetric: spectralPeriodicity,
}

const bpChannel: SignalChannel<BPResult> = {
  name: 'Blood Pressure',
  visual: {
    rScale: 1.4, gScale: 0.8, bScale: 0.5,  // Red dominance (penetra más)
    brightness: 8,
    gamma: 0.7,                              // Realza detalle en sombras
    contrast: 1.4,                            // Máximo contraste de bordes
    clampMin: 15, clampMax: 250,
    sharpen: 0.3,                             // Sharpening leve para incisura
  },
  pixelStride: 2,                             // Más resolución espacial
  filters: [
    { type: 'bandpass', low: 0.5, high: 8.0, order: 4 },
  ],
  processor: new BloodPressureProcessor({ calibrationId: 'user_123' }),
  qualityMetric: fiducialQuality,
}
```

## Validación por Investigación (2024-2025)

### El Signal Divider es cutting-edge — la literatura lo confirma

| Hallazgo | Fuente | Implicancia |
|----------|--------|-------------|
| **Filtros fijos son sub-óptimos**: cutoff óptimo varía por persona Y por tarea (HR vs HRV). Ajuste por persona/tarea mejora precisión 7.15% y reduce errores IBI/PRV 35-145ms | UbiComp 2025, Mishra et al. | Cada canal del Signal Divider necesita su propio preprocessing adaptativo |
| **Multi-task learning con backbone compartido + cabezales específicos** es exactamente la arquitectura del Signal Divider | Nature Scientific Reports 2025 | La arquitectura propuesta está validada por SOTA |
| **SpO₂ desde cámara RGB requiere deep learning**: La relación AC/DC entre rojo y verde de cámara smartphone no discrimina SpO₂ sin ML entrenado en rango clínico completo (70-100%). MAE=5% con deep learning | npj Digital Medicine 2022, UW/UCSD | SpO₂ = 101 - 10×R produce ~98% constante porque R ≈ 0.3 siempre con flash blanco |
| **Single-PPG → BP tiene límite fundamental**: Factor multi-valuado 33.2%, información mutua solo 9.8%. Ningún modelo actual cumple AAMI/ISO sin datos demográficos | PMC 2024, arXiv 2025 | BP requiere calibración individual o PTT (dos sensores) |
| **Pipeline E2E modular**: SQA → reconstrucción → peak detection → HR/HRV. Separación clara de concerns | E2E-PPG, IEEE 2024 | Validación del approach de preprocessing separado por etapa |
| **Calibración-free BP**: Morfología PPG + dinámica cardiovascular puede reemplazar calibración en algunos casos, pero con errores de 7-10 mmHg | MDPI Sensors 2023 | BP sin calibración es posible pero impreciso |

### Diagnóstico del Estado Actual

#### SpO₂ atascado en 98

La ecuación actual `SpO2 = INTERCEPT - SLOPE × medianR` con `INTERCEPT=101, SLOPE=10` produce:

| Escenario | R = (ACr/DCr) / (ACg/DCg) | SpO₂ | Realidad |
|-----------|--------------------------|------|----------|
| Flash blanco, dedo normal | ~0.3 | **98** | Valor real ~97-99 |
| Más presión en dedo | ~0.4-0.5 | 96-97 | Valor real ~97-99 |
| Menos luz ambiental | ~0.2 | **99** | Sin cambio real |

**Problema fundamental**: La cámara RGB de smartphone NO tiene un canal infrarrojo como un oxímetro médico (LEDs 660nm + 940nm). El flash blanco ilumina todo el espectro visible, y los canales rojo/verde/azul del sensor captan mezclas del mismo pulso. La relación `R` es casi constante independientemente del SpO₂ real.

**Solución**: Deep learning (como UW 2022) o calibración contra oxímetro de referencia. Sin ML, lo máximo que se puede hacer es:
- Usar múltiples relaciones de canal: R/G, R/B, R/(G+B)
- Detectar cuándo la señal es "plana" (sin variación real) y bajar la confianza
- Soportar calibración manual con un oxímetro de referencia

#### Presión Arterial no aparece

9 gates de seguridad bloquean la salida. El más restrictivo:

| Gate | Condición | Estado típico |
|------|-----------|---------------|
| Buffer de morfología | ≥120 muestras | Se llena después de ~4s a 30fps |
| Detección de ciclos | ≥3 ciclos cardíacos | Falla si la morfología es ruidosa |
| Calidad de ciclo | quality > 0.24-0.28 | Smartphone PPG rara vez pasa |
| Calidad de feature | score ≥ 48 | Difícil sin señal limpia |
| FrameCount estable | ≥20-30 frames estables | Se alcanza pero con confianza baja |

**Solución a corto plazo**: Relajar thresholds para desarrollo. **A largo plazo**: Requiere calibración + señal más limpia.

## Referencias Implementadas

- **NeuroKit2** (Python): `ppg_process()` — clean + peaks + rate + quality en un pipeline. Inspiración modular.
- **e2epyppg** (Python): Pipeline E2E con SQA + reconstruction + peak detection.
- **rPPG-Toolbox**: Config-driven, cada método tiene su propio preprocesamiento.
- **SDR (GNURadio)**: Flowgraph con splitter → múltiples filtros → demoduladores.
- **FFmpeg filtergraph**: Split + filtros independientes por stream.
- **UW Smartphone Oximetry 2022**: Deep learning para SpO₂ desde cámara RGB. Dataset open-source.
- **UbiComp 2025**: Preprocessing adaptativo por persona/tarea para PPG.
- **Nature Scientific Reports 2025**: Complex-valued MTL para rPPG + respiración.
