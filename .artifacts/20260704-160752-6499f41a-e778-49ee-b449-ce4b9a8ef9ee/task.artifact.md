# Gestión de Tareas - Sistema de Precisión Clínica con Cerebro IA

## Fase 1: Investigación Médica y Eliminación de Simulaciones
- [x] Estudiar morfología clínica PPG (Pico sistólico, muesca dicrótica)
- [x] Auditoría de archivos para eliminar temporizadores fijos (Index.tsx, VitalSignsProcessor.ts)
- [x] Eliminar lógica de calibración basada en conteo de frames ciegos

## Fase 2: Fase Cero (Hardware)
- [x] Implementar Bucle PID de optimización de SNR en CameraView
- [ ] Sincronizar ajuste de exposición con la fase sistólica detectada

## Fase 3: IA de Limpieza (El Músculo)
- [/] Implementar Denoiser Neuronal (DAE/MLP) para preservación de muesca dicrótica
- [ ] Entrenar/Configurar pesos del modelo con patrones de PulseDB

## Fase 4: Cerebro IA (El Juez)
- [x] Integrar Llama 3.2 1B (Transformers.js + WebGPU)
- [ ] Diseñar Prompt de "Razonamiento Médico" para auditoría de señal
- [ ] Implementar bucle de decisión IA (Veredicto de Veracidad)

## Fase 5: Estabilización Final
- [ ] Overhaul de la lógica de convergencia en signalStabilization.ts
- [ ] Implementar progreso no monótono (retroceso por ruido)
- [ ] Verificación final con señales de estrés real
