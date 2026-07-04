# Plan Maestro: Estabilización Fisiológica e IA de Grado Clínico

Este plan representa un rediseño total para transformar el pipeline de señales en una herramienta de precisión médica, tratando el corazón como tejido vivo y eliminando cualquier rastro de simulación o lógica basada en "ecuaciones ciegas".

## Filosofía del Proyecto: "La Verdad sobre la Velocidad"
Priorizaremos la **Verdad Clínica** (calidad 100%, preservación de muesca dicrótica) sobre la respuesta rápida de la UI. Si la señal es ruidosa, el sistema esperará o razonará, pero nunca mentirá.

---

## Fases de Implementación

### Fase 1: Auditoría Anti-Simulación Total
Realizar un barrido quirúrgico de toda la aplicación para eliminar:
- [ ] Temporizadores que avanzan el progreso sin evidencia física.
- [ ] Valores por defecto que aparecen antes de la estabilidad real.
- [ ] Incrementos fijos en barras de progreso o calibraciones.
- [ ] *Nota: Se respetará la visualización estética de la onda cardíaca por petición expresa del usuario.*

### Fase 2: Fase Cero - Optimización Dinámica del Sensor
- [ ] Implementar un bucle de control de hardware en `CameraView.tsx` que no use valores fijos.
- [ ] Ajustar ISO y Exposición basándose exclusivamente en el **Rango Dinámico del Pulso (AC/DC)** para maximizar la visibilidad de la muesca dicrótica antes de cualquier filtro.

### Fase 3: El "Músculo" - Red Neuronal de Limpieza (Denoiser)
Implementaremos un modelo de Deep Learning (LiteRT/TFLite) especializado en señales fisiológicas:
- [ ] **Modelo:** Autoencoder de Eliminación de Ruido (DAE) o Tiny-PPG.
- [ ] **Tarea:** Aprender la morfología humana (Pico Sistólico + Muesca Dicrótica) para reconstruir la señal en entornos de movimiento extremo.
- [ ] **Efectividad:** Elimina artefactos de movimiento (MA) sin borrar los componentes de alta frecuencia de la sangre.

### Fase 4: El "Cerebro" - Supervisor LLM (Llama 3.2 1B)
Integración de un modelo de lenguaje con poder de razonamiento para actuar como auditor clínico:
- [ ] **Rol:** No calcula el BPM, sino que **razona** sobre la calidad.
- [ ] **Instrucción (Prompting):** Se le enseña fisiología cardíaca. Evaluará: "El ritmo es regular pero la amplitud sistólica cae un 40% súbitamente; es un artefacto de presión del dedo, no un evento fisiológico real. Detener estabilización".
- [ ] **Manejo:** Transformers.js con WebGPU para ejecución local y gratuita.

### Fase 5: Estabilización Inteligente y Honesta
- [ ] Rediseñar `signalStabilization.ts` para que el progreso sea el veredicto final de la IA y el Denoiser.
- [ ] Implementar "Retroceso por Incertidumbre": si el sistema duda de la veracidad, la barra de progreso retrocede físicamente.

---

## Plan de Verificación y Documentación
1.  **Informe Médico:** Documentar cómo se preservan los puntos de interés clínico (P1, P2, P3).
2.  **Pruebas de Ruido Real:** Mover el sensor y verificar que el sistema detiene la medición de forma honesta.
3.  **Auditoría de Código:** Documentar cada conexión entre el sensor, el Denoiser y el Cerebro IA.
