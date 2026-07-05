# BioBeat Cortex — Fase 0

BioBeat Cortex es la nueva capa de inteligencia hemodinámica continua de la app.

## Qué significa “cerebro observador”

No es simulación, no inventa valores y no reemplaza todavía las métricas existentes.

Significa que el Cortex corre dentro del pipeline, observa cada frame real de cámara, construye una hipótesis viva sobre la señal hemodinámica, aprende una memoria local del dispositivo/sesión y expone su estado en diagnósticos internos.

En fase 0 trabaja en modo sombra: mira y aprende, pero todavía no gobierna BPM, SpO2, presión, glucosa ni arritmias. Esta separación evita romper lo que ya funciona.

## Principio

La app no debe preguntar solo “dedo sí/no”. Debe estimar evidencia continua:

- evidencia de sangre pulsátil;
- recuperabilidad del pulso;
- confianza óptica;
- distorsión por presión;
- contaminación por movimiento;
- saturación óptica;
- canal dominante;
- onda latente reconstruible;
- probabilidad de pulso;
- confianza por métrica.

## Componentes previstos

1. Hemodynamic Cortex: inteligencia frame-by-frame.
2. Signal Foundation Brain: conocimiento previo de PPG/fisiología/datasets.
3. Session Learning Brain: aprendizaje local del teléfono, dedo y sesión.
4. Developer/Repair Agent: consola de depuración y protección contra regresiones.

## Regla de seguridad técnica

La fase 0 no cambia los valores publicados. Solo agrega observación, memoria y explicación interna para preparar el control progresivo por fases.
