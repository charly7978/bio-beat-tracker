/**
 * PPG SIGNAL SPLITTER — Banco de filtros por canal vital.
 *
 * Divide la señal PPG cruda en 5 canales independientes, cada uno optimizado
 * para los requisitos específicos del signo vital que alimenta.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Señal PPG cruda (rawRed, rawGreen, rawBlue)                            │
 * │           │                                                              │
 * │  ┌──────────────────────────────────────────────────────────────────┐  │
 * │  │ CANAL 1: LATIDOS (HR)                                            │  │
 * │  │   • Butterworth BP 0.5–4.5 Hz — rango cardíaco estándar         │  │
 * │  │   • Hampel online (ventana 7, σ=3) — spikes de micro-movimiento  │  │
 * │  │   → filteredHR: señal para HeartBeatProcessor y PPGSignalMeter   │  │
 * │  └──────────────────────────────────────────────────────────────────┘  │
 * │                                                                          │
 * │  ┌──────────────────────────────────────────────────────────────────┐  │
 * │  │ CANAL 2: SpO2 (AC/DC separados)                                  │  │
 * │  │   • AC:  Butterworth BP 0.5–3.5 Hz + Hampel online (ventana 5)   │  │
 * │  │   • DC:  Promedio móvil 200 samples (≈6.7 s a 30 fps)            │  │
 * │  │   → { acRed, dcRed, acGreen, dcGreen } limpios para ratio R/G    │  │
 * │  └──────────────────────────────────────────────────────────────────┘  │
 * │                                                                          │
 * │  ┌──────────────────────────────────────────────────────────────────┐  │
 * │  │ CANAL 3: MORFOLOGÍA / PRESIÓN ARTERIAL                           │  │
 * │  │   • Bessel BP 0.5–12 Hz (fase lineal ≈) — preserva fiduciales   │  │
 * │  │   • Detrend online (resta MA 180 samples) — elimina drift        │  │
 * │  │   • Hampel suave (ventana 9, σ=2.8) — spikes sin borrar picos    │  │
 * │  │   → morphology: para PPGFeatureExtractor y BloodPressureProcessor │  │
 * │  └──────────────────────────────────────────────────────────────────┘  │
 * │                                                                          │
 * │  ┌──────────────────────────────────────────────────────────────────┐  │
 * │  │ CANAL 4: RESPIRACIÓN                                             │  │
 * │  │   • LP Butterworth 4° < 0.55 Hz + HPF simple 0.08 Hz            │  │
 * │  │   • Dual-path RIIV: modulación de amplitud del pulso cardiaco    │  │
 * │  │   → respiration: modalidad RIIV de la Smart Fusion respiratoria  │  │
 * │  └──────────────────────────────────────────────────────────────────┘  │
 * │                                                                          │
 * │  ┌──────────────────────────────────────────────────────────────────┐  │
 * │  │ CANAL 5: ARRITMIAS / INTERVALOS RR                               │  │
 * │  │   • Butterworth BP 0.5–3.5 Hz (estrecho, sin armónicos altos)   │  │
 * │  │   • Notch adaptativo en 2×f_HR (elimina muesca dicrota)          │  │
 * │  │   • Hampel suave (ventana 11, σ=3.5) — preserva PVC reales      │  │
 * │  │   → arrhythmia: canal limpio para detección de RR intervals      │  │
 * │  └──────────────────────────────────────────────────────────────────┘  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * PRINCIPIOS DE DISEÑO:
 *   1. No-op seguro: NaN/Inf en cualquier canal retorna 0 (sin propagar error)
 *   2. Stateful: cada instancia mantiene estado entre frames
 *   3. Bajo acoplamiento: no conoce HeartBeatProcessor ni VitalSignsProcessor
 *   4. Adaptativo a fs: reconfigura filtros si cambia el sample rate
 *   5. Sin ANC inter-canal: NO se usa el azul como referencia LMS. En PPG de
 *      dedo con flash los 3 canales R/G/B están dominados por el MISMO pulso y
 *      altamente correlacionados, así que un LMS con referencia azul converge a
 *      cancelar el pulso real (AC→0) en vez de ruido. Cada canal se filtra de
 *      forma independiente (la ANC con referencia azul es técnica de rPPG de
 *      rostro y NO aplica al PPG de contacto).
 *
 * Referencias:
 *   - De Haan & Jeanne 2013 (CHROM/POS para rPPG)
 *   - Elgendi 2016 (detección de picos PPG — Skewness SQI)
 *   - MIT Media Lab RIIV (Respiration-Induced Intensity Variations)
 *   - NIH 2024: multirate filter banks for vital signs
 */

import { BandpassFilter } from './BandpassFilter';
import { BesselFilter } from './shared/BesselFilter';
import {
  createHampelState,
  applyHampelOnline,
  resetHampelState,
  type HampelOnlineState,
} from './shared/HampelOnline';
import {
  createAdaptiveNotchState,
  applyAdaptiveNotch,
  updateNotchFromBpm,
  resetAdaptiveNotch,
  type AdaptiveNotchState,
} from './shared/AdaptiveNotch';
import { clamp } from '../../utils/math';
import { DSP_CONSTANTS } from '../../config/signalProcessing';

// ─── Tipos de salida ──────────────────────────────────────────────────────────

export interface SplitterSpO2Channels {
  /** Componente AC del canal rojo (pulsátil, filtrada BP 0.5–3.5 Hz) */
  acRed: number;
  /** Componente DC del canal rojo (baseline, promedio móvil largo) */
  dcRed: number;
  /** Componente AC del canal verde (pulsátil, filtrada BP 0.5–3.5 Hz) */
  acGreen: number;
  /** Componente DC del canal verde (baseline, promedio móvil largo) */
  dcGreen: number;
  /** Componente AC del canal azul (pulsátil, filtrada BP 0.5–3.5 Hz) */
  acBlue: number;
  /** Componente DC del canal azul (baseline, promedio móvil largo) */
  dcBlue: number;
}

export interface SplitterOutput {
  /** Canal 1: señal para detección de latidos (Butterworth BP + Hampel) */
  filteredHR: number;
  /** Canal 2: componentes AC/DC limpios para ratio-of-ratios SpO2 */
  spo2: SplitterSpO2Channels;
  /** Canal 3: señal preservando morfología de pulso (Bessel + detrend) */
  morphology: number;
  /** Canal 4: señal de modulación lenta para estimación de FR */
  respiration: number;
  /** Canal 5: señal limpia de arritmias (BP estrecho + notch + Hampel suave) */
  arrhythmia: number;
}

// ─── Promedio Móvil estacionario (sin Array.shift) ───────────────────────────

class RunningMean {
  private readonly buf: Float64Array;
  private head = 0;
  private sum = 0;
  private count = 0;
  private readonly n: number;

  constructor(windowSize: number) {
    this.n = Math.max(1, windowSize);
    this.buf = new Float64Array(this.n);
  }

  push(v: number): number {
    if (!isFinite(v)) return this.count > 0 ? this.sum / this.count : 0;
    const old = this.buf[this.head] ?? 0;
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.n;
    this.sum += v - old;
    if (this.count < this.n) this.count++;
    return this.count > 0 ? this.sum / this.count : v;
  }

  reset(): void {
    this.buf.fill(0);
    this.head = 0;
    this.sum = 0;
    this.count = 0;
  }

  get length(): number { return this.count; }
}

// ─── Double Exponential Moving Average (DEMA) Tracker con compensación de deriva ───

export class DoubleEmaTracker {
  private ema1 = 0;
  private ema2 = 0;
  private initialized = false;
  private readonly alpha: number;

  constructor(alpha = 0.015) {
    this.alpha = alpha;
  }

  push(x: number): number {
    if (!isFinite(x)) return this.initialized ? 2 * this.ema1 - this.ema2 : 0;
    if (!this.initialized) {
      this.ema1 = x;
      this.ema2 = x;
      this.initialized = true;
      return x;
    }

    // Compensación de deriva adaptativa: ante cambios bruscos (>15%),
    // aceleramos la convergencia aumentando temporalmente el alpha.
    let currentAlpha = this.alpha;
    if (this.ema1 > 0) {
      const diffFrac = Math.abs(x - this.ema1) / this.ema1;
      if (diffFrac > 0.15) {
        currentAlpha = Math.min(0.5, this.alpha * 10);
      }
    }

    this.ema1 = (1 - currentAlpha) * this.ema1 + currentAlpha * x;
    this.ema2 = (1 - currentAlpha) * this.ema2 + currentAlpha * this.ema1;
    const dc = 2 * this.ema1 - this.ema2;
    return isFinite(dc) ? dc : x;
  }

  reset(): void {
    this.ema1 = 0;
    this.ema2 = 0;
    this.initialized = false;
  }
}

// ─── HPF de primer orden simple (DC blocker) ─────────────────────────────────

class SimpleHPF {
  private prev = 0;
  private prevOut = 0;
  private readonly alpha: number;

  /** @param fc Frecuencia de corte en Hz */
  constructor(fc: number, fs: number) {
    const rc = 1 / (2 * Math.PI * fc);
    const dt = 1 / fs;
    this.alpha = rc / (rc + dt);
  }

  filter(x: number): number {
    if (!isFinite(x)) return 0;
    const y = this.alpha * (this.prevOut + x - this.prev);
    this.prev = x;
    this.prevOut = isFinite(y) ? y : 0;
    return this.prevOut;
  }

  reset(): void { this.prev = 0; this.prevOut = 0; }
}

// ─── Clase principal ──────────────────────────────────────────────────────────

export class PPGSignalSplitter {
  private readonly morphHPF: SimpleHPF;

  // === Canal 1: HR ===
  private readonly hrBP: BandpassFilter;         // Butterworth BP 0.5–4.5 Hz
  private readonly hrHampel: HampelOnlineState;  // Ventana 7, σ=3

  // === Canal 2: SpO2 ===
  private readonly spo2BpRed: BandpassFilter;    // BP 0.5–3.5 Hz canal rojo
  private readonly spo2BpGreen: BandpassFilter;  // BP 0.5–3.5 Hz canal verde
  private readonly spo2BpBlue: BandpassFilter;   // BP 0.5–3.5 Hz canal azul
  private readonly spo2DcRed: DoubleEmaTracker;  // DEMA con compensación de deriva
  private readonly spo2DcGreen: DoubleEmaTracker;
  private readonly spo2DcBlue: DoubleEmaTracker;
  private readonly spo2HampelRed: HampelOnlineState;   // Ventana 5, σ=2.5
  private readonly spo2HampelGreen: HampelOnlineState; // Ventana 5, σ=2.5

  // === Canal 3: Morfología/PA ===
  private readonly morphBessel: BesselFilter;    // Bessel BP 0.5–12 Hz
  private readonly morphDcMa: RunningMean;       // MA 180 samples (detrend)
  private readonly morphHampel: HampelOnlineState; // Ventana 9, σ=2.8

  // === Canal 4: Respiración ===
  // LP Butterworth construido con HPF y LPF separados para la banda respiratoria
  private readonly respLP: BandpassFilter;       // Trick: BP muy bajo (0.08–0.55 Hz)
  private readonly respHPF: SimpleHPF;           // Blocker de deriva ultra-lenta
  // RIIV: modulación de amplitud (envolvente del pulso cardiaco)
  private readonly riivMa: RunningMean;          // Suavizado de |filteredHR|

  // === Canal 5: Arritmias ===
  private readonly arrBP: BandpassFilter;        // Butterworth BP 0.5–3.5 Hz
  private readonly arrNotch: AdaptiveNotchState; // Notch adaptativo en 2×f_HR
  private readonly arrHampel: HampelOnlineState; // Ventana 11, σ=3.5
  private readonly arrMwi: RunningMean;          // Moving Window Integration 180 ms (~6 frames a 30fps)

  private fs: number;

  constructor(sampleRate = DSP_CONSTANTS.DEFAULT_SAMPLE_RATE) {
    this.fs = sampleRate;

    // Canal 1 — HR
    this.hrBP = new BandpassFilter(sampleRate, 4.5);
    this.hrHampel = createHampelState(7);

    // Canal 2 — SpO2
    const spo2HighCut = 3.5;
    this.spo2BpRed = new BandpassFilter(sampleRate, spo2HighCut);
    this.spo2BpGreen = new BandpassFilter(sampleRate, spo2HighCut);
    this.spo2BpBlue = new BandpassFilter(sampleRate, spo2HighCut);
    this.spo2DcRed = new DoubleEmaTracker(0.015);
    this.spo2DcGreen = new DoubleEmaTracker(0.015);
    this.spo2DcBlue = new DoubleEmaTracker(0.015);
    this.spo2HampelRed = createHampelState(5);
    this.spo2HampelGreen = createHampelState(5);

    // Canal 3 — Morfología/PA (Bessel para fase lineal)
    this.morphBessel = new BesselFilter(sampleRate, 0.5, 12.0);
    this.morphDcMa = new RunningMean(180);
    this.morphHampel = createHampelState(7);
    this.morphHPF = new SimpleHPF(0.5, sampleRate);

    // Canal 4 — Respiración (BP muy bajo: 0.08–0.55 Hz)
    this.respLP = new BandpassFilter(sampleRate, 0.55);
    this.respHPF = new SimpleHPF(0.08, sampleRate);
    this.riivMa = new RunningMean(Math.round(sampleRate * 2)); // ventana 2 s

    // Canal 5 — Arritmias
    this.arrBP = new BandpassFilter(sampleRate, 3.5);
    this.arrNotch = createAdaptiveNotchState(sampleRate, 18);
    this.arrHampel = createHampelState(11);
    // MWI: ventana ~180 ms a fs=30 Hz → 6 frames
    this.arrMwi = new RunningMean(Math.max(3, Math.round(sampleRate * 0.18)));
  }

  /**
   * Procesa un frame de la cámara y retorna las 5 salidas del banco de filtros.
   */
  process(
    rawRed: number,
    rawGreen: number,
    rawBlue: number,
    currentBpm = 0,
  ): SplitterOutput {
    const r = isFinite(rawRed) ? rawRed : 0;
    const g = isFinite(rawGreen) ? rawGreen : 0;
    const b = isFinite(rawBlue) ? rawBlue : 0;

    const acBlue = safeFilter(() => this.spo2BpBlue.filter(b));

    // Canal 1: HR — Butterworth BP + Hampel, filtrado independiente (sin ANC).
    const rHampel = applyHampelOnline(this.hrHampel, r, 3.0);
    const filteredHR = safeFilter(() => this.hrBP.filter(rHampel));

    // Canal 2: SpO2
    const dcRed = this.spo2DcRed.push(r);
    const dcGreen = this.spo2DcGreen.push(g);
    const dcBlue = this.spo2DcBlue.push(b);
    const rHampelSpo2 = applyHampelOnline(this.spo2HampelRed, r, 2.5);
    const gHampelSpo2 = applyHampelOnline(this.spo2HampelGreen, g, 2.5);
    const acRed = safeFilter(() => this.spo2BpRed.filter(rHampelSpo2));
    const acGreen = safeFilter(() => this.spo2BpGreen.filter(gHampelSpo2));

    // Canal 3: Morfología/PA
    const morphDc = this.morphDcMa.push(r);
    const morphDetrended = r - morphDc;
    const morphHampeled = applyHampelOnline(this.morphHampel, morphDetrended, 2.8);
    let morphology = safeFilter(() => this.morphBessel.filter(morphHampeled));
    morphology = this.morphHPF.filter(morphology);

    // Canal 4: Respiración
    const respPathA = safeFilter(() => {
      const lpOut = this.respLP.filter(r);
      return this.respHPF.filter(lpOut);
    });
    const riivInstant = Math.abs(filteredHR);
    const riivSmoothed = this.riivMa.push(riivInstant);
    const respPathB = riivSmoothed;
    const pulseStrength = clamp(Math.abs(filteredHR) / 10, 0, 1);
    const respiration = respPathA * (1 - pulseStrength * 0.4) + respPathB * (pulseStrength * 0.4);

    // Canal 5: Arritmias
    updateNotchFromBpm(this.arrNotch, currentBpm);
    const arrBpFiltered = safeFilter(() => this.arrBP.filter(r));
    const arrNotched = applyAdaptiveNotch(this.arrNotch, arrBpFiltered);
    const arrHampeled = applyHampelOnline(this.arrHampel, arrNotched, 3.5);
    const arrhythmia = this.arrMwi.push(arrHampeled);

    return {
      filteredHR,
      spo2: {
        acRed:   clampFinite(acRed),
        dcRed:   clampFinite(dcRed),
        acGreen: clampFinite(acGreen),
        dcGreen: clampFinite(dcGreen),
        acBlue:  clampFinite(acBlue),
        dcBlue:  clampFinite(dcBlue),
      },
      morphology:  clampFinite(morphology),
      respiration: clampFinite(respiration),
      arrhythmia:  clampFinite(arrhythmia),
    };
  }

  setSampleRate(fs: number): void {
    if (Math.abs(fs - this.fs) < 1) return;
    this.fs = fs;
    this.hrBP.setSampleRate(fs);
    this.spo2BpRed.setSampleRate(fs);
    this.spo2BpGreen.setSampleRate(fs);
    this.spo2BpBlue.setSampleRate(fs);
    this.morphBessel.setSampleRate(fs);
    this.respLP.setSampleRate(fs);
    this.arrBP.setSampleRate(fs);
    this.respHPF.reset();
  }

  reset(): void {
    this.hrBP.reset();
    resetHampelState(this.hrHampel);
    this.spo2BpRed.reset();
    this.spo2BpGreen.reset();
    this.spo2BpBlue.reset();
    this.spo2DcRed.reset();
    this.spo2DcGreen.reset();
    this.spo2DcBlue.reset();
    resetHampelState(this.spo2HampelRed);
    resetHampelState(this.spo2HampelGreen);
    this.morphBessel.reset();
    this.morphDcMa.reset();
    resetHampelState(this.morphHampel);
    this.morphHPF.reset();
    this.respLP.reset();
    this.respHPF.reset();
    this.riivMa.reset();
    this.arrBP.reset();
    resetAdaptiveNotch(this.arrNotch);
    resetHampelState(this.arrHampel);
    this.arrMwi.reset();
  }
}

function safeFilter(fn: () => number): number {
  try {
    const v = fn();
    return isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function clampFinite(v: number): number {
  return isFinite(v) ? v : 0;
}
