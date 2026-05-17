/**
 * Fuente única de restricciones de captura para PPG por cámara trasera + flash.
 * `CameraView` y pruebas deben importar desde aquí (no duplicar literales).
 */
export const PPG_CAMERA_GET_USER_MEDIA: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 640, max: 960 },
    height: { ideal: 480, max: 720 },
    frameRate: { ideal: 30, min: 15, max: 30 },
  },
};

/** FPS ideal pedido al track tras estabilización (clamp en runtime según capabilities). */
export const PPG_CAMERA_TARGET_FPS = 30;

/** Espera breve antes del segundo intento de torch (confirmación en `getSettings`). */
export const PPG_TORCH_RETRY_DELAY_MS = 400;
