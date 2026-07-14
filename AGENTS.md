# AGENTS.md — guía obligatoria para cualquier IA que trabaje en BioBeat Tracker

Este archivo debe leerse antes de modificar código, arquitectura, documentación o claims del proyecto.

## 1. Misión real del proyecto

BioBeat Tracker intenta extraer la máxima información fisiológica posible a partir de cámara trasera, flash y sensores disponibles en un teléfono, sin simulación, sin valores aleatorios y sin presentar como medición viva información retenida o fabricada.

El objetivo de investigación e ingeniería es superar el enfoque tradicional de una cadena de gates y algoritmos aislados. La aplicación debe evolucionar hacia un sistema que combine:

- procesamiento óptico y DSP de alta frecuencia;
- modelos avanzados reales;
- agentes especializados con herramientas;
- memoria episódica y personal;
- contraste de hipótesis;
- razonamiento causal fisiológico;
- observabilidad independiente por variable.

## 2. Regla principal

No llamar “razonamiento”, “agente”, “comprensión” o “IA avanzada” a una función que únicamente aplica reglas, pesos, umbrales, filtros, softmax o estados deterministas.

Clasificar cada incorporación con honestidad:

1. regla determinista;
2. algoritmo DSP;
3. estimador estadístico;
4. modelo neuronal;
5. modelo multimodal;
6. agente con modelo y herramientas;
7. sistema multiagente;
8. razonamiento causal con memoria e intervención.

Una capa inferior puede ser útil, pero no debe recibir el nombre de una capa superior.

## 3. Qué significa “agente” en este repositorio

Un agente debe incluir, como mínimo:

- una invocación real a un modelo avanzado o un runtime de inferencia identificable;
- instrucciones o conocimiento de dominio explícito;
- acceso a herramientas del pipeline;
- entrada estructurada con observaciones reales;
- salida estructurada con hipótesis, evidencia, contradicciones e incertidumbre;
- memoria o acceso a contexto de sesión;
- capacidad de pedir otra herramienta u observación antes de concluir.

Una clase TypeScript con `if`, pesos y textos prefabricados no es un agente.

## 4. Qué significa “razonamiento fisiológico”

Debe manipular causalmente esta cadena:

actividad cardíaca → contracción → eyección → onda arterial → perfusión periférica → cambio de volumen vascular → interacción luz/tejido/sangre → observación RGB/PPG.

Debe poder distinguir explicaciones rivales como:

- perfusión sanguínea observable;
- movimiento;
- exposición automática;
- fuga de luz;
- presión excesiva u oclusión parcial;
- contacto deficiente;
- ringing o memoria de filtros;
- escena inerte o estímulo óptico externo.

No alcanza con que una frecuencia se encuentre dentro de un rango fisiológico.

## 5. Principios no negociables

- Prohibido simular signos vitales o completar huecos con valores plausibles.
- Prohibido convertir `lastGoodValue` en medición actual.
- Prohibido alimentar una muestra anterior con timestamp nuevo como si fuera observación real.
- Ninguna variable debe publicarse solo porque otra variable parece válida.
- HR, ritmo, morfología, SpO2, presión y respiración necesitan observabilidad propia.
- El movimiento debe degradar o pausar inferencias; no debe inventar latidos ni necesariamente destruir toda la sesión.
- La app debe registrar qué observó, qué modelo participó, qué herramientas usó y por qué publicó o retuvo un resultado.
- Los modelos externos no reemplazan el DSP; utilizan el DSP como herramientas.
- El DSP no debe presentarse como comprensión.

## 6. Estrategia de ejecución

Separar dos velocidades:

### Hot path local

Corre por frame o por muestra:

- adquisición;
- ROI y tiles;
- RGB y AC/DC;
- filtros;
- flujo óptico;
- IMU;
- extracción de características;
- buffers;
- renderizado.

No debe bloquear la cámara ni depender de una API remota por frame.

### Cognitive path

Se activa por ventanas o eventos relevantes:

- cambio de escena;
- contradicción entre fuentes;
- inicio o pérdida de observabilidad;
- morfología anómala;
- movimiento significativo;
- decisión de publicación;
- necesidad de intervención al usuario.

Esta capa puede ejecutar modelos multimodales y subagentes.

## 7. Documentos que deben leerse

En este orden:

1. `AGENTS.md`
2. `docs/AI_PROJECT_CONSTITUTION.md`
3. `docs/MULTI_AGENT_ARCHITECTURE.md`
4. `docs/PHYSIOLOGY_WORLD_MODEL.md`
5. `docs/AI_HANDOFF_CURRENT_STATE.md`
6. `docs/IMPLEMENTATION_ROADMAP.md`
7. `docs/PR_AI_CLASSIFICATION_CHECKLIST.md`

## 8. Estado especial del PR #40

El PR #40 fue fusionado a `main`. El archivo `PhysiologicalReasoningCore` que incorporó es una fusión heurística probabilística; no constituye razonamiento fisiológico ni un agente. Debe tratarse como infraestructura transitoria de evidencia, renombrarse a `HeuristicEvidenceEngine` o sustituirse. Ninguna IA debe citar su presencia como prueba de que la arquitectura multiagente ya existe.

## 9. Requisitos para cada PR

Todo PR relacionado con IA, medición o razonamiento debe declarar:

- categoría real de la tecnología incorporada;
- modelo exacto y runtime, si existe;
- datos de entrada;
- herramientas disponibles;
- frecuencia de ejecución;
- ruta de fallo;
- comportamiento al retirar la fuente;
- qué valores puede publicar y cuáles no;
- pruebas adversarias;
- limitaciones todavía abiertas.

## 10. Norma de continuidad

No reescribir la misión a partir de cero en cada sesión. Si una nueva IA considera necesario cambiar estos principios, debe explicar la contradicción concreta y modificar primero la documentación mediante un PR explícito. No debe cambiar silenciosamente la arquitectura ni volver al paradigma de un gate único.