# Arquitectura multiagente propuesta

## Objetivo

Incorporar modelos avanzados reales como especialistas coordinados, sin ejecutar un modelo pesado en cada frame y sin sustituir los datos de cámara por texto o reglas.

## Vista general

```text
Cámara + flash + IMU + metadatos
                │
                ▼
Hot path local: adquisición, ROI, RGB, AC/DC, filtros, flujo óptico
                │
                ▼
Physiological Observation Bus
                │
                ├── ventanas de señal
                ├── keyframes y mapas espaciales
                ├── eventos de escena
                ├── resultados de herramientas DSP
                └── memoria de sesión
                │
                ▼
Cognitive Orchestrator
                │
                ├── Optical Scene Agent
                ├── Cardiovascular Physiology Agent
                ├── Blood & Hemodynamics Agent
                ├── Artifact Skeptic Agent
                ├── Measurement Specialist Agents
                ├── Episodic Memory Agent
                └── Measurement Adjudicator
```

## 1. Physiological Observation Bus

Es el contrato entre el pipeline rápido y los agentes. No debe enviar cada píxel indiscriminadamente. Debe producir paquetes reproducibles y trazables.

```ts
interface PhysiologicalObservationPacket {
  sessionId: string;
  observationId: string;
  startedAtMs: number;
  endedAtMs: number;
  deviceProfile: DeviceProfile;
  cameraState: CameraState;
  opticalSummary: OpticalSummary;
  signalWindows: SignalWindowBundle;
  motionSummary: MotionSummary;
  morphologySummary: MorphologySummary;
  keyframes?: EncodedKeyframe[];
  activeContradictions: Contradiction[];
  previousDecision?: AdjudicatedMeasurementDecision;
}
```

Todo campo debe provenir de observaciones reales o de herramientas identificadas. Los valores calculados deben declarar método, versión y timestamp.

## 2. Model Gateway

El proyecto necesita una interfaz independiente del proveedor.

```ts
interface AdvancedModelAdapter {
  id: string;
  capabilities: {
    vision: boolean;
    reasoning: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
    local: boolean;
  };
  invoke<TInput, TOutput>(request: ModelRequest<TInput>): Promise<ModelResult<TOutput>>;
}
```

Los adaptadores pueden apuntar a:

- modelos multimodales remotos;
- modelos de razonamiento remotos;
- modelos locales mediante ONNX/WebGPU/WASM;
- servidores locales compatibles con API;
- combinaciones de modelo principal y modelo económico.

El proveedor no debe aparecer dentro de la lógica fisiológica.

## 3. Agentes iniciales

### Optical Scene Agent

Responsabilidad:

- comprender la escena visual y su evolución;
- diferenciar cambio espacial, movimiento común, fuga de luz y variación localizada;
- analizar keyframes, mapas de tiles y flujo óptico;
- pedir herramientas adicionales cuando la escena sea ambigua.

No estima BPM.

### Cardiovascular Physiology Agent

Responsabilidad:

- razonar sobre ciclo cardíaco, pulso periférico, ritmo y continuidad fisiológica;
- revisar picos, RR, morfología, periodicidad y predicción;
- explicar qué cadena fisiológica podría producir la señal.

No decide por sí solo si la escena visual corresponde a tejido.

### Blood & Hemodynamics Agent

Responsabilidad:

- razonar sobre perfusión, volumen sanguíneo, absorción multicanal, presión sobre tejido y respuesta vascular;
- contrastar hipótesis de baja perfusión, compresión, fuga óptica y cambio de exposición;
- determinar qué evidencia sería necesaria para oxigenación o presión.

### Artifact Skeptic Agent

Responsabilidad:

- intentar refutar la interpretación fisiológica;
- buscar movimiento periódico, autoexposición, ringing, señal retenida, objeto inerte y correlaciones espurias;
- ejecutar pruebas adversarias mediante herramientas;
- generar objeciones concretas, no un score genérico.

### Measurement Specialist Agents

Un especialista separado para cada familia:

- Heart Rate & Rhythm Agent;
- Morphology Agent;
- Oxygenation Agent;
- Blood Pressure Research Agent;
- Respiration Agent.

Cada uno devuelve observabilidad y decisión propia. Ningún especialista puede habilitar automáticamente a los demás.

### Episodic Memory Agent

Responsabilidad:

- resumir cada episodio de medición;
- recordar condiciones, intervenciones y resultados;
- recuperar episodios similares;
- separar experiencia personal de conocimiento general;
- impedir que una lectura histórica sea presentada como observación actual.

### Measurement Adjudicator

Responsabilidad:

- recibir argumentos y objeciones;
- detectar desacuerdo entre agentes;
- solicitar nuevas herramientas u observaciones;
- decidir qué variables pueden publicarse;
- registrar una justificación estructurada;
- abstenerse cuando la evidencia sea insuficiente.

No debe reemplazarse por votación simple ni promedio de scores.

## 4. Salida estructurada de un agente

```ts
interface AgentAssessment {
  agentId: string;
  modelId: string;
  observationId: string;
  hypotheses: Array<{
    name: string;
    probability?: number;
    supportingEvidence: EvidenceReference[];
    contradictingEvidence: EvidenceReference[];
    predictedConsequences: PredictedObservation[];
  }>;
  requestedTools: ToolRequest[];
  requestedObservation?: ObservationRequest;
  conclusion: string;
  uncertainty: number;
  abstain: boolean;
}
```

La explicación textual no es suficiente. Debe referenciar evidencia concreta.

## 5. Herramientas disponibles

Los agentes no calculan todo mediante lenguaje. Pueden invocar:

- `inspectAcDc`;
- `computeSpectrum`;
- `inspectChannelPhase`;
- `analyzeBeatMorphology`;
- `estimateOpticalFlow`;
- `compensateMotion`;
- `inspectExposureCorrelation`;
- `detectFilterRinging`;
- `compareWindows`;
- `retrieveSimilarEpisodes`;
- `runCounterfactualTest`;
- `requestPressureAdjustmentObservation`.

Cada herramienta debe devolver datos, método, versión, calidad y limitaciones.

## 6. Cadencia de ejecución

### Por frame

Solo hot path local.

### Ventanas rápidas

Cada 0.5–2 segundos, modelos locales pequeños o herramientas DSP pueden actualizar embeddings y eventos.

### Eventos cognitivos

El orquestador llama a agentes cuando:

- comienza una escena candidata;
- cambia el régimen óptico;
- aparece o desaparece una señal;
- los estimadores se contradicen;
- debe publicarse un nuevo resultado;
- se detecta una anomalía;
- una intervención del usuario produce una respuesta.

### Revisión de sesión

Al finalizar, los agentes generan memoria episódica, evalúan errores y actualizan únicamente parámetros permitidos.

## 7. Ejecución local, remota e híbrida

### Local

Ventajas: privacidad, baja latencia, funcionamiento offline.

Adecuado para:

- modelos temporales pequeños;
- embeddings;
- detección de eventos;
- herramientas matemáticas;
- política inmediata de publicación.

### Remota

Adecuada para:

- razonamiento multimodal profundo;
- contraste entre especialistas;
- análisis de episodios complejos;
- desarrollo y diagnóstico.

### Híbrida

La ruta local nunca debe quedar bloqueada esperando la nube. La capa remota trabaja sobre snapshots y puede revisar o enriquecer decisiones, pero cualquier resultado debe declarar su latencia y vigencia.

## 8. Seguridad arquitectónica contra falsas mediciones

Aunque no debe existir un gate universal, sí debe existir una propiedad de vigencia:

```ts
interface MeasurementProvenance {
  observedAtMs: number;
  expiresAtMs: number;
  observationId: string;
  producingAgentOrEstimator: string;
  live: boolean;
}
```

Cuando no existe observación vigente, el valor vivo deja de existir. La memoria de sesión permanece, pero no puede mantener la salida actual.

## 9. Observabilidad y auditoría

Cada decisión debe registrar:

- modelo y versión;
- prompts o instrucciones versionados;
- herramientas invocadas;
- evidencia utilizada;
- objeciones;
- decisión final;
- tiempo y costo;
- resultado posterior observado.

Esto permitirá comparar modelos y reemplazarlos sin perder la historia del sistema.

## 10. Criterio de aceptación de la primera fase

La primera fase multiagente será válida cuando:

- exista al menos una invocación real de modelo avanzado;
- dos agentes tengan roles y prompts distintos;
- ambos usen herramientas reales del pipeline;
- exista desacuerdo representable;
- el adjudicador pueda pedir una observación adicional o abstenerse;
- la salida no controle todavía valores productivos;
- toda la deliberación quede trazada en modo sombra.