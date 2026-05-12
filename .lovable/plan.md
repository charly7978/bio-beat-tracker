Do I know what the issue is? Sí: el freeze no viene de un error visible de consola, sino de una regresión de arquitectura en el hot path.

Problema exacto detectado:
- `useSignalProcessor` hace `setLastSignal(signal)` por cada frame de cámara.
- `Index.tsx` reacciona a `lastSignal` con muchos `setState` por frame: onda, BPM, RR, vitales, sanity, arrhythmia, etc.
- `PPGSignalMeter.tsx` además corre su propio `requestAnimationFrame` y contiene código de debug residual que hace `fetch('http://127.0.0.1:7732/ingest/...')` durante la medición.
- `PPGSignalProcessor.ts` y `HeartBeatProcessor.ts` todavía usan `push/shift/slice/sort` en rutas frecuentes, lo que mete GC/jank progresivo en móvil.
- `Index.tsx` registra `requestVideoFrameCallback`, pero no conserva el id para `cancelVideoFrameCallback`, no pasa el timestamp real al procesador y usa `Date.now()` dentro del DSP.

Esto coincide con el síntoma: empieza bien, acumula presión en main thread/React/GC/red, y a los segundos la pantalla queda congelada.

Plan de corrección, sin cambios drásticos ni simulación:

1. Eliminar la causa inmediata del freeze
   - Quitar completamente el bloque `agent log` de `PPGSignalMeter.tsx` y todos los `fetch` a `127.0.0.1`.
   - Mantener el monitor visual, pero sin telemetría local residual en el loop de render.

2. Sacar React del hot path de cámara
   - Cambiar `useSignalProcessor` para que acepte un callback realtime (`setSignalCallback`) y no dependa de `setLastSignal` por frame.
   - Mantener `lastSignal` solo como snapshot UI throttleado, no como bus de procesamiento.
   - En `Index.tsx`, procesar `ProcessedSignal` en refs/callbacks y emitir a React solo cada 80–250 ms según tipo de dato.

3. Corregir el loop de cámara/timing
   - Mover el loop de captura a una ruta estable con `requestVideoFrameCallback` y conservar el id para cancelarlo correctamente.
   - Pasar `metadata.mediaTime` / `presentationTime` al pipeline; fallback con `performance.now()`, no `Date.now()`.
   - Mantener `getImageData` en canvas pequeño, pero evitar recreación y evitar dobles loops.

4. Reducir GC en DSP crítico
   - Reemplazar `push/shift` críticos en `HeartBeatProcessor` por ring buffers preasignados.
   - Reducir `slice/sort` por frame en `PPGSignalProcessor` y calcular percentiles/rangos con buffers reutilizables o menor frecuencia.
   - No tocar la filosofía médica: sin clamps fisiológicos cosméticos y sin simulación.

5. Integrar lo bueno que ya existía antes de la reversión
   - Usar como referencia los archivos `.orig` encontrados, porque contienen exactamente la arquitectura anti-freeze: `onFrame`, callback realtime, throttling de UI y heartbeat con ring buffers.
   - No hacer restore ciego: fusionar esa arquitectura con lo actual para conservar backpressure, sanity audit y ajustes existentes.

6. Limpieza de repositorio relacionada
   - Remover/archivar del árbol `src` los artefactos `.orig` y `.rej` si no son necesarios para build/higiene.
   - Verificar que no queden logs/debug/fetch residuales en hot path.

7. Validación final
   - Ejecutar pruebas selectivas del pipeline PPG/backpressure.
   - Perfilar en preview antes/después: heap, script duration, task duration, FPS, logs y ausencia de errores.
   - Confirmar que la medición sigue durante más de los segundos donde hoy se congela.

<lov-actions>
  <lov-open-history>View History</lov-open-history>
</lov-actions>

<lov-actions>
<lov-link url="https://docs.lovable.dev/tips-tricks/troubleshooting">Troubleshooting docs</lov-link>
</lov-actions>