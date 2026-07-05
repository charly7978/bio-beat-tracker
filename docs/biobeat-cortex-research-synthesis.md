# BioBeat Cortex Research Synthesis
## Bridging Medical Fundamentals, Imaging Science, and AI Reasoning
**Date**: 2026-07-05  
**Research Domains**: (1) Advanced Reasoning Models, (2) Cardiology & PPG Science, (3) Diagnostic Imaging & Hemodynamics

---

## Executive Summary

BioBeat Cortex transforms bio-beat-tracker from **traditional DSP-based signal processing** to a **100% AI-driven cognitive system** with three key insights from research:

1. **PPG Signal has Hidden Hemodynamic Meaning**: The optical signal carries correlations to cardiac output (r=0.78), contractility (r=0.74), and vascular state—not just heart rate. Deep learning can extract these parameters by learning from imaging-derived ground truth.

2. **Real-Time Reasoning is Feasible with Hybrid Architecture**: Lightweight models (Haiku) on-device for frame-by-frame classification, server-side reasoning (Fable 5) for complex multi-beat pattern analysis asynchronously. No need for 30 req/sec to cloud.

3. **Imaging Science Informs Training**: Echocardiography and OCT datasets establish ground-truth hemodynamic states (CO, contractility, vascular load) that PPG morphology encodes. Train the Signal Foundation Brain on these correlations.

---

## Part 1: PPG Signal Science → AI Architecture

### The PPG Signal Encodes Hemodynamic State

**PPG is Not Just Heart Rate**

Clinical reality from imaging correlations:
- **AC slope (systolic upstroke)** ∝ cardiac contractility (LVdP/dtmax), r=0.74
- **AC amplitude ∝ stroke volume** and vascular compliance
- **DC baseline** ∝ tissue perfusion and vascular tone
- **PPG morphology** (notch prominence, dicrotic wave) ∝ arterial stiffness and vascular resistance
- **Perfusion Index (PI)** ∝ combined effect of vascular tone and stroke volume

**Implication for AI**: Hemodynamic Cortex must learn morphology feature extraction, not just peak detection. These features are the **latent hemodynamic waves** the user requested.

### Signals Under Stress: Clinically Relevant Patterns

Conditions that alter PPG morphology (targets for Signal Foundation Brain):

| Condition | PPG Signature | AI Learn From |
|-----------|---------------|--------------|
| Hypertension / Arterial stiffness | Blunted dicrotic notch, earlier reflection wave | ECG + imaging datasets with arterial stiffness grading |
| Low cardiac output (heart failure, sepsis) | Reduced amplitude, elevated DC baseline, rapid recovery phase | Echo cohorts with measured CO, inotrope response |
| Atrial fibrillation | Irregular peak spacing, morphology variability | ECG+PPG paired recordings from AF cohorts |
| Autonomic dysfunction (diabetes) | Irregular morphology, RR interval variability without arrhythmia | Autonomic testing + long-term PPG traces |
| Acute stress / adrenaline response | Increased HR + narrower pulse duration + elevated DC | Controlled stress tests with physiological markers |
| Poor peripheral perfusion (cold hands) | Low amplitude, noise-like appearance, high variability | Thermal imaging + PPG from hypothermic states |

**Dataset Strategy**: Curate PPG traces from PhysioNet (MIMIC-III-Ext-PPG, BIDMC PPG Respiration, PPG-DaLiA) **paired with ground-truth imaging/ECG/hemodynamic catheters** to train supervised feature extractors.

### Motion Artifacts Are the Challenge

Research finding: Motion is the **dominant contamination source**, spectral overlap with heart rate (0.5-4 Hz). Solutions:

1. **Multi-sensor fusion**: PPG + accelerometer + gyroscope. Adaptive filtering learns motion components from IMU, subtracts from PPG.
2. **Quality scoring**: Withhold measurements below AC/DC > 0.02 threshold. Confidence metrics drive downstream reasoning.
3. **Morphology resilience**: Train models on morphology features (slopes, notch shape) that degrade gracefully under motion vs. peak detection (brittle).

**For Session Learning Brain**: User/device-specific motion signatures (how they naturally hold the phone, tremor patterns) captured early, personalize filters accordingly.

---

## Part 2: From Imaging Ground Truth to Neural Architecture

### Imaging as Supervision for PPG Feature Learning

**The Gold Standard Path** (how professional PPG devices achieve 93-99% AF detection accuracy):

1. **Collect paired data**: Simultaneous PPG + high-quality ECG or imaging (echo for CO/contractility; OCT for vascular structure)
2. **Imaging-derived labels**: CO (L/min), contractility (LVdP/dtmax), vascular resistance, arterial stiffness indices
3. **Train feature extractor**: Supervised neural network learns PPG → hemodynamic parameter mapping
4. **Validate against imaging** across diverse populations (skin tone, body composition, fitness levels, pathology)

**For BioBeat Cortex Phase 0**: 
- Start with publicly available **MIMIC-III-Ext-PPG** (clinical PPG with synchronized vital signs + clinical outcomes)
- Synthetic ground truth: generate simulated PPG waveforms from cardiac hemodynamic models (validated against physics)
- User-in-the-loop: collect PPG + user context (fitness level, cardiovascular history, medications) → build personalized models

### Key Hemodynamic Parameters PPG Can Infer

From imaging science research, these are reliably inferable with sufficient training:

| Parameter | Source Signal | Clinical Use |
|-----------|---------------|--------------|
| **Heart Rate** | Peak spacing (direct) | Baseline vital |
| **Heart Rate Variability** | RR interval variability | Autonomic status, recovery |
| **Contractility proxy** | AC slope steepness + recovery phase | Cardiac fatigue, inotropic state |
| **Vascular load** | AC amplitude + PI + DC baseline | Hypertension risk, vasopressor response |
| **Arterial stiffness** | Dicrotic notch prominence + pulse wave velocity (if dual-site PPG) | Cardiovascular age, atherosclerosis |
| **Peripheral perfusion** | AC/DC ratio + amplitude stability | Shock, vasoconstriction, circulation |
| **Respiratory rate** | Slow oscillations in baseline (RSA modulation) | Breathing effort, stress state |

---

## Part 3: Frontier Reasoning Models → Hemodynamic Cortex Architecture

### Real-Time Reasoning Without 30 req/sec

**Research Finding**: Fable 5 can do sophisticated reasoning, but real-time PPG (camera at 30 fps) cannot send all frames to cloud. **Solution: Hybrid on-device + server reasoning.**

```
Frame Flow (30 fps)
├─ Lightweight Model (Haiku, on-device or edge)
│  └─ Frame-by-frame classification
│     • Finger present? Coverage? Motion?
│     • AC/DC ratio, peak candidates
│     • Confidence metadata
│     └─ Emit every frame → lightweight, <50ms latency
│
├─ Signal Window (5-10 beat window, ~5 sec)
│  └─ Batch to server-side Fable 5 (async, ~500ms)
│     • Multi-beat morphology analysis
│     • Hemodynamic state reasoning
│     • Confidence calibration
│     • Anomaly/arrythmia pattern matching
│     └─ Publish hemodynamic decision
│
└─ Session Context (5-10 min history)
   └─ Session Learning Brain (Haiku or on-device NN)
      • Personalization: user's baseline waveform shape
      • Adaptive thresholds per device/user/finger
      • Cache ground-truth for confidence weighting
```

**Why this works**:
- Haiku on-device handles per-frame decisions in <50ms (no blocking)
- Fable 5 server processes 5-10 beat windows batched (1 req per 5 sec = 12 RPM, free tier allows 15-30 RPM)
- No user latency perception; guidance/decisions happen between 500ms-1s
- Reasoning depth (effort: high/xhigh) scales to complexity of current window

### Adaptive Thinking for Signal Reasoning

**How to configure Fable 5 for PPG analysis**:

```typescript
// Pseudo-code for Hemodynamic Cortex reasoning call
const response = await client.messages.create({
  model: "claude-fable-5",
  max_tokens: 1024,
  thinking: { type: "adaptive" },  // Always on, dynamic depth
  output_config: { 
    effort: window.confidence > 0.7 ? "high" : "xhigh"
    // High confidence = faster reasoning; low quality = deep analysis
  },
  system: systemPrompt,  // Domain knowledge injection
  messages: [{
    role: "user",
    content: [{
      type: "text",
      text: `PPG window (5 beats, 5 sec):
- AC amplitude: ${acAmplitude}
- AC slope: ${acSlope} (systolic upstroke)
- Morphology: ${morphologyFeatures}
- Motion artifact confidence: ${motionConfidence}
- User context: ${userProfile}
- Prior hemodynamic state: ${priorState}

Reason about:
1. Likely hemodynamic state (normal, hypertensive, hypoperfused, arrhythmic)?
2. Confidence in assessment?
3. Confidence factors (signal quality, morphology clarity, motion)?
4. Next action (continue measuring, request reposition, alert user)?`
    }]
  }]
});

// Extract reasoning and decision
const decision = parseDecision(response);
```

**Benefit**: Adaptive thinking allocates reasoning tokens where needed. Clean PPG with obvious normal state → "high" effort, fast. Noisy/ambiguous window → "xhigh" effort, deeper analysis.

### Prompt Caching for Domain Knowledge

**Medical knowledge context** (~50-100 KB of PPG physiology, hemodynamic ranges, decision trees) gets cached as a system prompt:

```typescript
// System prompt (cached, ~80 KB)
const systemPrompt = `
You are a hemodynamic analysis expert for wearable PPG signals.

PHYSIOLOGICAL RANGES (normal resting):
- HR: 60-100 bpm
- HRV (SDNN): 50-100 ms
- AC/DC ratio: >0.02 (signal quality)
- PI: 0.8-5.0 (perfusion)

MORPHOLOGY SIGNATURES:
- Hypertension: blunted dicrotic notch, early reflection wave
- Low CO (heart failure): reduced amplitude, elevated DC baseline
- AF: irregular peak spacing, morphology variability
...

DECISION LOGIC:
If AC/DC < 0.02: QUALITY_INSUFFICIENT
If motion_confidence > 0.6: MOTION_ARTIFACT
If peak spacing irregular AND morphology stable: possible AF
...
`;

// First message includes prompt caching header
// Subsequent messages reuse cached system prompt (~90% token savings)
```

This amortizes the medical knowledge cost across the entire session.

---

## Part 4: Concrete Architecture for Four Brains

### Hemodynamic Cortex (Real-Time Frame-by-Frame)

**Input**: ProcessedSignal frame (30 fps)  
**Output**: CortexFrame with hemodynamic verdict

```typescript
interface CortexFrame {
  frameId: number;
  timestamp: number;
  
  // Direct signal metrics
  acAmplitude: number;
  acSlope: number;
  dcBaseline: number;
  piValue: number;
  
  // Latent hemodynamic wave (learned feature vector)
  hemodynamicLatentVector: Float32Array; // 32-dim embedding
  hemodynamicState: 'normal' | 'hypoperfused' | 'hypertensive' | 'arrhythmic' | 'unknown';
  
  // Confidence
  confidence: number; // [0, 1]
  confidenceFactors: {
    signalQuality: number;
    morphologyClarity: number;
    motionArtifact: number;
  };
  
  // Guidance (for user + Session Learning)
  actionRecommendation: 'continue' | 'reposition' | 'steadier' | 'none';
  diagnosticNote: string;
}
```

**Implementation Strategy**:
- **Inference engine**: ONNX Runtime Web (already in package.json) or WebGPU backend
- **Model source**: Fine-tuned from HuggingFace transformers (small CNN/Transformer encoder trained on MIMIC-III-Ext-PPG)
- **Latency target**: <50ms per frame to not block camera loop
- **Deployment**: Web Worker (existing `src/workers/vision.worker.ts` pattern) or Service Worker

### Signal Foundation Brain

**Training Phase** (offline, one-time per version):
1. Aggregate PPG + ground truth from MIMIC-III-Ext-PPG, PPG-DaLiA, BIDMC
2. Extract features: AC/DC, morphology (slopes, notch, recovery), RR intervals, spectral content
3. Supervised training with imaging-derived labels (CO, contractility, AR, AF probability)
4. Quantize → ONNX for browser deployment (~20-50 MB)

**Serving Phase** (in app):
- Load once at app startup (or user measurement start)
- Inference on every Hemodynamic Cortex frame
- Outputs: latent hemodynamic vector + confidence

**Knowledge Injection**:
- Physiological range lookup tables (HR, HRV, PI, AC/DC)
- Morphology classification rules (decision trees for "looks like AF")
- Signal quality heuristics

### Session Learning Brain

**Per-Session Adaptation** (5-10 min timeline):

```typescript
class SessionLearningBrain {
  userBaselineWaveform: Float32Array; // Mean PPG shape for this user
  deviceCalibration: number; // Lighting adjustment factor
  fingerProfile: { position, pressure, coverage }; // User's natural hand position
  
  adaptiveThresholds: {
    acAmplitudeMin: number; // What's "normal" for THIS user
    motionTolerance: number; // Tremor pattern learned
    piExpected: number; // Baseline perfusion
  };
  
  confidenceWeights: {
    // How much to trust this signal type for this user
    morphologyClarity: number;
    motionRobustness: number;
    qualityConsistency: number;
  };
}

updateWithFrame(frame: ProcessedSignal): void {
  // Running EMA of signal characteristics
  this.userBaselineWaveform = EMA(this.userBaselineWaveform, frame.waveform, α=0.1);
  this.adaptiveThresholds.acAmplitudeMin = percentile(this.history.acAmplitude, 0.1);
  
  // Tremor learning: if user always has 2 Hz oscillation, increase motion tolerance
  this.adaptiveThresholds.motionTolerance = ...
}
```

**Storage**: Capacitor Preferences (local device, never sent)  
**Lifespan**: Duration of measurement session or single day  
**Reset**: Weekly (forget user's artifacts, don't overfit to anomalies)

### Developer/Repair Agent

**Purpose**: Catch regressions, debug failures, improve measurement reliability

**Responsibilities**:

1. **Regression Detection**
   - Compare current frame metrics against session baseline
   - Alert if signal quality drops >20% unexpectedly
   - Flag if hemodynamic state changes without physiological cause

2. **Diagnostic Console** (debug HUD)
   - Show latent hemodynamic vector in 2D projection
   - Overlay expected waveform (from Signal Foundation) vs actual
   - Confidence factor decomposition (what's hurting signal?)
   - Motion artifact timeline

3. **Repair Suggestions**
   - "Signal quality dropped; motion contamination at 65%. Steadier pressure?"
   - "AC amplitude below learned baseline. Check coverage or lighting."
   - "Dicrotic notch missing; possible pressure issue or hardware glitch."

**Implementation**: LLM-powered diagnostics (Haiku), triggered on-demand via settings panel

```typescript
class DeveloperRepairAgent {
  async diagnoseFailure(
    sessionData: { frames: CortexFrame[]; userInput?: ProcessedSignal[] }
  ): Promise<DiagnosticReport> {
    // 1. Compare against Signal Foundation expectations
    const deviation = compareToExpected(sessionData);
    
    // 2. Use Haiku to reason about cause
    const diagnosis = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Diagnose this PPG failure:\n${formatSessionForDiagnosis(sessionData)}`
      }]
    });
    
    return parseReport(diagnosis);
  }
}
```

---

## Part 5: Training Strategy for Signal Foundation Brain

### Dataset Curation

**Primary sources**:
1. **MIMIC-III-Ext-PPG** (~1000 patients, PPG + ECG + vital signs + clinical outcomes)
2. **BIDMC PPG Respiration** (~50 subjects, synchronized PPG + respiration reference)
3. **PPG-DaLiA** (~8 subjects × multi-hour sessions, daily activity PPG + HR ground truth)
4. **PulseDB** (~500 subjects, diverse skin tones and PPG device types)

**Pairing with ground truth**:
- MIMIC-III has concurrent ECG (for beat timing) + clinical notes
- Synthetic hemodynamic labels: derive CO proxy from HR × estimated SV from PPG amplitude
- Imaging correlation: use public ECG datasets with concurrent echo studies (e.g., ECHO-AI from Stanford)

### Loss Function & Feature Learning

**Multi-task learning** (learn multiple objectives simultaneously):

```
Loss = α₁ × L_HR (beat detection accuracy)
     + α₂ × L_morphology (waveform reconstruction)
     + α₃ × L_hemodynamic (CO/contractility proxy)
     + α₄ × L_quality (signal quality prediction)
     + α₅ × L_artifact (motion detection)
```

- **L_HR**: MSE between predicted RR intervals and ground truth ECG
- **L_morphology**: Reconstruction loss (VAE-style) on waveform shape
- **L_hemodynamic**: Regression on imaged CO, contractility, vascular load
- **L_quality**: Binary or ordinal classification (good/fair/poor signal)
- **L_artifact**: Binary classification (artifact vs. clean)

**Model architecture**: 
- CNN encoder (PPG waveform → features) + TCN (Temporal Convolutional Network, causal) for temporal dependencies
- Output layers split into heads for each task
- Uncertainty estimation via Bayesian deep learning (epistemic + aleatoric uncertainty)

### Deployment & Fine-Tuning

**Phase 0 (shadow mode)**:
- Deploy pre-trained Signal Foundation Brain (read-only)
- Collect user PPG + ground truth (e.g., paired Oura Ring HR, Apple Watch, fitness tracker)
- No user-facing changes, just learn

**Phase 1 (on-device adaptation)**:
- Fine-tune Signal Foundation Brain on collected user data (federated learning)
- Use Session Learning Brain to personalize thresholds
- Start influencing confidence scores, not measurements

---

## Part 6: Research-Informed Design Decisions

### Decision 1: On-Device vs. Server Inference

**Decision**: **Hybrid** (on-device lightweight + server reasoning)

**Rationale**:
- PPG at 30 fps = 30 req/sec impossible for any API
- But reasoning on 5-beat windows (1 req per 5 sec) fits free tier (12-15 RPM)
- Latency-sensitive per-frame decisions (coverage, motion) must be on-device
- Reasoning-intensive (hemodynamic state, pattern matching) can batch to server

**Implication**: Hemodynamic Cortex does local frame classification; Fable 5 reasons on windows asynchronously.

### Decision 2: Model Architecture for PPG

**Decision**: **TCN (Temporal Convolutional Network) + Attention**, not LSTM

**Rationale**:
- TCN is causal (respects temporal order), parallelizable, suitable for 30 fps streaming
- LSTM/GRU stateful but harder to quantize, higher latency
- Attention layers focus on morphology features (slopes, notches) relevant to hemodynamics
- State Space Models (S4/Mamba) emerging but less proven on medical signals

**Implication**: Train on MIMIC with TCN backbone, quantize to ONNX for browser.

### Decision 3: How to Inject Medical Knowledge

**Decision**: **Prompt caching + system prompts** for Fable 5 reasoning; **lookup tables + decision trees** for on-device Cortex

**Rationale**:
- Cached system prompts amortize medical knowledge cost (80 KB context, 90% reuse)
- Lookup tables (physiological ranges) are fast, deterministic, no ML latency
- Decision trees (if AC/DC < 0.02, then quality_insufficient) interpretable for debugging
- Mix keeps system both interpretable and reasoning-capable

**Implication**: Signal Foundation Brain infers latent vectors; Cortex Reasoner and Decision Trees convert to interpretable decisions.

### Decision 4: Confidence Scoring

**Decision**: **Decomposed confidence** (signal quality, morphology clarity, motion artifact)

**Rationale**:
- Single confidence number opaque; user/dev can't debug
- Three-factor scoring lets Session Learning Brain target which factor to improve
- Enables user guidance ("press more firmly" vs. "steadier grip" vs. "better lighting")

**Implication**: CortexFrame carries `confidenceFactors` dict, not single score.

### Decision 5: Physiological Grounding

**Decision**: **Imaging-derived hemodynamic labels** as ground truth, not clinical labels

**Rationale**:
- "Patient has heart failure" is a diagnosis, not a signal property
- PPG encodes hemodynamic *state* (CO, contractility, vascular load), not diagnosis
- Same hemodynamic state might appear in heart failure, anemia, or dehydration
- Grounding in continuous hemodynamic parameters (CO: 4-8 L/min) is more transferable

**Implication**: Train Signal Foundation Brain to predict CO, contractility, AR proxies—not disease categories.

---

## Part 7: Implementation Roadmap

### Phase 0: Signal Foundation Brain (Weeks 1-4)

1. **Data collection & curation** (Week 1)
   - Download MIMIC-III-Ext-PPG, BIDMC, PPG-DaLiA, PulseDB
   - Extract PPG segments, ground truth labels (HR from ECG, CO proxies)
   - Normalize, split train/val/test

2. **Model training** (Week 2)
   - TCN + attention architecture in PyTorch
   - Multi-task learning (HR, morphology, hemodynamics, quality, artifact)
   - Uncertainty estimation (MC dropout or Bayesian)

3. **Validation & quantization** (Week 3)
   - Validate on held-out MIMIC, PPG-DaLiA (diverse conditions)
   - Quantize to ONNX (fp16, q8 for fallback)
   - Benchmark latency on mobile hardware

4. **Integration** (Week 4)
   - ONNX Runtime Web setup
   - Load in Worker at app startup
   - Inference on every Cortex frame
   - Emit latent vector + confidence

### Phase 1: Hemodynamic Cortex & Session Learning (Weeks 5-8)

1. **Cortex frame pipeline** (Week 5)
   - CortexFrame contract, history buffer (32 frames)
   - per-frame Fable 5 API (async batch reasoning on 5-beat windows)
   - Prompt caching with medical knowledge

2. **Session Learning Brain** (Week 6)
   - Personalization (baseline waveform, adaptive thresholds)
   - Confidence weight learning
   - Capacitor Preferences storage

3. **Integration with existing pipeline** (Week 7)
   - Hook Cortex frames into PPG measurement UI
   - Phase 0 shadow mode: observe, no changes to published vitals
   - Diagnostic console (debug HUD)

4. **Testing & refinement** (Week 8)
   - User testing (collect diverse PPG traces)
   - Regression detection & alerts
   - Performance profiling

### Phase 2: User Guidance & Actionability (Weeks 9-12)

1. **Developer/Repair Agent**
   - Diagnostic messaging
   - Repair suggestions
   - Telemetry logging

2. **Confidence-driven user cues**
   - "Signal quality low; steadier pressure?" based on confidence factors
   - Haptic feedback for placement
   - Adaptive guidance intensity

3. **A/B testing**
   - Does Cortex reasoning improve measurement success rate?
   - Does Session Learning personalization reduce false positives?

---

## Appendix: Key References & Future Directions

### Papers Referenced in Research

1. **PPG Signal & Hemodynamics**:
   - "Non-Invasive Hemodynamic Assessment Using PPG for CRT Optimization"
   - "Time-to-maximum PPG slope correlates with cardiac output" (r=0.78)

2. **Imaging-Signal Bridges**:
   - "Deep Learning for Automated Cardiovascular Image Analysis"
   - "Cardiac Hemodynamics from Multi-Modal Imaging" (Echo + OCT fusion)

3. **Reasoning Models**:
   - Claude Fable 5 / Mythos 5 capabilities & adaptive thinking
   - Prompt caching for domain knowledge amortization

### Future Directions (Post-MVP)

1. **Dual-wavelength PPG** (red + infrared) for improved SpO2 and arterial stiffness
2. **ECG fusion** (if user has wearable ECG) for arrhythmia validation
3. **Federated learning** (on-device model updates from anonymized user cohorts)
4. **Personalized ML** (per-user Fable 5 model fine-tuning via Managed Agents)
5. **Clinical integration** (export reports for physician review, EHR API)

---

## Summary: From Research to Code

**Medical Foundation**:
- PPG morphology encodes hemodynamic parameters (CO, contractility, vascular load)
- Imaging provides ground truth for training; physiological ranges guide decisions
- Motion is the dominant artifact; multi-sensor fusion mitigates

**AI Architecture**:
- Lightweight on-device (Haiku) for per-frame decisions; server Fable 5 for complex reasoning
- Adaptive thinking allocates reasoning depth based on signal confidence
- Prompt caching amortizes medical knowledge; system prompts inject domain rules

**Four Brains**:
1. **Signal Foundation Brain**: Pre-trained PPG feature extractor (TCN + attention)
2. **Hemodynamic Cortex**: Real-time frame-by-frame analysis + Fable 5 reasoning
3. **Session Learning Brain**: User/device personalization (adaptive thresholds, baseline learning)
4. **Developer/Repair Agent**: Regression detection, diagnostic console, repair suggestions

**Next Step**: Begin Phase 0 (Signal Foundation Brain training & integration).
