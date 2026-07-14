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

Los adaptadores pueden apuntar a modelos multimodales remotos, modelos de razonamiento, modelos locales ONNX/WebGPU/WASM o servidores locales compatibles. El proveedor no debe aparecer dentro de la lógica fisiológica.

## 3. Agentes iniciales

### Optical Scene Agent

Comprende la escena visual y su evolución; diferencia movimiento común, fuga de luz, exposición y variación localizada. No estima BPM.

### Cardiovascular Physiology Agent

Razona sobre ciclo cardíaco, pulso periférico, ritmo, RR y morfología. Explica qué cadena fisiológica podría producir la señal. No decide por sí solo que la escena corresponde a tejido.

### Blood & Hemodynamics Agent

Razona sobre perfusión, volumen sanguíneo, absorción multicanal, presión sobre tejido y respuesta vascular. Determina qué evidencia falta para oxigenación o presión.

### Artifact Skeptic Agent

Intenta refutar la interpretación fisiológica. Busca movimiento periódico, autoexposición, ringing, señal retenida, objetos inertes y correlaciones espurias. Debe producir objeciones concretas.

### Measurement Specialist Agents

Especialistas independientes para:

- frecuencia cardíaca y ritmo;
- morfología;
- oxigenación;
- investigación de presión arterial;
- respiración.

Ningún especialista habilita automáticamente a los demás.

### Episodic Memory Agent

Resume episodios, recuerda condiciones e intervenciones, recupera sesiones similares y separa experiencia personal de conocimiento general.

### Measurement Adjudicator

Recibe argumentos y objeciones, detecta desacuerdos, solicita nuevas herramientas u observaciones y decide qué variables pueden publicarse. Debe poder abstenerse. No se reemplaza por votación simple o promedio de scores.

## 4. Salida estructurada

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

La explicación textual no basta: debe referenciar evidencia concreta.

## 5. Herramientas disponibles

Los agentes pueden invocar:

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

Cada herramienta devuelve datos, método, versión, calidad y limitaciones.

## 6. Cadencia

### Por frame
Solo hot path local.

### Ventanas rápidas
Cada 0.5–2 segundos, modelos locales pequeños o herramientas actualizan embeddings y eventos.

### Eventos cognitivos
El orquestador llama a agentes cuando cambia la escena, aparece una contradicción, comienza o desaparece una señal, debe publicarse un resultado o una intervención produce una respuesta.

### Fin de sesión
Se genera memoria episódica y se evalúan errores. Solo se actualizan parámetros permitidos.

## 7. Local, remoto e híbrido

La ruta local nunca queda bloqueada esperando la nube. La capa remota trabaja sobre snapshots y puede revisar o enriquecer decisiones, declarando latencia y vigencia.

## 8. Vigencia y procedencia

```ts
interface MeasurementProvenance {
  observedAtMs: number;
  expiresAtMs: number;
  observationId: string;
  producingAgentOrEstimator: string;
  live: boolean;
}
```

Cuando no existe observación vigente, el valor vivo deja de existir. La memoria permanece, pero no mantiene la salida actual.

## 9. Auditoría

Cada decisión registra:

- modelo y versión;
- instrucciones versionadas;
- herramientas invocadas;
- evidencia;
- objeciones;
- decisión;
- tiempo y costo;
- resultado posterior observado.

## 10. Aceptación de la primera fase

La primera fase multiagente será válida cuando:

- exista al menos una invocación real de modelo avanzado;
- dos agentes tengan roles e instrucciones distintas;
- ambos usen herramientas reales del pipeline;
- exista desacuerdo representable;
- el adjudicador pueda pedir otra observación o abstenerse;
- la salida funcione en modo sombra, sin controlar todavía valores productivos;
- toda la deliberación quede trazada.