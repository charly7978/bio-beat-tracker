# Hoja de ruta de implementación

La progresión se define por capacidades verificables, no por fechas ni nombres atractivos.

## Fase 0 — Base honesta y trazable

### Objetivo

Corregir nombres y eliminar estados que contradicen la misión antes de integrar agentes.

### Trabajo

- Renombrar `PhysiologicalReasoningCore` a `HeuristicEvidenceEngine` y sus tipos/diagnósticos.
- Documentar explícitamente que no es un agente.
- Eliminar valores normales por defecto en `riskAnalyzer`.
- Inventariar todas las rutas `lastGood*`, sample hold y republicación de valores.
- Agregar `MeasurementProvenance` y vencimiento a lecturas vivas.
- Crear tests de ausencia explícita.

### Aceptación

- Ningún archivo heurístico usa “reasoning”, “cognitive” o “agent”.
- Ausencia de medición no produce 72, 98 o 120/80.
- Toda lectura viva tiene fuente, observación y expiración.

## Fase 1 — Bus de observaciones y herramientas

### Objetivo

Preparar datos reales y reproducibles para modelos y agentes.

### Trabajo

- Crear `PhysiologicalObservationPacket`.
- Implementar ring buffer de ventanas cognitivas.
- Seleccionar keyframes y mapas de tiles.
- Registrar metadatos de exposición disponibles.
- Adaptar DSP existente a herramientas invocables:
  - espectro;
  - AC/DC;
  - fase multicanal;
  - morfología;
  - movimiento;
  - ringing;
  - comparación de ventanas.
- Versionar resultados de herramientas.

### Aceptación

- Una sesión puede reproducirse desde paquetes guardados.
- Cada herramienta produce salida estructurada y procedencia.
- El hot path no sufre regresión de FPS.

## Fase 2 — Gateway de modelos reales

### Objetivo

Integrar modelos avanzados sin acoplar la fisiología a un proveedor.

### Trabajo

- Crear `AdvancedModelAdapter`.
- Soportar salida JSON validada por schema.
- Añadir timeout, cancelación, fallback y límites de frecuencia.
- Registrar modelo, versión, latencia y costo.
- Crear adaptador de desarrollo para un modelo multimodal con visión y tool calling.
- Crear adaptador local o compatible con servidor local cuando esté disponible.

### Aceptación

- Existe una invocación real demostrable.
- Un timeout no bloquea cámara ni medición local.
- La respuesta inválida se rechaza, no se convierte en decisión.
- Las claves no se exponen en el cliente de producción.

## Fase 3 — Primer sistema de dos agentes

### Objetivo

Probar deliberación real en modo sombra.

### Agentes

1. Optical Scene Agent.
2. Artifact Skeptic Agent.

### Trabajo

- Roles e instrucciones versionadas.
- Acceso a herramientas reales.
- Capacidad de pedir otra herramienta.
- Hipótesis, evidencia, contradicciones y predicciones estructuradas.
- Registro de desacuerdo.

### Aceptación

- Ambos agentes analizan el mismo paquete con roles distintos.
- Pueden llegar a conclusiones diferentes.
- Una conclusión referencia evidencia concreta.
- Ninguno controla valores productivos.

## Fase 4 — Adjudicador y abstención

### Objetivo

Resolver o conservar desacuerdos sin promediar scores.

### Trabajo

- Implementar `MeasurementAdjudicator` con modelo real.
- Permitir:
  - solicitar herramienta;
  - solicitar nueva observación;
  - pedir intervención breve;
  - abstenerse;
  - declarar variable no observable.
- Incorporar procedencia y expiración.

### Aceptación

- Puede decidir “HR observable; SpO2 no observable”.
- Puede mantener la sesión durante movimiento sin publicar valores nuevos.
- Puede detectar que solo queda ringing.
- Toda decisión queda auditada.

## Fase 5 — Agentes fisiológicos

### Objetivo

Agregar comprensión cardiovascular y hemodinámica.

### Agentes

- Cardiovascular Physiology Agent.
- Blood & Hemodynamics Agent.
- Heart Rate & Rhythm Specialist.
- Morphology Specialist.

### Trabajo

- Base de conocimiento versionada.
- Herramientas de RR, morfología y multicanal.
- Predicciones de consecuencias.
- Pruebas contrafactuales por presión, movimiento y exposición.

### Aceptación

- Los agentes usan la cadena causal documentada.
- No confunden ECG, pulso arterial y PPG.
- Pueden explicar por qué una oscilación no representa perfusión.
- Pueden pedir intervención y revisar la hipótesis según el resultado.

## Fase 6 — Memoria episódica y aprendizaje con el usuario

### Objetivo

Aprender de sesiones reales sin convertir memoria en observación presente.

### Trabajo

- Almacenar episodios resumidos y features.
- Recuperar sesiones similares.
- Registrar intervenciones y resultados.
- Separar perfil de usuario, dispositivo y ambiente.
- Implementar política de actualización con rollback.

### Aceptación

- La app recuerda qué funcionó en un dispositivo y contexto.
- Puede explicar qué episodio recuperó.
- Una memoria nunca renueva el timestamp de una medición.
- El usuario puede borrar o reiniciar la memoria.

## Fase 7 — Influencia controlada sobre producción

### Objetivo

Permitir que el sistema inteligente afecte decisiones de publicación gradualmente.

### Orden

1. recomendaciones de adquisición;
2. abstención y pausa de actualización;
3. observabilidad de HR;
4. observabilidad de RR y ritmo;
5. morfología;
6. oxigenación;
7. presión investigacional.

### Aceptación

Cada escalón requiere comparación en modo sombra, pruebas adversarias y rollback independiente.

## Fase 8 — Laboratorio continuo

### Objetivo

Convertir cada sesión voluntaria en material de investigación reproducible.

### Trabajo

- consola de agentes;
- exportación de paquetes anonimizados;
- replay determinista;
- comparación de modelos;
- catálogo de falsos positivos;
- pruebas por modelo de teléfono;
- evaluación de cambios antes/después.

## Reglas de ejecución

- No saltar de Fase 1 a publicación clínica.
- No llamar “multiagente” a prompts ejecutados sin herramientas ni desacuerdo.
- No eliminar DSP útil para aparentar una solución puramente IA.
- No entrenar memoria sobre ventanas que el sistema no puede explicar.
- No fusionar una fase sin sus criterios de aceptación.