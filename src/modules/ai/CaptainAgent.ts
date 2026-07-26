import { ModelService, type ModelStatus } from './ModelService';
import { ContextBuilder, type VitalContext } from './ContextBuilder';
import { SignalAnalyzer, type SignalFeatures } from '../signal-processing/reasoner/SignalAnalyzer';
import { TechnicalAdapter, type TechnicalState } from '../signal-processing/reasoner/TechnicalAdapter';
import { createLogger } from '../../utils/logger';

const log = createLogger('CaptainAgent');

export interface ClinicalAssessment {
  signalQuality: { level: string; confidence: number; explanation: string };
  heartRate: { value: number; confidence: number; rhythm: string };
  arrhythmia: { detected: boolean; likelihood: number; type: string; explanation: string };
  perfusion: { level: string; confidence: number; explanation: string };
  hemodynamic: { estimatedMAP: number; confidence: number; explanation: string };
  assessment: string;
  recommendations: string[];
  timestamp: number;
  raw?: string;
}

export interface CaptainState {
  modelStatus: ModelStatus;
  lastAssessment: ClinicalAssessment | null;
  inferenceCount: number;
  lastInferenceMs: number;
  error: string | null;
}

export class CaptainAgent {
  private modelService: ModelService;
  private contextBuilder: ContextBuilder;
  private signalAnalyzer: SignalAnalyzer;
  private technicalAdapter: TechnicalAdapter;
  private inferenceIntervalMs = 4000;
  private lastInferenceTime = 0;
  private isInferring = false;
  private state: CaptainState = {
    modelStatus: 'idle',
    lastAssessment: null,
    inferenceCount: 0,
    lastInferenceMs: 0,
    error: null,
  };
  private onAssessment?: (assessment: ClinicalAssessment) => void;
  private onStateChange?: (state: CaptainState) => void;

  constructor() {
    this.modelService = new ModelService();
    this.contextBuilder = new ContextBuilder();
    this.signalAnalyzer = new SignalAnalyzer();
    this.technicalAdapter = new TechnicalAdapter();
  }

  async init(
    onAssessment?: (assessment: ClinicalAssessment) => void,
    onStateChange?: (state: CaptainState) => void,
  ): Promise<void> {
    this.onAssessment = onAssessment;
    this.onStateChange = onStateChange;

    this.modelService.init((status) => {
      this.state.modelStatus = status;
      this.onStateChange?.({ ...this.state });
      log.info(`Model status: ${status}`);
    });

    try {
      await this.modelService.init();
      log.info('CaptainAgent initialized');
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
      this.state.modelStatus = 'error';
      this.onStateChange?.({ ...this.state });
      log.error('Failed to init model:', err);
    }
  }

  processFrame(
    signal: number[],
    timestamps: number[],
    peaks: number[],
    ctx: VitalContext,
  ): void {
    const now = ctx.elapsedMs;
    if (now - this.lastInferenceTime < this.inferenceIntervalMs) return;
    if (this.isInferring) return;
    if (signal.length < 20) return;

    const features = this.signalAnalyzer.extractPPGFeatures(signal, timestamps, peaks);
    const tech = this.technicalAdapter.estimateState(signal, features);

    const fullCtx: VitalContext = { ...ctx, features };

    this.runInference(fullCtx, tech, features);
  }

  private async runInference(
    ctx: VitalContext,
    tech: TechnicalState,
    features: SignalFeatures,
  ): Promise<void> {
    this.isInferring = true;
    this.lastInferenceTime = ctx.elapsedMs;

    try {
      const messages = this.contextBuilder.buildMessages(ctx);
      const raw = await this.modelService.infer({ messages, maxTokens: 600 });
      const parsed = this.parseAssessment(raw, ctx);

      if (parsed) {
        this.state.lastAssessment = parsed;
        this.state.inferenceCount++;
        this.state.lastInferenceMs = ctx.elapsedMs;
        this.state.error = null;
        this.contextBuilder.addToHistory(parsed.assessment);
        this.onAssessment?.(parsed);
        this.onStateChange?.({ ...this.state });
      }
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
      this.onStateChange?.({ ...this.state });
      log.error('Inference error:', err);
    } finally {
      this.isInferring = false;
    }
  }

  private parseAssessment(raw: string, ctx: VitalContext): ClinicalAssessment | null {
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const obj = JSON.parse(jsonMatch[0]);

      return {
        signalQuality: obj.signalQuality ?? { level: 'unknown', confidence: 0, explanation: '' },
        heartRate: obj.heartRate ?? { value: ctx.heartRate, confidence: 0, rhythm: 'unknown' },
        arrhythmia: obj.arrhythmia ?? { detected: false, likelihood: 0, type: 'none', explanation: '' },
        perfusion: obj.perfusion ?? { level: 'unknown', confidence: 0, explanation: '' },
        hemodynamic: obj.hemodynamic ?? { estimatedMAP: 0, confidence: 0, explanation: '' },
        assessment: obj.assessment ?? '',
        recommendations: obj.recommendations ?? [],
        timestamp: ctx.elapsedMs,
        raw,
      };
    } catch {
      return {
        signalQuality: { level: 'unknown', confidence: 0, explanation: 'Parse error' },
        heartRate: { value: ctx.heartRate, confidence: 0, rhythm: 'unknown' },
        arrhythmia: { detected: false, likelihood: 0, type: 'none', explanation: '' },
        perfusion: { level: 'unknown', confidence: 0, explanation: '' },
        hemodynamic: { estimatedMAP: 0, confidence: 0, explanation: '' },
        assessment: raw.slice(0, 200),
        recommendations: [],
        timestamp: ctx.elapsedMs,
        raw,
      };
    }
  }

  getState(): CaptainState {
    return { ...this.state };
  }

  getAssessment(): ClinicalAssessment | null {
    return this.state.lastAssessment;
  }

  setInferenceInterval(ms: number): void {
    this.inferenceIntervalMs = Math.max(2000, ms);
  }

  reset(): void {
    this.state = {
      modelStatus: this.state.modelStatus,
      lastAssessment: null,
      inferenceCount: 0,
      lastInferenceMs: 0,
      error: null,
    };
    this.contextBuilder.reset();
    this.isInferring = false;
    this.lastInferenceTime = 0;
  }

  dispose(): void {
    this.modelService.dispose();
    this.reset();
  }
}
