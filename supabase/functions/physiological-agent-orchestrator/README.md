# Physiological Agent Orchestrator

Primera integración real de modelos avanzados y subagentes en BioBeat Tracker.

## Estado

```text
MODO SOMBRA — NO PUBLICA SIGNOS VITALES
```

La función no está conectada todavía al flujo productivo. Analiza paquetes de observación seleccionados y devuelve deliberación auditable.

## Qué ejecuta

1. **Optical Scene Agent**
   - recibe resumen óptico y hasta dos keyframes;
   - elige herramientas;
   - evalúa escena, movimiento, exposición, presión aparente y evidencia insuficiente.

2. **Artifact Skeptic Agent**
   - intenta refutar la interpretación fisiológica;
   - busca periodicidad por movimiento, exposición, iluminación, ringing o muestras retenidas;
   - elige herramientas matemáticas.

3. **Measurement Adjudicator**
   - recibe ambos análisis;
   - conserva desacuerdos;
   - puede abstenerse o solicitar otra observación;
   - solo clasifica variables como `UNASSESSED`, `NOT_OBSERVABLE` o `POSSIBLY_OBSERVABLE`;
   - siempre devuelve `mayPublishVitals: false`.

Cada agente se ejecuta en un contexto separado. No son nombres aplicados a funciones TypeScript: cada uno realiza invocaciones reales al modelo configurado.

## Modelo

Variable opcional:

```text
PHYSIO_AGENT_MODEL
```

Default actual:

```text
google/gemini-3-flash-preview
```

La función utiliza el gateway ya presente en el proyecto:

```text
https://ai.gateway.lovable.dev/v1/chat/completions
```

Secreto requerido:

```text
LOVABLE_API_KEY
```

También requiere los secretos Supabase habituales:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
```

## Por qué no reutiliza directamente `analyze-vitals`

`analyze-vitals` recibe valores ya calculados y genera una explicación o recomendación posterior. No observa frames, señales, herramientas ni hipótesis rivales.

Este orquestador trabaja antes de cualquier narrativa final y recibe evidencia de adquisición.

## Request

La llamada requiere un JWT válido de Supabase.

```json
{
  "observation": {
    "sessionId": "session-001",
    "observationId": "window-001",
    "startedAtMs": 1000,
    "endedAtMs": 5000,
    "signal": {
      "sampleRateHz": 30,
      "filtered": [0.01, 0.08, 0.18, 0.06],
      "morphology": [0.00, 0.04, 0.15, 0.03],
      "red": [210, 211, 214, 211],
      "green": [72, 73, 76, 73],
      "blue": [34, 34, 35, 34],
      "timestampsMs": [1000, 1033, 1066, 1099]
    },
    "optical": {
      "coverageRatio": 0.82,
      "saturationRatio": 0.04,
      "underexposureRatio": 0.01,
      "motionScore": 0.12,
      "centroidMotion": 0.05,
      "exposureJitterMs": 1.7
    },
    "keyframes": [
      "data:image/jpeg;base64,..."
    ],
    "context": {
      "event": "candidate_signal_started",
      "deviceProfile": "runtime-profile-id"
    }
  }
}
```

Las series se limitan a 512 muestras. Se aceptan como máximo dos keyframes y cada uno debe ser un data URL de imagen.

## Herramientas disponibles

- `window_integrity`
- `ac_dc`
- `channel_correlation`
- `cardiac_band_spectrum`
- `rgb_common_mode`
- `ringing_decay`
- `motion_summary`

El modelo primero elige herramientas. El servidor valida la selección, ejecuta las funciones localmente y devuelve resultados al mismo agente para una segunda inferencia.

## Response

```json
{
  "mode": "shadow",
  "model": "google/gemini-3-flash-preview",
  "sessionId": "session-001",
  "observationId": "window-001",
  "agents": {
    "opticalScene": {},
    "artifactSkeptic": {}
  },
  "adjudication": {
    "abstain": true,
    "observability": {
      "heartRate": "UNASSESSED",
      "rhythm": "UNASSESSED",
      "morphology": "UNASSESSED",
      "oxygenation": "UNASSESSED",
      "pressure": "UNASSESSED",
      "respiration": "UNASSESSED"
    },
    "mayPublishVitals": false
  },
  "trace": {
    "opticalPlan": {},
    "opticalTools": [],
    "skepticPlan": {},
    "skepticTools": [],
    "latencyMs": {}
  }
}
```

## Cadencia correcta

No llamar esta función en cada frame.

Eventos iniciales recomendados:

- aparición de una escena candidata;
- cambio importante de movimiento o exposición;
- contradicción entre estimadores;
- pérdida de observabilidad;
- intervención del usuario y respuesta posterior;
- revisión de una ventana antes de guardarla como episodio.

## Seguridad y aislamiento

- La API key vive únicamente en Supabase.
- Se exige usuario autenticado.
- Las respuestas se validan como JSON.
- Las herramientas están en allowlist.
- El contexto del usuario se declara como datos, no como instrucciones.
- Los modelos tienen timeout.
- La función no modifica el estado de medición ni la base de datos.

## Coste actual

Una evaluación completa realiza cinco invocaciones:

- plan del Optical Scene Agent;
- conclusión del Optical Scene Agent;
- plan del Artifact Skeptic Agent;
- conclusión del Artifact Skeptic Agent;
- adjudicación.

Esto es deliberadamente costoso para la fase de laboratorio. Debe medirse antes de optimizar mediante modelos diferentes, caching o reducción de rondas.

## Próxima integración

1. construir `PhysiologicalObservationPacket` en el cliente;
2. capturar ventanas solo en eventos;
3. crear consola de trazas en modo desarrollador;
4. comparar respuestas con la evolución real de la señal;
5. mantener `mayPublishVitals=false` hasta completar pruebas adversarias.