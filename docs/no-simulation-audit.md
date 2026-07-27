# Auditoría Anti-Simulación — Pipeline PPG

**Última revisión:** 2026-07-27
**Alcance:** cámara → procesamiento → BPM → SpO₂ → Presión Arterial → Arritmias → UI
**Resultado:** ✅ Limpio **tras corregir tres focos de fabricación** encontrados
en julio 2026 (ver más abajo). La revisión anterior los daba por inexistentes.

## Hallazgos de julio 2026 — corregidos

La auditoría de mayo declaraba el pipeline limpio, pero su barrido de valores
clínicos era demasiado estrecho: buscaba `120/80` literal y
`return.*spo2.*9[0-9]`, patrones que **no capturan el operador de fallback**
`?? 120`. Con `rg "\?\? *(72|98|120|80|60)"` aparecieron tres:

| Ubicación | Fabricación | Corrección |
|---|---|---|
| `src/lib/ml/riskAnalyzer.ts` | `hr ?? 72`, `spo2 ?? 98`, `systolic ?? 120`, `diastolic ?? 80` alimentaban un veredicto clínico (`IMMEDIATE`…`NORMAL`) pintado como badge. Con sólo HR medido, la app concluía "sin hipertensión / sin hipoxia" sobre un 120/80 inventado. | Módulo y badge **eliminados**. |
| `src/pages/Index.tsx` (`handleCalibrate`) | Escribía `?? 120`, `?? 80` y `: 98` en el estado con `status: 'VALID'`. | Sólo reaplica offsets sobre vitales realmente medidos. |
| `src/modules/vital-signs/BloodPressureProcessor.ts` | `externalHr ?? 60` asumía 60 bpm de reposo. | Deriva la frecuencia de la mediana de los RR reales. |

**Lección:** el guardrail automatizado cubre keywords (`mock`, `fake`,
`synthetic`…) pero no detecta constantes fisiológicas plausibles usadas como
fallback. Ese patrón hay que buscarlo a mano: `?? <número>`, `|| <número>` y
`: <número>` sobre vitales.

## Búsquedas ejecutadas

| Patrón | Comando | Resultado |
|---|---|---|
| `Math.random` | `rg "Math\.random" src/` | **0 coincidencias** |
| `simulate / mock / fake / dummy / stub` | `rg -i "simulat\|mock\|fake\|dummy\|stub" src/` | **0** en producción (automatizado en `check:no-sim`) |
| Generadores sintéticos | `rg -i "synthet\|generate.*signal\|seed" src/` | **0 coincidencias**. El generador de PPG sintético que existía en `training/` se eliminó con el directorio. |
| `Math.sin / Math.cos` en pipeline | `rg "Math\.(sin\|cos)" src/` | Coeficientes Butterworth IIR y proyección 3D del canvas — **matemática legítima** |
| Fallbacks fisiológicos | `rg "\?\? *(72\|98\|120\|80\|60)" src/` | **0 coincidencias** tras las correcciones de arriba |

## Garantías por capa

### 1. Captura de cámara (`CameraView.tsx`)
- Toda la señal proviene de píxeles reales del `MediaStream` con flash activo.
- `requestVideoFrameCallback` para captura sincronizada al sensor.
- Si la cámara o el torch fallan: degradación a estado de error explícito, **nunca** se inyecta señal sintética.

### 2. Detección de dedo (`PPGSignalProcessor.updateContactState`)
- Clasificación por píxel (luma + chroma + pureza roja + clipping). Sin contacto → `state="finger-missing"`, `filtered=0`, `quality=0`.
- Histéresis estricta: requiere firma real de hemoglobina (red dominance > 20, RG ratio > 1.2, coverage > 35%).

### 3. Extracción ROI (`PPGSignalProcessor.extractROI`)
- Promedios calculados sobre tiles válidos del frame. Si no hay tiles válidos → devuelve **ceros**, no defaults.

### 4. Filtrado y normalización (`BandpassFilter.ts`)
- Biquad Butterworth Direct Form I con `fs` real estimado del frame timing.
- Reset de estados internos a `0` en overflow numérico — no se inyecta valor "plausible".

### 5. BPM y picos (`HeartBeatProcessor.ts`)
- Solo emite BPM cuando hay picos reales detectados sobre la señal filtrada.
- Sin contacto / mala calidad → `bpm=0` y se renderiza `--` en UI.
- **Sin extrapolación** ni suavizado de "BPM previo" cuando se pierde la señal (regla `Medical Philosophy` del proyecto).

### 6. SpO₂ (`VitalSignsProcessor` / SpO2 head)
- Calculado vía ratio R/G real (AC/DC). Si SQI insuficiente → `spo2=0` → UI muestra `--`.
- Sin floor `90%`, sin clamping fisiológico forzado.

### 7. Presión arterial (`BloodPressureProcessor.ts`)
- Observador hemodinámico EKF (Moens-Korteweg + Windkessel) sobre la señal PPG
  real; sin pesos entrenados.
- Si el observador no converge → `{systolic:0, diastolic:0, confidence:'INSUFFICIENT'}` → UI muestra `--/--`.
- Sin base fija 120/80.
- La frecuencia que alimenta al observador sale del BPM del detector o, si no
  hay, de la **mediana de los RR reales** ya validados. No se asume 60 bpm de
  reposo (corregido en julio 2026).
- **Sí existe calibración manual** por referencia de tensiómetro
  (`CalibrationManager`, perfiles `BP` / `SPO2` con caducidad de 30 días). Guarda
  un *offset* contra una lectura real del usuario; no sintetiza valores. Una
  afirmación previa de este documento decía que se había eliminado — era falsa.

### 8. Arritmias (`arrhythmia-processor.ts`)
- Detectadas exclusivamente desde RR-intervals reales obtenidos de los picos del HeartBeatProcessor.
- Estado inicial: `"SIN ARRITMIAS|0"`. No se incrementa el contador sin evento RR genuino.

### 9. Capa de UI (`Index.tsx`, `PPGSignalMeter.tsx`)
- Todos los componentes muestran `--` cuando el valor es `0` o `null` proveniente del pipeline.
- Redondeo a entero **solo en presentación** (`Math.round(heartRate)`); precisión float preservada en cálculos internos.
- Suavizado EMA aplicado solo para estabilidad visual, nunca para enmascarar pérdida de señal.

### 10. Edge function de IA (`supabase/functions/analyze-vitals`)
- Recibe únicamente los valores ya validados del pipeline; si llegan en `0` los reporta como tal en el prompt al modelo.

## Excepciones legítimas

| Ubicación | Uso de constante numérica | Justificación |
|---|---|---|
| `BandpassFilter.computeCoefficients` | `Math.sin`, `Math.cos`, `Math.tan` | Diseño analítico de coeficientes Butterworth IIR (transformación bilineal). |
| `PPGSignalProcessor` — pesos de fuentes | constantes `0.45 / 0.40 / 0.15`… | Parámetros heurísticos del modelo de selección competitiva, no datos. |

## Conclusión

Tras las correcciones de julio 2026 el pipeline cumple la regla
**`Medical Philosophy`** del proyecto: *"Prioritize 'no reading' over false
reading"*. Todas las métricas se derivan de píxeles reales capturados con
flash; cuando la señal es insuficiente la app muestra `--` y conserva
`confidence='INSUFFICIENT'` en lugar de inventar valores.

Conviene no leer este documento como un certificado permanente. La revisión
anterior afirmaba lo mismo mientras `riskAnalyzer.ts` emitía un veredicto
clínico sobre un 120/80 inventado. Lo que sostiene la garantía es
`npm run check:all` en CI más una relectura periódica de los fallbacks; no la
existencia de este archivo.
