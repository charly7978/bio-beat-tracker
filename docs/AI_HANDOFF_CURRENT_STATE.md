# Entrega de contexto para futuras IAs

**Snapshot de referencia:** 14 de julio de 2026  
**`main` observado:** `ea356e835c826403e96527c0d13dc38518c2a435`

Este documento resume lo que está realmente presente y qué no debe inferirse de títulos de PR antiguos.

## 1. Stack actual

- React 18 + TypeScript + Vite.
- Capacitor para Android y sensores.
- Procesamiento PPG principal dentro de `src/workers/ppgSignal.worker.ts` y `PPGSignalProcessor`.
- DSP, adquisición, calidad y estimadores implementados principalmente como código TypeScript local.
- Dependencia `@huggingface/transformers` declarada, pero no se encontró una integración activa de modelo avanzado en el código fuente del snapshot auditado.

## 2. Estado de modelos avanzados

PRs históricos declararon TCN ONNX, CLIP y Cortex. Esos servicios y workers no aparecen en el árbol fuente actual auditado. Por lo tanto:

- no asumir que el TCN sigue activo;
- no asumir que CLIP sigue activo;
- no asumir que existe un orquestador Cortex productivo;
- verificar siempre los archivos de `main`, no la descripción de PRs.

El proyecto actual no posee todavía el sistema multiagente definido en `MULTI_AGENT_ARCHITECTURE.md`.

## 3. Estado del PR #40

El PR #40 fue fusionado a `main`. Agregó:

- `src/lib/reasoning/PhysiologicalReasoningCore.ts`;
- tests heurísticos;
- integración por frame en `useSignalProcessor`;
- diagnósticos denominados `physiologicalReasoning`;
- persistencia de perfil en almacenamiento local.

Clasificación correcta:

```text
fusión heurística probabilística + memoria estadística
```

No es:

```text
modelo avanzado
agente
sistema multiagente
razonamiento causal fisiológico
```

Debe renombrarse o reemplazarse. Mientras exista, solo puede actuar como fuente auxiliar de evidencia en modo sombra.

## 4. Problemas críticos observados en el pipeline

### Detección óptica y contacto

`PPGSignalProcessor` conserva imports y lógica de:

- firma de hemoglobina basada en color;
- classifier de escena de dedo;
- ensemble de brillo, histograma y estabilidad;
- cobertura y tiles;
- histéresis prolongada de contacto.

Esto confirma que soluciones de PRs anteriores que decían haber eliminado el enfoque colorimétrico no son autoridad sobre el código actual.

### Persistencia artificial de muestra

`HeartBeatProcessor` puede reutilizar el último valor cuando la muestra actual es casi cero y asignarle un timestamp nuevo. Esto fabrica continuidad temporal.

### Relajación después de no encontrar picos

La detección puede reducir el gate y entrar en modo de reacquisición cuando pasan varios milisegundos sin picos. Si el estado de contacto permanece incorrectamente activo, la ausencia de pulso puede volver más permisivo al detector.

### Retención de BPM y vitales

`useSignalRouter` contiene rutas que reutilizan:

- última entrada del heartbeat;
- `lastGoodBpm`;
- valores existentes de SpO2 o presión mientras el contacto se considera utilizable.

La salida viva depende demasiado del estado de contacto histórico.

### Valores normales por defecto

`src/lib/ml/riskAnalyzer.ts` usa defaults como:

- HR 72;
- SpO2 98;
- presión 120/80.

Aunque se usen para análisis de riesgo y no para la pantalla principal, esto viola la política de no convertir ausencia de medición en normalidad. Debe reemplazarse por ausencia explícita o estado no evaluable.

## 5. Asimetría de experiencia actual

El sistema puede:

- castigar micromovimientos reales como artefactos;
- conservar contacto por histéresis cuando se retiró la fuente;
- seguir alimentando buffers o salidas con evidencia histórica;
- aceptar escenas estáticas porque la quietud mejora ciertos scores.

Resultado: un dedo vivo con temblor puede ser degradado mientras una escena ya sin dedo puede mantener valores plausibles.

## 6. Invariante pendiente

El proyecto no debe depender de un gate universal, pero toda lectura viva necesita procedencia y vigencia:

```text
sin observación física actual que sustente una variable
→ esa variable no tiene valor vivo actual
```

Esto no implica apagar toda la sesión. Puede preservarse memoria y estado de adquisición, pero no publicarse información como actual.

## 7. Qué NO hacer a continuación

- No agregar otro score llamado “inteligencia”.
- No sumar más condiciones a `fingerDetected` como solución final.
- No usar un LLM para narrar conclusiones ya decididas por reglas.
- No enviar cada frame a una API.
- No permitir que un agente textual publique directamente vitales sin herramientas y procedencia.
- No reintroducir datos normales por defecto.
- No fusionar cambios solo porque los tests sintéticos pasen.

## 8. Próximo corte implementable

El siguiente PR de código debe crear infraestructura real, todavía en modo sombra:

1. `PhysiologicalObservationPacket` y bus de observaciones.
2. Registro de herramientas DSP invocables con resultados versionados.
3. `AdvancedModelAdapter` independiente del proveedor.
4. Dos agentes reales mínimos:
   - Optical Scene Agent;
   - Artifact Skeptic Agent.
5. Salida JSON estructurada.
6. `MeasurementAdjudicator` capaz de registrar desacuerdo y abstención.
7. Trazas persistentes para comparar la deliberación con lo ocurrido después.

No debe controlar BPM, SpO2 o presión en la primera integración.

## 9. Pruebas adversarias prioritarias

- dedo estable → retirada brusca;
- dedo con micromovimiento;
- presión excesiva y posterior reducción;
- pared, mesa, tela, objeto rojo;
- flash abierto;
- luz ambiental variable;
- movimiento periódico del teléfono;
- señal filtrada residual después de retirar la fuente;
- valores faltantes en risk analyzer;
- desconexión o timeout del modelo avanzado.

## 10. Norma para la próxima IA

Antes de escribir código:

1. leer todos los documentos indicados en `AGENTS.md`;
2. inspeccionar `main` actual;
3. declarar la categoría real de la solución;
4. identificar qué modelo será invocado y con qué herramientas;
5. definir cómo falla y cómo se abstiene;
6. implementar en rama separada y modo sombra.