# Modelo de mundo fisiológico y óptico

## Propósito

Define el conocimiento causal mínimo que los agentes deben usar. No es una lista de umbrales: conecta corazón, sangre, tejido, luz, cámara y señal.

## 1. Cadena causal principal

```text
actividad eléctrica cardíaca
→ contracción miocárdica
→ eyección ventricular
→ onda de presión y flujo arterial
→ propagación vascular
→ respuesta periférica y microcirculación
→ cambio pulsátil del volumen sanguíneo local
→ modulación de absorción y dispersión óptica
→ variación temporal RGB
→ señal PPG derivada
```

La cámara no observa directamente el corazón. Observa una consecuencia periférica transformada por capas físicas y biológicas.

## 2. Qué es la sangre para el sistema

Debe representar:

- eritrocitos;
- hemoglobina;
- oxihemoglobina y desoxihemoglobina;
- plasma;
- volumen sanguíneo arterial y microvascular;
- flujo y perfusión;
- interacción dependiente de longitud de onda.

No debe representar “sangre” como `red > green`.

La evidencia es indirecta y depende de flash, sensor, piel, tejido, geometría, presión, exposición y procesamiento de cámara.

## 3. Qué es el pulso PPG

El PPG no es idéntico al latido cardíaco ni al ECG. Deben distinguirse:

- evento eléctrico;
- contracción y eyección;
- onda de presión;
- cambio de volumen vascular periférico;
- observación óptica.

Una periodicidad compatible no prueba la cadena completa.

## 4. Variables latentes

```ts
interface PhysiologicalWorldState {
  cardiacCycleContinuity: number;
  peripheralPerfusion: number;
  vascularTone: number;
  tissueCompression: number;
  opticalCoupling: number;
  bloodVolumePulseVisibility: number;
  motionContamination: number;
  illuminationStability: number;
  cameraProcessingInfluence: number;
  filterMemoryInfluence: number;
}
```

Son conceptos para explicar observaciones y formular predicciones; no son automáticamente valores clínicos.

## 5. Modelo óptico

```text
luz del flash
− absorción por tejido y cromóforos
− pérdidas geométricas
+ dispersión y reflexión
+ respuesta espectral del sensor
+ exposición/ganancia/procesamiento
+ ruido
```

El DC representa principalmente base óptica y tisular. El AC puede contener pulsatilidad, pero también movimiento, exposición y ruido.

## 6. Presión y colocación

La presión puede mejorar acoplamiento y reducir fuga de luz, pero también comprimir vasos, reducir AC y cambiar DC y canales.

Hipótesis útil:

```text
DC alto + cobertura alta + AC decreciente + movimiento bajo
→ posible compresión vascular, no ausencia de tejido.
```

## 7. Movimiento

Puede alterar ROI, luz recibida, presión, exposición, mezcla espacial, línea base, fase y picos. Un agente debe estimar qué parte explica el movimiento y qué queda después de compensarlo.

## 8. Cámara y exposición

Los teléfonos pueden modificar exposición, ganancia, balance de blancos, enfoque, reducción de ruido, tone mapping y compresión. Una oscilación global puede ser una respuesta de cámara y debe contrastarse con metadatos y cambios espaciales.

## 9. Ringing y memoria

Filtros, buffers y suavizados pueden producir energía después de desaparecer la fuente. La señal filtrada no es observación independiente y debe conservar procedencia de la muestra cruda.

```text
sin evidencia óptica actual + energía filtrada residual
→ la energía debe decaer;
→ no deben aparecer nuevos latidos vigentes.
```

## 10. Hipótesis rivales mínimas

1. tejido perfundido con señal observable;
2. tejido perfundido con mala observabilidad;
3. compresión vascular;
4. movimiento dominante;
5. fuga de luz o contacto parcial;
6. autoexposición o iluminación externa;
7. escena inerte;
8. ringing o retención;
9. mezcla de causas;
10. explicación desconocida.

## 11. Predicciones contrafactuales

### Perfusión real
Continuidad temporal, AC pequeña sobre DC, estructura multicanal y respuesta plausible a presión.

### Movimiento
Desplazamiento espacial, componente común y correlación con flujo óptico o IMU.

### Compresión excesiva
Caída de AC con tejido todavía presente y posible recuperación al reducir presión.

### Autoexposición
Cambios globales relacionados con brillo y metadatos, no con morfología vascular estable.

### Ringing
Decaimiento sin renovación de evidencia cruda.

Los agentes deben comparar predicción y observación posterior.

## 12. Intervenciones

Cuando la evidencia sea ambigua, la app puede pedir una intervención pequeña:

- reducir presión;
- mantener inmóvil una ventana corta;
- recolocar sin retirar completamente;
- cubrir fuga lateral;
- repetir con exposición bloqueada si el dispositivo lo permite.

La intervención funciona como prueba causal, no solo como UX.

## 13. Observabilidad por variable

- **HR:** necesita temporalidad y pulsos distinguibles.
- **Ritmo/RR:** necesita timestamps confiables y picos no fabricados.
- **Morfología:** necesita sampling, forma preservada y baja distorsión.
- **SpO2:** necesita información multicanal estable y modelo óptico; no se hereda de HR.
- **Presión:** necesita evidencia hemodinámica y personalización específica.
- **Respiración:** puede usar varias modalidades, declarando cuál produjo el valor.

## 14. Preguntas obligatorias para un agente

- ¿Qué fenómeno fisiológico supone?
- ¿Cómo produciría esta observación?
- ¿Qué evidencia lo apoya y contradice?
- ¿Qué hipótesis rival compite?
- ¿Qué debería ocurrir después?
- ¿Qué observación o intervención resolvería la duda?
- ¿Qué variable es observable y cuál no?