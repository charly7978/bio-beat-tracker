# PPG/APG ONNX Model Training

Scripts para entrenar los 3 modelos ONNX que usa el motor de señales vitales.

## Requisitos

```bash
pip install -r requirements.txt
```

## Modelos

| Script | Archivo ONNX | Entrada | Salida |
|--------|-------------|---------|--------|
| `train_peak_scorer.py` | `peak_scorer_v1.onnx` | signal[1,256] + features[4] | score[1], confidence[1] |
| `train_sqi_refiner.py` | `sqi_refiner_v1.onnx` | signal_embed[1,128] + metadata[4] | refined_sqi[1], reliability[1] |
| `train_denoiser.py` | `denoiser_v1.onnx` | noisy_signal[1,512] | denoised_signal[1,512] |

## Uso

```bash
python train_peak_scorer.py
python train_sqi_refiner.py
python train_denoiser.py
```

Los `.onnx` se exportan a `public/models/`. El runtime los carga desde `/models/`.

## Arquitecturas

- **Peak Scorer**: CNN 1D (3 capas conv) + MLP. Clasifica ventanas de señal como pico válido o no.
- **SQI Refiner**: CNN 1D ligero + MLP. Refina el SQI heurístico combinando embedding de señal + metadata.
- **Denoiser**: Autoencoder 1D convolucional (3 encode / 3 decode). Limpia ruido de movimiento y eléctrico.

## Activación en runtime

En `src/config/features.ts`:

```ts
export const FEATURES = { useNN: false };  // → true para activar
```

Cuando `useNN = false` (default), los módulos ONNX retornan `null` y el pipeline cae al código heurístico existente.
