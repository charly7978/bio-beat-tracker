# Checklist obligatorio para PRs de IA, señal y medición

Copiar esta plantilla en todo PR que modifique inferencia, agentes, DSP, publicación o memoria fisiológica.

## 1. Clasificación real

Marcar una sola categoría principal y todas las auxiliares:

- [ ] Regla determinista.
- [ ] Algoritmo DSP.
- [ ] Estimador estadístico.
- [ ] Modelo neuronal con pesos reales.
- [ ] Modelo multimodal.
- [ ] Agente con modelo y herramientas.
- [ ] Sistema multiagente.
- [ ] Razonamiento causal con predicción/intervención.

### Evidencia de la clasificación

- Archivo o servicio que invoca el modelo:
- Modelo y versión:
- Runtime:
- ¿Existen pesos reales?:
- ¿Usa herramientas?:
- ¿Posee memoria?:
- ¿Puede abstenerse?:
- ¿Puede pedir otra observación?:

Si las respuestas anteriores son “no”, no usar `Agent`, `Reasoning`, `Cognitive`, `Understanding` o equivalentes en nombres públicos.

## 2. Datos de entrada

- [ ] Frames reales.
- [ ] Señales RGB reales.
- [ ] AC/DC real.
- [ ] IMU real.
- [ ] Metadatos de cámara.
- [ ] Memoria histórica claramente separada.
- [ ] No contiene datos simulados.

Indicar ventana, sampling, timestamps y procedencia.

## 3. Datos de salida

Para cada salida declarar:

- variable;
- unidad;
- productor;
- observación de origen;
- timestamp;
- expiración;
- incertidumbre;
- estado `live/historical/unknown`.

- [ ] Ausencia de señal produce ausencia explícita.
- [ ] No se usan valores normales por defecto.
- [ ] No se reutiliza `lastGoodValue` como dato vivo.
- [ ] No se crea una muestra nueva copiando una anterior.

## 4. Rol dentro del pipeline

- [ ] Hot path por frame.
- [ ] Ventana rápida local.
- [ ] Evento cognitivo.
- [ ] Revisión de sesión.
- [ ] Modo sombra.
- [ ] Control productivo.

Indicar frecuencia máxima, latencia y consumo esperado.

## 5. Herramientas y razonamiento

Para cada agente:

- rol;
- instrucciones versionadas;
- herramientas disponibles;
- hipótesis consideradas;
- evidencia referenciada;
- contradicciones;
- predicciones;
- condición de abstención;
- condición para solicitar intervención.

- [ ] La explicación no es texto prefabricado.
- [ ] La conclusión no estaba decidida antes de invocar el modelo.
- [ ] La salida JSON es validada.

## 6. Fallos

Probar:

- [ ] timeout;
- [ ] desconexión;
- [ ] respuesta inválida;
- [ ] schema incorrecto;
- [ ] modelo no disponible;
- [ ] herramienta falla;
- [ ] memoria corrupta;
- [ ] cancelación de sesión.

La cámara y el hot path no deben quedar bloqueados.

## 7. Pruebas adversarias de escena

- [ ] Retirada brusca de la fuente.
- [ ] Retirada lenta.
- [ ] Micromovimiento real.
- [ ] Movimiento periódico del teléfono.
- [ ] Presión excesiva.
- [ ] Fuga lateral de luz.
- [ ] Flash abierto.
- [ ] Objeto rojo.
- [ ] Tela/pared/mesa.
- [ ] Luz ambiental variable.
- [ ] Autoexposición.
- [ ] Ringing de filtros.
- [ ] FPS irregular.

Para cada prueba declarar qué variable dejó de ser observable y en cuánto tiempo.

## 8. Independencia de variables

- [ ] HR posee observabilidad propia.
- [ ] RR/ritmo posee observabilidad propia.
- [ ] Morfología posee observabilidad propia.
- [ ] SpO2 posee observabilidad propia.
- [ ] Presión posee observabilidad propia.
- [ ] Respiración declara modalidad de origen.

Ningún resultado se habilita automáticamente por HR o por contacto.

## 9. Memoria

- [ ] Memoria episódica separada del estado actual.
- [ ] Perfil personal separado del perfil del dispositivo.
- [ ] No se aprende de ventanas contradictorias.
- [ ] Existe borrado/reset.
- [ ] Existe versión y migración.
- [ ] Memoria no renueva vigencia de una medición.

## 10. Verificación de repositorio

- [ ] Se inspeccionó `main` actual.
- [ ] Se revisaron intentos anteriores y reverts.
- [ ] No se duplicó un módulo existente.
- [ ] No quedan archivos huérfanos.
- [ ] Typecheck.
- [ ] Lint.
- [ ] Tests.
- [ ] Build.
- [ ] `check:no-sim`.
- [ ] `check:architecture`.
- [ ] `check:orphans`.

## 11. Declaración final del PR

Completar literalmente:

```text
Este PR incorpora: ________________________________.
No incorpora todavía: ____________________________.
Puede publicar: __________________________________.
Debe abstenerse cuando: __________________________.
La principal incertidumbre restante es: __________.
La ruta de rollback es: ___________________________.
```

Un PR incompleto en esta declaración permanece en borrador.