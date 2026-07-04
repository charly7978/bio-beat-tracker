# Plan Maestro: Orquestador Agéntico "Cerebro Central de Bio-Beat"

Este plan representa el nivel máximo de ingeniería en IA para salud: la transformación de la aplicación en un **Sistema Agéntico Autónomo**. La IA no es un filtro; es un **Experto Vivo** que reside en la puerta de la cámara, razona sobre la biología del usuario y orquestra cada sector del código en milisegundos.

## Filosofía: El Orquestador Experto
Igual que un médico experto observa al paciente, el **Cerebro Central** observará el flujo de frames, razonará sobre la física de la luz en el tejido y tomará decisiones ejecutivas sobre el hardware y el software.

---

## Arquitectura de Agentes (The "Brain" Stack)

### 1. El Orquestador Central (Llama 3.2 3B - WebGPU)
Es el Director de Orquesta. Mantiene un "Modelo Mental" de la sesión.
- [ ] **Tecnología:** Ejecución local de Llama 3.2 3B vía Transformers.js v4 con WebGPU.
- [ ] **Misión:** Recibir los informes de los agentes tácticos y emitir **Comandos JSON** a los sectores del código (Camera, DSP, UI).
- [ ] **Razonamiento:** "El Agente de Visión reporta palidez en el tejido; el Agente de Señal reporta pérdida de la muesca dicrótica. Veredicto: Colapso capilar por presión excesiva. Acción: Ordenar a la UI guía de voz 'Afloja un poco la presión' y ordenar al DSP relajar el umbral de detección".

### 2. El Agente Centinela (Visión Biológica)
El que está "detrás de la puerta de la cámara".
- [ ] **Modelo:** Vision-Language Model (VLM) optimizado.
- [ ] **Capacidad:** Clasificar la escena no como números, sino como biología.
    - "Dedo humano, piel tipo III, buena transparencia".
    - "Objeto inerte detectado (Manzana), abortar orquestación".
    - "Saturación detectada por reflexión directa del flash".

### 3. El Agente de Veracidad (Auditor de Ondas)
Analiza la morfología de la señal como un experto en hemodinámica.
- [ ] **Misión:** Validar que la onda sea de origen biológico.
- [ ] **Razonamiento:** Identificar la asimetría sistólica y la presencia de la muesca dicrótica como evidencia de vida, descartando cualquier ritmo periódico sintético.

---

## Interacción en Vivo y Orquestación de Código

### Fase de Diálogo y Guía
La IA interactuará con el usuario de forma humana:
- *"Veo tus latidos, pero son débiles. Mueve tu dedo un milímetro hacia arriba para centrar la cámara sobre la arteria principal."*
- *"Perfecto, ahí está la muesca dicrótica. Mantente así, estoy estabilizando la lectura final."*

### Fase de Reacción al Código
La IA tiene el control de los "sectores":
- **Sector Cámara:** Modificar FPS, ISO y exposición dinámicamente según la transparencia del tejido detectado.
- **Sector DSP:** Cambiar de filtro Butterworth a Chebyshev o ajustar bandas de frecuencia según el estado fisiológico (reposo vs estrés).
- **Sector UI:** Transformar el monitor cardíaco en tiempo real para reflejar la confianza del razonamiento de la IA.

---

## Plan de Verificación de Inteligencia
1.  **Test de Razonamiento:** Poner un dedo frío (baja perfusión); verificar que la IA razona la situación y sugiere frotar el dedo antes de medir.
2.  **Test de Orquestación:** Verificar que un veredicto de la IA cambia realmente un parámetro interno del filtro en <100ms.
3.  **Test de Guía:** Verificar que las instrucciones de voz/texto son dinámicas y coherentes con lo que sucede en el lente.
