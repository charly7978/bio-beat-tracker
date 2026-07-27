# Auditoría de Depuración del Repositorio

**Última revisión:** 2026-07-27
**Objetivo:** repositorio sin archivos huérfanos, código duplicado, valores
fabricados ni APIs obsoletas.

> Este documento se reescribió por completo en la limpieza de julio 2026. Las
> versiones anteriores describían un árbol (`Auth.tsx`, `VitalSign.tsx`,
> `arrhythmiaUtils`, "38 archivos") que ya no existía, lo que lo volvía una
> fuente de verdad falsa. Si vuelve a quedar desactualizado, corregirlo o
> borrarlo — un mapa equivocado es peor que ninguno.

## Limpieza de julio 2026

### Código eliminado

| Ruta | Motivo |
|---|---|
| `training/` (6 archivos) | Pipeline de entrenamiento ONNX totalmente huérfano: exportaba a `public/models/` (inexistente), se activaba desde `src/config/features.ts` (inexistente) y no hay runtime ONNX en `package.json`. Además construía sus datasets con PPG **sintético**, en contradicción directa con la política anti-simulación. |
| `src/modules/vital-signs/PPGFeatureExtractor.ts` | 530 líneas sin un solo importador. Quedó desconectado al migrar la PA al observador EKF (`HemodynamicObserver`). Lo detectaba `npm run check:orphans`, que estaba en rojo. |
| `src/modules/vital-signs/ValidationDataset.ts` | Sumidero de escritura: `addEntry` se llamaba en cada guardado pero `getDataset` / `exportJSON` no se llamaban nunca. Acumulaba un `VitalSignsResult` completo por medición en `localStorage`, sin poda y sin lector. |
| `src/lib/ml/riskAnalyzer.ts` | Ver "Valores fabricados" abajo. |
| `src/modules/vital-signs/DisplaySmoothing.ts` | Duplicaba el suavizado de `src/lib/measurement/displaySmoothing.ts` en otra capa. Ver "Suavizado duplicado". |

### Valores fabricados (lo más grave)

`riskAnalyzer.ts` calculaba un veredicto clínico (`IMMEDIATE` / `SOON` /
`MONITOR` / `NORMAL`) que se pintaba como badge en `Index.tsx`. Cuando un vital
faltaba, lo **inventaba** con constantes de libro:

```ts
const hr   = vitals.heartRate.value                ?? 72;
const spo2 = vitals.spo2.value                     ?? 98;
const sys  = vitals.bloodPressure.value?.systolic  ?? 120;
const dia  = vitals.bloodPressure.value?.diastolic ?? 80;
```

Como el badge se disparaba con sólo tener HR **o** SpO2, bastaba una medición
de pulso para que la app calculara "sin hipertensión" y "sin hipoxia" a partir
de un 120/80 y un 98 % que nadie había medido, y mostrara `NORMAL`. Eso es
exactamente la lectura falsa que la regla *Medical Philosophy* prohíbe.
Se eliminaron el módulo y el badge.

Otros dos focos de fabricación, corregidos en su sitio:

- `Index.tsx` (`handleCalibrate`): al recalibrar escribía
  `?? 120`, `?? 80` y `: 98` en el estado **con `status: 'VALID'`**. Ahora sólo
  reaplica los offsets sobre vitales realmente medidos; si no hay medición, no
  toca ese vital.
- `BloodPressureProcessor.estimate`: usaba `externalHr ?? 60`, asumiendo
  60 bpm de reposo cuando el detector no había publicado BPM. Ahora deriva la
  frecuencia de la **mediana de los intervalos RR reales**, que en ese punto ya
  están validados (`rrIntervals.length >= 2` es precondición).

### Suavizado duplicado

El mismo vital se suavizaba en tres capas encadenadas:

1. `VitalSignsProcessor` → clase `DisplaySmoothing` (EMA ponderado + *display hold* de 240 frames)
2. `useSignalRouter` → `smoothDisplayValue` / `smoothDisplayPair`
3. `PPGSignalMeter` → `lerpDisplayValue` (animación de canvas)

La capa 1 no correspondía al procesador: su *display hold* mantenía en pantalla
un SpO2/PA de hasta ~8 s de antigüedad como si fuera actual, que es una lectura
falsa con otro nombre. Se eliminó. Hoy:

- **`VitalSignsProcessor`** publica el valor clínico medido o `0`. Nunca retiene.
- **`useSignalRouter`** aplica el suavizado de presentación sobre el estado React.
- **`PPGSignalMeter`** interpola sólo para la animación del canvas.

Son tres responsabilidades distintas, no tres copias del mismo algoritmo.

### Toasts que no llegaban

`toast({...})` se invocaba en 15 puntos (errores de guardado, límites de la edge
function, avisos de señal) pero **nadie consumía `useToast()`**: no existía un
`Toaster` que mapeara el store a elementos de Radix, así que todas esas
notificaciones se descartaban en silencio. Se añadió
`src/components/ui/toaster.tsx` y se montó en `App.tsx` en lugar del
`ToastViewport` suelto.

## Verificación

```bash
npm run check:all
```

Encadena `lint → typecheck → check:orphans → check:architecture → check:no-sim
→ test → build → check:no-sim:dist`.

`check:orphans` estaba **en rojo** antes de esta limpieza (delataba
`PPGFeatureExtractor`). Ahora los cuatro guardrails pasan y la suite queda en
264 tests verdes.
