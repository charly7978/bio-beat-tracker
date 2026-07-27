# Dependency Audit — Anti-Simulation

**Última revisión:** 2026-07-27
**Alcance:** todas las dependencias de runtime y dev en `package.json`.
**Pregunta:** ¿Alguna librería puede inyectar señales sintéticas, valores
aleatorios "plausibles" o datos por defecto en el pipeline PPG?
**Resultado:** ✅ Ninguna dependencia genera señales sintéticas en el pipeline médico.

> Revisión de julio 2026: el inventario anterior auditaba paquetes que **no
> están instalados** (`next-themes`, `@tanstack/react-query`) y omitía todo el
> bloque de Capacitor, que sí es runtime. La tabla de abajo se regeneró desde
> el `package.json` real.

## Metodología

1. Inventario desde `package.json` (no de memoria).
2. Clasificación por categoría y verificación de si toca la ruta
   cámara → PPG → vitales.
3. Barrido de `src/` en busca de `Math.random`, `mock`, `fake`, `dummy`,
   `synthetic`, `simulate` — automatizado en `scripts/check-no-simulation.mjs`.

## Runtime (`dependencies`)

| Paquete | Categoría | Toca pipeline PPG | Riesgo |
|---|---|---|---|
| `react`, `react-dom` | UI runtime | No | ✅ Ninguno |
| `react-router-dom` | Routing | No | ✅ Ninguno |
| `@radix-ui/react-slot`, `@radix-ui/react-toast` | Primitivos UI | No | ✅ Ninguno |
| `lucide-react` | Iconos SVG | No | ✅ Ninguno |
| `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss-animate` | Styling | No | ✅ Ninguno |
| `sonner` | Toasts | No | ✅ Ninguno |
| `zustand` | Estado UI | No | ✅ Ninguno |
| `@supabase/supabase-js` | Cliente backend | Sólo persistencia post-medición | ✅ Ninguno — no fabrica vitales |
| `@capacitor/core`, `@capacitor/android`, `@capacitor/app` | Shell nativo | No | ✅ Ninguno |
| `@capacitor/camera` | Permisos de cámara | **Sí (adquisición)** | ✅ Entrega frames reales del sensor; no sintetiza |
| `@capacitor/filesystem`, `@capacitor/preferences`, `@capacitor/network`, `@capacitor/status-bar`, `@capacitor/haptics` | APIs de plataforma | No | ✅ Ninguno |
| `@capgo/capacitor-health` | Export a Health Connect | Sólo escritura post-medición | ✅ Ninguno — no lee vitales de vuelta al pipeline |

## Build / dev (`devDependencies`)

| Paquete | Categoría | Riesgo |
|---|---|---|
| `vite`, `@vitejs/plugin-react-swc`, `lovable-tagger`, `@capacitor/cli` | Build tooling | ✅ Ninguno |
| `typescript`, `@types/*`, `eslint*`, `globals`, `typescript-eslint` | Tipado / lint | ✅ Ninguno |
| `tailwindcss`, `postcss`, `autoprefixer` | CSS | ✅ Ninguno |
| `vitest`, `@vitest/ui`, `jsdom` | Testing | ✅ Ninguno (excluido del guardrail) |

## Lo que **NO** está instalado (intencional)

- ❌ Generadores de datos: `faker`, `@faker-js/faker`, `chance`, `casual`.
- ❌ Mocks de red/datos: `msw`, `nock`, `sinon`.
- ❌ Síntesis de señal/audio: `tone`, `osc-js`, `wavefile`.
- ❌ PRNG con semilla: `seedrandom`.
- ❌ Runtimes de inferencia: `onnxruntime-web`, `@tensorflow/tfjs`. El
  directorio `training/` que los presuponía se eliminó en julio 2026 (era
  huérfano y entrenaba sobre PPG sintético).

Si alguno hace falta para tests, va en `devDependencies` y nunca se importa
desde `src/modules/**` ni desde `src/hooks/use{Signal,VitalSigns,HeartBeat}*`.

## Garantías automatizadas

1. `scripts/check-no-simulation.mjs` — escanea `src/` (sin tests) y falla ante
   los patrones prohibidos. Excepciones sólo con marcador
   `// anti-sim-allow: reason="..." ref="..."` o entrada en
   `scripts/anti-sim-allowlist.json` (ambos exigen `reason` y `ref`).
2. `scripts/check-no-simulation-dist.mjs` — repite el barrido sobre el bundle
   construido, por si entra vía dependencia transitiva.
3. CI (`.github/workflows/ci.yml`) ejecuta `npm run check:all` en cada push/PR.

## Procedimiento para agregar una dependencia

1. Justificarla en el PR.
2. Confirmar que no toca `src/modules/signal-processing/**`,
   `src/modules/vital-signs/**` ni `src/components/CameraView.tsx`.
3. Actualizar la tabla de arriba.
4. Verificar que `npm run check:all` pasa.
