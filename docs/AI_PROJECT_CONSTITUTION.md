# Constitución técnica de IA — BioBeat Tracker

## Propósito

Este documento fija el objetivo, el lenguaje y los límites arquitectónicos del proyecto. Su función es impedir que una IA futura confunda una mejora algorítmica con una inteligencia fisiológica o vuelva a reducir toda la aplicación a `dedo/no dedo`.

## Artículo 1 — El objeto de observación

La aplicación no tiene como objeto principal “un dedo”. El dedo es una forma práctica de aproximar tejido periférico a la cámara y al flash.

El objeto de observación es una escena óptica dinámica que puede contener información causada por:

- tejido humano;
- sangre circulante;
- variación pulsátil del volumen vascular;
- movimiento;
- presión y deformación del tejido;
- exposición automática;
- fuga de luz;
- ruido y procesamiento interno de la cámara.

La aplicación debe inferir qué causas explican mejor las observaciones y qué variables son observables en cada momento.

## Artículo 2 — No existe un permiso único para medir

No debe existir una única variable que habilite todo el pipeline.

Quedan rechazados como autoridad global:

- `fingerDetected`;
- `contactState` usado como permiso universal;
- color rojo;
- cobertura;
- una frecuencia en banda cardíaca;
- un único SQI;
- una única probabilidad de perfusión.

Cada variable necesita su propio estado de observabilidad, evidencia, incertidumbre y vencimiento temporal.

## Artículo 3 — Definiciones obligatorias

### Regla

Relación programada explícitamente por el desarrollador.

### Algoritmo DSP

Transformación numérica de señal: filtros, FFT, wavelets, AC/DC, detección de picos, Kalman, etc.

### Modelo estadístico

Sistema que estima probabilidades o parámetros a partir de una forma matemática o datos.

### Modelo avanzado

Modelo neuronal o multimodal con pesos reales, runtime de inferencia y capacidad superior a reglas escritas manualmente.

### Agente

Modelo avanzado con rol, contexto, herramientas, memoria, bucle de decisión y salida estructurada.

### Sistema multiagente

Conjunto de agentes con responsabilidades separadas, posibilidad de desacuerdo y un adjudicador que conserva trazabilidad.

### Razonamiento causal

Proceso que relaciona causas, observaciones, predicciones, contradicciones e intervenciones. Debe poder revisar una conclusión cuando una consecuencia esperada no ocurre.

## Artículo 4 — Honestidad semántica

Ningún símbolo o nombre debe exagerar la capacidad real del código.

Ejemplos prohibidos:

- `ReasoningAgent` para una clase sin invocación de modelo;
- `BloodUnderstanding` para un cociente RGB;
- `CognitiveEngine` para un softmax;
- narrativa textual prefabricada presentada como explicación generada;
- `AI confidence` cuando es solamente un score manual.

El nombre debe describir la tecnología real.

## Artículo 5 — Conocimiento fisiológico

Los agentes fisiológicos deben poseer o recuperar conocimiento sobre:

- ciclo cardíaco;
- eyección ventricular;
- propagación de onda arterial;
- circulación periférica;
- perfusión y tono vascular;
- sangre, eritrocitos y hemoglobina;
- absorción y dispersión óptica;
- PPG de contacto;
- efectos de presión, temperatura, movimiento y exposición.

Ese conocimiento debe participar en la inferencia y no quedar como texto decorativo.

## Artículo 6 — Herramientas matemáticas

FFT, filtros, picos, RR, morfología, flujo óptico, IMU y estimadores existentes siguen siendo necesarios.

Su función correcta es aportar observaciones y pruebas a los agentes. Ninguna herramienta aislada constituye comprensión.

## Artículo 7 — Memoria y aprendizaje personal

La app puede aprender con las sesiones del usuario sin depender permanentemente de otro aparato.

Debe separar:

- memoria episódica: qué ocurrió en una sesión concreta;
- perfil personal: patrones recurrentes del usuario y dispositivo;
- memoria de artefactos: situaciones que produjeron falsos positivos;
- conocimiento general: fisiología y óptica que no dependen del usuario.

La memoria no puede convertir una salida anterior en evidencia actual.

## Artículo 8 — Publicación de signos vitales

Para publicar un valor deben existir:

- observación actual;
- fuente identificable;
- evidencia suficiente para esa variable;
- incertidumbre calculada;
- ausencia de contradicciones críticas;
- timestamp y vencimiento;
- trazabilidad de qué modelo o algoritmo lo produjo.

Una lectura histórica puede mostrarse, pero debe marcarse como histórica y nunca como viva.

## Artículo 9 — Estrategia de modelos

La arquitectura debe ser independiente del proveedor. Los modelos deben conectarse mediante adaptadores y capacidades declaradas:

- visión;
- razonamiento;
- tool calling;
- salida JSON estructurada;
- contexto suficiente;
- ejecución local o remota;
- costo y latencia conocidos.

No se debe diseñar toda la aplicación alrededor de un único proveedor o nombre comercial.

## Artículo 10 — Investigación audaz con verificación estricta

El proyecto puede intentar enfoques no convencionales o inéditos. Que una práctica no sea habitual no constituye por sí solo una prohibición técnica.

Pero cada avance debe distinguir:

- hipótesis;
- prototipo;
- resultado observado;
- validación reproducible;
- capacidad productiva.

Audacia no significa inventar resultados. Implica probar ideas difíciles con instrumentación, trazabilidad y pruebas adversarias.

## Artículo 11 — Prohibición de regresiones conceptuales

Toda IA debe revisar la historia reciente del repositorio. PRs anteriores declararon repetidamente “razonamiento” mientras implementaban inferencia bayesiana, validadores o gates que luego fueron reemplazados o revertidos.

Antes de implementar una nueva solución, debe verificarse:

- qué código está realmente en `main`;
- qué PRs fueron sobrescritos;
- qué pruebas todavía existen;
- si la solución duplica un intento anterior;
- si el nombre describe la capacidad real.

## Artículo 12 — Cambio de esta constitución

Los cambios deben realizarse mediante PR explícito, con justificación técnica. Ninguna IA puede ignorar silenciosamente este documento por comodidad de implementación.