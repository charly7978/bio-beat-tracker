# PPG / rPPG State of the Art Research

> **Proyecto creado por Carlos Ameghino** — investigación aplicada al desarrollo de un monitor de signos vitales por cámara de smartphone. Este documento recopila y clasifica el estado del arte para guiar las decisiones de implementación.

## 1. PPG Beat Detection Algorithms

### Benchmark: Charlton et al. 2022
- **Paper**: "Detecting beats in the photoplethysmogram: benchmarking open-source algorithms" (Physiol. Meas. 43 085001)
- **URL**: https://iopscience.iop.org/article/10.1088/1361-6579/ac826d
- **Finding**: Tested 15 PPG beat detectors across 8 datasets
- **Top performers**: MSPTD (Multi-Scale Peak & Trough Detection) and qppgfast
- **F1 scores**: >=90% on hospital data, 55-91% during exercise, 84-96% in neonates, 92-97% in AF
- **Elgendi**: Was benchmarked but NOT top-performing. MSPTD and qppgfast significantly better.

### MSPTDfast v.2 (2025)
- **Paper**: "The MSPTDfast photoplethysmography beat detection algorithm" (Physiol. Meas. 46 035002)
- **URL**: https://iopscience.iop.org/article/10.1088/1361-6579/adb89e
- **Key improvement**: Optimized MSPTD for efficiency (2.5x faster) with identical accuracy
- **Open source**: Yes
- **Relevance**: Best candidate to replace our Elgendi detector

### pyPPG (2024)
- **Paper**: "pyPPG: a Python toolbox for comprehensive photoplethysmography signal analysis"
- **Authors**: Marton Aron Goda, Peter H Charlton, Joachim A Behar
- **F1 score**: 88.19% on 2,054 recordings (91M+ reference beats)
- **Features**: 74 PPG digital biomarkers, fiducial point detection (MAE < 10ms)
- **URL**: https://physiozoo.com/pyppg

### Dilated CNN for PPG Peak Detection (2022)
- **Paper**: "Robust PPG Peak Detection Using Dilated Convolutional Neural Networks" (Sensors 22(16):6054)
- **URL**: https://pmc.ncbi.nlm.nih.gov/articles/PMC9414657/
- **F1**: 81% across all SNR ranges (0-45 dB), outperforms adaptive threshold and Hilbert methods
- **Model**: 7-layer 1D CNN with dilated convolutions, only 3,169 parameters
- **Noise resilience**: Specifically designed for noisy wearable PPG
- **Open source**: https://github.com/HealthSciTech/Robust_PPG_PD

### SMoLK (2024)
- **Paper**: "Sparse learned kernels for interpretable and efficient medical time series processing"
- **URL**: https://pmc.ncbi.nlm.nih.gov/articles/PMC12347547/
- **Use case**: PPG artifact segmentation + signal quality assessment
- **Key advantage**: State-of-the-art performance with orders of magnitude fewer parameters than DNN
- **Interpretable**: Produces direct signal quality measure via learned kernels

## 2. Remote Photoplethysmography (rPPG)

### rPPG-Toolbox (NeurIPS 2023)
- **URL**: https://github.com/ubicomplab/rPPG-Toolbox
- **Supervised algorithms**: DeepPhys, TS-CAN, EfficientPhys, PhysNet, PhysFormer, FactorizePhys, BigSmall
- **Unsupervised**: GREEN, ICA, CHROM, POS, LGI, PBV, OMIT
- **Benchmark result**: Deep learning methods significantly outperform unsupervised for accuracy
- **Best performing**: FactorizePhys, PhysFormer (Transformer-based), EfficientPhys

### CHROM (de Haan 2013)
- **Paper**: "Robust pulse rate from chrominance-based rPPG" (IEEE TBME)
- **Standard unsupervised method**: Chrominance-based blood volume pulse extraction
- **What we have**: Implemented in `src/modules/rppg/ChromRppg.ts` (deleted)

### POS (Wang 2016)
- **Paper**: "Algorithmic principles of remote PPG" (IEEE TBME)
- **Improvement over CHROM**: Better motion robustness via projection plane orthogonal to skin
- **What we had**: Implemented in `src/modules/rppg/PosRppg.ts` (deleted)

### FaceHeart (FDA-cleared)
- **URL**: https://faceheart.com/technology.php
- **Status**: FDA 510(k) clearance for HR and RR via camera
- **Method**: Multi-context deep learning (CNN) integrating rPPG + motion + luminance

## 3. Signal Quality Assessment

### Approaches:
1. **Statistical**: Skewness, kurtosis, entropy, SNR
2. **Morphological**: Peak sharpness, perfusion index, pulse area
3. **Template matching**: Cross-correlation with clean PPG template
4. **ML-based**: CNNs, SVMs on handcrafted features
5. **Kernel-based**: SMoLK (learned sparse kernels for direct quality scoring)

### Our current approach:
- Uses perfusion index, motion score, saturation ratio, coverage ratio
- SQI = composite of multiple metrics
- Matches general practice but could be refined with SMoLK approach

## 4. Motion Artifact Removal

### Techniques:
1. **Adaptive filtering**: Requires accelerometer reference (not available in camera PPG)
2. **Wavelet decomposition**: DWT/stationary wavelet + thresholding
3. **Variational mode decomposition**: Signal decomposition + reconstruction
4. **Deep learning**: Autoencoders (our Denoiser module), CNNs
5. **Hilbert transform envelope**: Double envelope method for peak detection
6. **Bandpass filtering**: Standard 0.5-5 Hz (our current approach)

### Our current approach:
- Bandpass filter (IIR, 0.5-8 Hz)
- ONNX Denoiser (autoencoder scaffold, not active)
- Motion artifact detection via frame-to-frame variance
- Could improve with wavelet-based denoising or adaptive filtering

## 5. Camera Pipeline Best Practices

### Standard Web Camera → PPG Pipeline:
1. **getUserMedia** → MediaStream → video element (IN DOM)
2. **RAF loop**: drawImage(video, canvas) → getImageData(canvas)
3. **ROI extraction**: Center region or finger detection mask
4. **Channel selection**: Green channel typically best for PPG (highest AC/DC ratio)
5. **Preprocessing**: Bandpass filter 0.5-5 Hz
6. **Peak detection**: Adaptive threshold, MSPTD, or DL-based
7. **BPM calculation**: Peak-to-peak interval → median over sliding window

### Key insights:
- Video element MUST be in DOM (especially iOS/Chrome mobile)
- `playsInline` + `muted` + `autoplay` required
- Green light absorption is highest for pulsatile blood → best PPG SNR
- 15-30 FPS sufficient for HR (Nyquist: 4 Hz for 120 BPM max)
- Resolution 320x240 sufficient for finger PPG
- Flash/LED improves SNR significantly in contact PPG

## 6. Evaluation of Our Current Implementation

### What we have (after cleanup):
```
CameraView (back camera + flash)
  → useFrameLoop (RAF: video → canvas → ImageData)
  → processFrame (ROI extraction → filter → SQI)
  → HeartBeatProcessor (Elgendi peak detector → BPM)
  → VitalSignsProcessor (SpO2, HRV, BP, arrhythmia)
```

### What's optimal:

| Component | Our approach | SOTA approach | Priority |
|---|---|---|---|
| **Peak detection** | Elgendi (adaptive threshold) | MSPTDfast or qppgfast | HIGH |
| **Bandpass filter** | 0.5-8 Hz Butterworth | Good, but narrow to 0.5-5 Hz | LOW |
| **ROI channel** | Red-only (finger PPG) | Green channel has better SNR | MEDIUM |
| **Signal quality** | Composite (PI, motion, coverage, saturation) | SMoLK kernels or ML-based | MEDIUM |
| **Motion removal** | Bandpass only | Wavelet + adaptive filtering | MEDIUM |
| **Denoising** | ONNX autoencoder scaffold | Not yet trained | LOW |
| **Frame capture** | RAF + drawImage + getImageData | Standard, no improvement needed | - |
| **Camera control** | getUserMedia + torch + stabilization | Good, matches best practice | - |

### Critical gaps:
1. **MSPTDfast** beats Elgendi significantly in noise resilience (F1 95%+ vs unknown)
2. **Green channel** not used for PPG (better AC/DC ratio than red)
3. **No camera frame actually verified** on target device
4. **Motion artifact handling** is minimal (only bandpass + frame variance detection)

### Recommended changes (in priority order):
1. ✅ Remove Web Worker, rPPG, dual camera (DONE)
2. **Verify camera pipeline works** on real device (debug: does getUserMedia resolve?)
3. **Replace Elgendi with MSPTDfast** for peak detection
4. **Add green channel ROI** option (better PPG signal)
5. **Improve motion artifact handling** with wavelet-based approach
6. **Train and activate ONNX Denoiser** from training scripts
7. **Reintroduce rPPG** only after core pipeline is verified (using CHROM/POS from rPPG-Toolbox)

## 7. Key Papers and Repositories

### Papers (to download and save):
- Charlton et al. 2022 - PPG beat detection benchmark
- MSPTDfast 2025 - optimized beat detection
- pyPPG 2024 - comprehensive PPG analysis toolbox  
- Dilated CNN PPG 2022 - robust peak detection
- SMoLK 2024 - interpretable PPG quality assessment
- rPPG-Toolbox 2023 (NeurIPS) - comprehensive rPPG benchmark
- CHROM 2013 - chrominance-based rPPG
- POS 2016 - algorithm principles of rPPG

### Repositories (to study):
- https://github.com/ubicomplab/rPPG-Toolbox - SOTA rPPG
- https://github.com/HealthSciTech/Robust_PPG_PD - CNN peak detection
- https://physiozoo.com/pyPPG - PPG analysis toolbox
- https://peterhcharlton.github.io/ - PPG resources by Charlton
