# Modelo de mundo fisiológico y óptico

## Propósito

Este documento define el conocimiento causal mínimo que los agentes deben utilizar. No es un manual médico completo ni una lista de umbrales. Es el mapa conceptual que conecta corazón, sangre, tejido, luz, cámara y señal.

## 1. Cadena causal principal

```text
actividad eléctrica cardíaca
        ↓
contracción miocárdica
        ↓
eyección ventricular
        ↓
onda de presión y flujo arterial
        ↓
propagación por el árbol vascular
        ↓
respuesta de vasos periféricos y microcirculación
        ↓
cambio pulsátil del volumen sanguíneo local
        ↓
modulación de absorción y dispersión óptica
        ↓
variación temporal captada por el sensor RGB
        ↓
señal PPG derivada
```

La cámara no observa directamente el corazón. Observa una consecuencia periférica, retardada y transformada por múltiples capas físicas y biológicas.

## 2. Qué es la sangre para el sistema

El sistema debe representar que la sangre relevante para PPG incluye:

- eritrocitos;
- hemoglobina;
- oxihemoglobina y desoxihemoglobina;
- plasma;
- volumen sanguíneo arterial y microvascular;
- flujo y perfusión;
- interacción dependiente de longitud de onda.

No debe representar “sangre” como `red > green`.

La evidencia óptica de sangre es indirecta y depende de:

- espectro del flash;
- sensibilidad del sensor;
- piel y tejido atravesado;
- profundidad efectiva;
- geometría;
- presión aplicada;
- exposición y procesamiento de cámara.

## 3. Qué es el pulso PPG

El PPG no es idéntico al latido cardíaco ni al ECG.

Debe distinguirse:

- evento eléctrico cardíaco;
- contracción y eyección;
- onda de presión arterial;
- cambio de volumen vascular periférico;
- observación óptica PPG.

Una periodicidad compatible no prueba por sí sola la cadena causal completa.

## 4. Variables latentes del modelo de mundo

Los agentes deben razonar, como mínimo, sobre estas variables no observadas directamente:

```ts
interface PhysiologicalWorldState {
  cardiacCycleContinuity: number;
  peripheralPerfusion: number;
  vascularTone: number;
  tissueCompression: number;
  opticalCoupling: number;
  bloodVolumePulseVisibility: number;
  motionContamination: number;
  illuminationStability: number;
  cameraProcessingInfluence: number;
  filterMemoryInfluence: number;
}
```

Estas variables no deben convertirse automáticamente en valores clínicos. Son conceptos para explicar observaciones y formular predicciones.

## 5. Modelo óptico

La observación depende de:

```text
luz emitida por flash
− absorción por tejido y cromóforos
− pérdidas geométricas
+ dispersión y reflexión
+ respuesta espectral del sensor
+ ganancia/exposición/procesamiento del teléfono
+ ruido
```

El componente DC representa principalmente la base óptica y tisular. El componente AC puede contener modulación pulsátil, pero también movimiento, exposición y ruido.

## 6. Efectos de presión y colocación

La presión aplicada puede:

- mejorar acoplamiento óptico;
- reducir fuga de luz;
- deformar tejido;
- comprimir vasos;
- reducir componente pulsátil;
- cambiar DC y relaciones entre canales;
- producir transiciones que parecen eventos fisiológicos.

Por eso, “más cobertura” no siempre significa “mejor perfusión”.

Hipótesis causal útil:

```text
DC alto + cobertura alta + AC decreciente + movimiento bajo
→ posible compresión vascular, no necesariamente ausencia de tejido.
```

## 7. Movimiento

El movimiento puede afectar:

- posición del ROI;
- cantidad de luz recibida;
- presión sobre la lente;
- exposición;
- mezcla espacial de píxeles;
- línea base;
- fase aparente;
- detección de picos.

Un agente debe preguntar qué fracción de la variación se explica por movimiento y qué componente permanece después de compensarlo.

## 8. Autoexposición y procesamiento de cámara

Los teléfonos pueden modificar automáticamente:

- exposición;
- ISO o ganancia;
- balance de blancos;
- enfoque;
- reducción de ruido;
- tone mapping;
- compresión.

Una oscilación común en todo el frame o simultánea en canales puede ser una respuesta de cámara. El sistema debe buscar correlación con metadatos y cambios globales.

## 9. Ringing y memoria del pipeline

Los filtros, buffers y suavizados pueden continuar produciendo energía después de que desapareció la fuente.

La señal filtrada no es una observación independiente. Debe conservar procedencia de la muestra cruda.

Predicción causal:

```text
si desaparece la evidencia óptica actual y queda solo energía filtrada,
la energía debe decaer según la respuesta del filtro;
no deben aparecer nuevos latidos con vigencia fisiológica.
```

## 10. Hipótesis rivales mínimas

El sistema debe poder considerar simultáneamente:

1. tejido perfundido con señal observable;
2. tejido perfundido con mala observabilidad;
3. compresión vascular;
4. movimiento dominante;
5. fuga de luz o contacto parcial;
6. autoexposición o iluminación externa;
7. escena inerte;
8. ringing o retención del pipeline;
9. mezcla de causas;
10. explicación todavía desconocida.

## 11. Predicciones y pruebas contrafactuales

Una hipótesis debe producir consecuencias verificables.

### Perfusión real

Predice continuidad temporal, modulación AC pequeña sobre DC, estructura multicanal y respuesta plausible a cambios de presión.

### Movimiento

Predice desplazamiento espacial, componente común y correlación con flujo óptico o IMU.

### Compresión excesiva

Predice caída de AC con tejido todavía ópticamente presente y posible recuperación al reducir presión.

### Exposición automática

Predice cambios globales en brillo y canales, relacionados con metadatos o transiciones de escena.

### Ringing

Predice decaimiento temporal sin renovación de evidencia cruda.

Los agentes deben comparar predicciones con observaciones posteriores y revisar sus creencias.

## 12. Intervenciones posibles

Cuando varias hipótesis siguen abiertas, el sistema puede solicitar una intervención pequeña y observar la respuesta:

- reducir ligeramente presión;
- mantener inmóvil durante una ventana corta;
- recolocar sin retirar completamente;
- cubrir mejor una fuga lateral;
- repetir una ventana con exposición bloqueada si el dispositivo lo permite.

La intervención no es solo UX. Es una prueba causal.

## 13. Observabilidad por variable

### Frecuencia cardíaca

Necesita temporalidad y pulsos distinguibles, pero no necesariamente morfología perfecta.

### Ritmo y RR

Necesita timestamps confiables, picos no fabricados y baja contaminación de movimiento.

### Morfología

Necesita forma preservada, sampling suficiente, acoplamiento estable y baja distorsión de filtros.

### Oxigenación

Necesita información multicanal estable, modelo óptico y calibración de dispositivo; no puede heredarse de HR.

### Presión

Necesita evidencia hemodinámica y personalización específica; no puede publicarse porque la onda “parece buena”.

### Respiración

Puede utilizar múltiples modalidades, pero debe identificar cuál produjo la estimación.

## 14. Qué debe saber explicar un agente

Ante una decisión, debe responder estructuradamente:

- qué fenómeno fisiológico supone;
- cómo ese fenómeno produciría la observación;
- qué evidencia lo apoya;
- qué evidencia lo contradice;
- qué hipótesis rival compite;
- qué debería ocurrir después;
- qué observación o intervención resolvería la duda;
- qué variable es observable y cuál no.