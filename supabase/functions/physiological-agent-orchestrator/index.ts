import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_WINDOW_SAMPLES = 512;
const MAX_KEYFRAMES = 2;
const MAX_KEYFRAME_LENGTH = 750_000;
const MAX_BODY_BYTES = 3_000_000;
const MODEL_TIMEOUT_MS = 25_000;

type ToolName =
  | "inspect_window_integrity"
  | "inspect_ac_dc"
  | "inspect_channel_correlation"
  | "inspect_spectrum"
  | "inspect_rgb_common_mode"
  | "inspect_ringing_decay"
  | "inspect_motion_contamination";

interface OpticalObservation {
  coverageRatio?: number;
  saturationRatio?: number;
  underexposureRatio?: number;
  motionScore?: number;
  centroidMotion?: number;
  exposureJitter?: number;
  rawRed?: number[];
  rawGreen?: number[];
  rawBlue?: number[];
}

interface SignalObservation {
  sampleRateHz: number;
  filtered?: number[];
  morphology?: number[];
  red?: number[];
  green?: number[];
  blue?: number[];
  timestampsMs?: number[];
}

interface PhysiologicalObservationPacket {
  sessionId: string;
  observationId: string;
  startedAtMs: number;
  endedAtMs: number;
  optical: OpticalObservation;
  signal: SignalObservation;
  keyframes?: string[];
  context?: Record<string, unknown>;
}

interface ToolRequest {
  name: ToolName;
  reason: string;
}

interface AgentPlan {
  requestedTools: ToolRequest[];
  initialHypotheses: string[];
  missingEvidence: string[];
}

interface ToolResult {
  name: ToolName;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

interface AgentAssessment {
  agentId: "optical-scene-agent" | "artifact-skeptic-agent";
  modelId: string;
  observationId: string;
  hypotheses: Array<{
    name: string;
    confidence: number;
    supportingEvidence: string[];
    contradictingEvidence: string[];
    predictedConsequences: string[];
  }>;
  requestedObservation: string | null;
  conclusion: string;
  uncertainty: number;
  abstain: boolean;
}

interface Adjudication {
  mode: "shadow";
  observationId: string;
  agreement: "AGREE" | "PARTIAL" | "DISAGREE" | "INSUFFICIENT";
  dominantExplanation: string;
  unresolvedContradictions: string[];
  requestedObservation: string | null;
  abstain: boolean;
  observability: {
    heartRate: "UNASSESSED" | "NOT_OBSERVABLE" | "POSSIBLY_OBSERVABLE";
    rhythm: "UNASSESSED" | "NOT_OBSERVABLE" | "POSSIBLY_OBSERVABLE";
    morphology: "UNASSESSED" | "NOT_OBSERVABLE" | "POSSIBLY_OBSERVABLE";
    oxygenation: "UNASSESSED" | "NOT_OBSERVABLE" | "POSSIBLY_OBSERVABLE";
    pressure: "UNASSESSED" | "NOT_OBSERVABLE" | "POSSIBLY_OBSERVABLE";
    respiration: "UNASSESSED" | "NOT_OBSERVABLE" | "POSSIBLY_OBSERVABLE";
  };
  rationale: string;
  mayPublishVitals: false;
}

const ALL_TOOLS: ToolName[] = [
  "inspect_window_integrity",
  "inspect_ac_dc",
  "inspect_channel_correlation",
  "inspect_spectrum",
  "inspect_rgb_common_mode",
  "inspect_ringing_decay",
  "inspect_motion_contamination",
];

function finiteArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const result: number[] = [];
  for (const item of value.slice(0, MAX_WINDOW_SAMPLES)) {
    const n = Number(item);
    if (Number.isFinite(n)) result.push(n);
  }
  return result;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sanitizePacket(input: unknown): PhysiologicalObservationPacket {
  if (!input || typeof input !== "object") throw new Error("observation packet missing");
  const raw = input as Record<string, unknown>;
  const opticalRaw = (raw.optical ?? {}) as Record<string, unknown>;
  const signalRaw = (raw.signal ?? {}) as Record<string, unknown>;

  const sessionId = String(raw.sessionId ?? "").trim();
  const observationId = String(raw.observationId ?? "").trim();
  const startedAtMs = Number(raw.startedAtMs);
  const endedAtMs = Number(raw.endedAtMs);
  const sampleRateHz = Number(signalRaw.sampleRateHz);

  if (!sessionId || !observationId) throw new Error("sessionId and observationId are required");
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs <= startedAtMs) {
    throw new Error("invalid observation time range");
  }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz < 5 || sampleRateHz > 240) {
    throw new Error("sampleRateHz must be between 5 and 240");
  }

  const keyframes = Array.isArray(raw.keyframes)
    ? raw.keyframes
        .slice(0, MAX_KEYFRAMES)
        .map((value) => String(value))
        .filter((value) => value.startsWith("data:image/") && value.length <= MAX_KEYFRAME_LENGTH)
    : [];

  return {
    sessionId,
    observationId,
    startedAtMs,
    endedAtMs,
    optical: {
      coverageRatio: clamp01(Number(opticalRaw.coverageRatio ?? 0)),
      saturationRatio: clamp01(Number(opticalRaw.saturationRatio ?? 0)),
      underexposureRatio: clamp01(Number(opticalRaw.underexposureRatio ?? 0)),
      motionScore: clamp01(Number(opticalRaw.motionScore ?? 0)),
      centroidMotion: clamp01(Number(opticalRaw.centroidMotion ?? 0)),
      exposureJitter: Math.max(0, Number(opticalRaw.exposureJitter ?? 0)),
      rawRed: finiteArray(opticalRaw.rawRed),
      rawGreen: finiteArray(opticalRaw.rawGreen),
      rawBlue: finiteArray(opticalRaw.rawBlue),
    },
    signal: {
      sampleRateHz,
      filtered: finiteArray(signalRaw.filtered),
      morphology: finiteArray(signalRaw.morphology),
      red: finiteArray(signalRaw.red),
      green: finiteArray(signalRaw.green),
      blue: finiteArray(signalRaw.blue),
      timestampsMs: finiteArray(signalRaw.timestampsMs),
    },
    keyframes,
    context: raw.context && typeof raw.context === "object"
      ? raw.context as Record<string, unknown>
      : undefined,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[], center = mean(values)): number {
  if (values.length < 2) return 0;
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / values.length;
}

function rms(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 8) return null;
  const aa = a.slice(a.length - n);
  const bb = b.slice(b.length - n);
  const ma = mean(aa);
  const mb = mean(bb);
  let numerator = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = aa[i] - ma;
    const xb = bb[i] - mb;
    numerator += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denominator = Math.sqrt(da * db);
  return denominator > 1e-12 ? numerator / denominator : null;
}

function inspectWindowIntegrity(packet: PhysiologicalObservationPacket): Record<string, unknown> {
  const channels = {
    filtered: packet.signal.filtered?.length ?? 0,
    morphology: packet.signal.morphology?.length ?? 0,
    red: packet.signal.red?.length ?? 0,
    green: packet.signal.green?.length ?? 0,
    blue: packet.signal.blue?.length ?? 0,
    timestamps: packet.signal.timestampsMs?.length ?? 0,
  };
  const nonEmpty = Object.values(channels).filter((n) => n > 0);
  const minLength = nonEmpty.length ? Math.min(...nonEmpty) : 0;
  const maxLength = nonEmpty.length ? Math.max(...nonEmpty) : 0;
  return {
    channels,
    minLength,
    maxLength,
    aligned: maxLength === 0 || maxLength - minLength <= 2,
    durationMs: packet.endedAtMs - packet.startedAtMs,
    declaredSampleRateHz: packet.signal.sampleRateHz,
  };
}

function inspectAcDc(packet: PhysiologicalObservationPacket): Record<string, unknown> {
  const summarize = (values: number[]) => {
    const dc = mean(values);
    const ac = Math.sqrt(variance(values, dc));
    return { dc, ac, acDc: Math.abs(dc) > 1e-9 ? ac / Math.abs(dc) : null };
  };
  return {
    red: summarize(packet.signal.red ?? packet.optical.rawRed ?? []),
    green: summarize(packet.signal.green ?? packet.optical.rawGreen ?? []),
    blue: summarize(packet.signal.blue ?? packet.optical.rawBlue ?? []),
  };
}

function inspectChannelCorrelation(packet: PhysiologicalObservationPacket): Record<string, unknown> {
  const red = packet.signal.red ?? packet.optical.rawRed ?? [];
  const green = packet.signal.green ?? packet.optical.rawGreen ?? [];
  const blue = packet.signal.blue ?? packet.optical.rawBlue ?? [];
  return {
    redGreen: pearson(red, green),
    redBlue: pearson(red, blue),
    greenBlue: pearson(green, blue),
    note: "Correlation alone does not prove blood-volume pulsation.",
  };
}

function inspectSpectrum(packet: PhysiologicalObservationPacket): Record<string, unknown> {
  const signal = packet.signal.filtered?.length
    ? packet.signal.filtered
    : packet.signal.green?.length
      ? packet.signal.green
      : packet.signal.red ?? [];
  const n = signal.length;
  if (n < 32) return { available: false, reason: "insufficient samples" };

  const centered = signal.map((value) => value - mean(signal));
  const sampleRate = packet.signal.sampleRateHz;
  let dominantHz = 0;
  let dominantPower = 0;
  let bandPower = 0;
  let totalPower = 0;
  const bins: Array<{ hz: number; power: number }> = [];

  const maxK = Math.floor(n / 2);
  for (let k = 1; k <= maxK; k++) {
    const hz = k * sampleRate / n;
    if (hz > 8) break;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const angle = 2 * Math.PI * k * i / n;
      re += centered[i] * Math.cos(angle);
      im -= centered[i] * Math.sin(angle);
    }
    const power = (re * re + im * im) / (n * n);
    totalPower += power;
    if (hz >= 0.5 && hz <= 4.0) {
      bandPower += power;
      bins.push({ hz, power });
      if (power > dominantPower) {
        dominantPower = power;
        dominantHz = hz;
      }
    }
  }

  const competingPower = bins
    .filter((bin) => Math.abs(bin.hz - dominantHz) > sampleRate / n * 1.5)
    .reduce((max, bin) => Math.max(max, bin.power), 0);

  return {
    available: true,
    dominantHz,
    bpmEquivalent: dominantHz * 60,
    dominantPower,
    cardiacBandFraction: totalPower > 0 ? bandPower / totalPower : 0,
    peakToCompetitorRatio: competingPower > 0 ? dominantPower / competingPower : null,
    note: "A spectral peak is evidence, not proof of cardiovascular origin.",
  };
}

function inspectRgbCommonMode(packet: PhysiologicalObservationPacket): Record<string, unknown> {
  const red = packet.optical.rawRed ?? packet.signal.red ?? [];
  const green = packet.optical.rawGreen ?? packet.signal.green ?? [];
  const blue = packet.optical.rawBlue ?? packet.signal.blue ?? [];
  const n = Math.min(red.length, green.length, blue.length);
  if (n < 8) return { available: false, reason: "insufficient RGB samples" };

  const deltas = (values: number[]) => values.slice(values.length - n + 1).map((value, i) => value - values[values.length - n + i]);
  const dr = deltas(red);
  const dg = deltas(green);
  const db = deltas(blue);
  const rg = pearson(dr, dg);
  const rb = pearson(dr, db);
  const gb = pearson(dg, db);
  const valid = [rg, rb, gb].filter((value): value is number => value !== null);
  return {
    available: true,
    deltaCorrelations: { redGreen: rg, redBlue: rb, greenBlue: gb },
    commonModeStrength: valid.length ? mean(valid.map((value) => Math.max(0, value))) : 0,
  };
}

function inspectRingingDecay(packet: PhysiologicalObservationPacket): Record<string, unknown> {
  const signal = packet.signal.filtered ?? [];
  if (signal.length < 24) return { available: false, reason: "insufficient filtered samples" };
  const third = Math.floor(signal.length / 3);
  const first = signal.slice(0, third);
  const last = signal.slice(signal.length - third);
  const firstRms = rms(first);
  const lastRms = rms(last);
  return {
    available: true,
    firstRms,
    lastRms,
    decayRatio: firstRms > 1e-9 ? lastRms / firstRms : null,
    opticalSourceWeak:
      (packet.optical.coverageRatio ?? 0) < 0.08 ||
      (packet.optical.underexposureRatio ?? 0) > 0.85 ||
      (packet.optical.saturationRatio ?? 0) > 0.85,
  };
}

function inspectMotionContamination(packet: PhysiologicalObservationPacket): Record<string, unknown> {
  const motionScore = packet.optical.motionScore ?? 0;
  const centroidMotion = packet.optical.centroidMotion ?? 0;
  const exposureJitter = packet.optical.exposureJitter ?? 0;
  return {
    motionScore,
    centroidMotion,
    exposureJitter,
    combined: clamp01(Math.max(motionScore, centroidMotion) + Math.min(0.25, exposureJitter / 100)),
  };
}

function runTool(name: ToolName, packet: PhysiologicalObservationPacket): ToolResult {
  try {
    const result = name === "inspect_window_integrity" ? inspectWindowIntegrity(packet)
      : name === "inspect_ac_dc" ? inspectAcDc(packet)
      : name === "inspect_channel_correlation" ? inspectChannelCorrelation(packet)
      : name === "inspect_spectrum" ? inspectSpectrum(packet)
      : name === "inspect_rgb_common_mode" ? inspectRgbCommonMode(packet)
      : name === "inspect_ringing_decay" ? inspectRingingDecay(packet)
      : inspectMotionContamination(packet);
    return { name, ok: true, result };
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return a JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function buildUserContent(text: string, keyframes: string[] = []): unknown {
  if (keyframes.length === 0) return text;
  return [
    { type: "text", text },
    ...keyframes.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
}

async function callModel(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userText: string,
  keyframes: string[] = [],
): Promise<{ parsed: unknown; raw: string; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: buildUserContent(userText, keyframes) },
        ],
        temperature: 0.15,
        stream: false,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`model gateway ${response.status}: ${detail.slice(0, 500)}`);
    }
    const data = await response.json();
    const raw = String(data.choices?.[0]?.message?.content ?? "");
    return { parsed: extractJson(raw), raw, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

function compactPacket(packet: PhysiologicalObservationPacket): Record<string, unknown> {
  return {
    sessionId: packet.sessionId,
    observationId: packet.observationId,
    durationMs: packet.endedAtMs - packet.startedAtMs,
    optical: {
      coverageRatio: packet.optical.coverageRatio,
      saturationRatio: packet.optical.saturationRatio,
      underexposureRatio: packet.optical.underexposureRatio,
      motionScore: packet.optical.motionScore,
      centroidMotion: packet.optical.centroidMotion,
      exposureJitter: packet.optical.exposureJitter,
      rgbSampleCounts: {
        red: packet.optical.rawRed?.length ?? 0,
        green: packet.optical.rawGreen?.length ?? 0,
        blue: packet.optical.rawBlue?.length ?? 0,
      },
    },
    signal: {
      sampleRateHz: packet.signal.sampleRateHz,
      sampleCounts: {
        filtered: packet.signal.filtered?.length ?? 0,
        morphology: packet.signal.morphology?.length ?? 0,
        red: packet.signal.red?.length ?? 0,
        green: packet.signal.green?.length ?? 0,
        blue: packet.signal.blue?.length ?? 0,
      },
    },
    context: packet.context,
    keyframeCount: packet.keyframes?.length ?? 0,
  };
}

function validatePlan(value: unknown): AgentPlan {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const requests = Array.isArray(raw.requestedTools) ? raw.requestedTools : [];
  const requestedTools: ToolRequest[] = requests
    .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : {})
    .map((item) => ({ name: String(item.name) as ToolName, reason: String(item.reason ?? "") }))
    .filter((item) => ALL_TOOLS.includes(item.name))
    .slice(0, 5);
  return {
    requestedTools,
    initialHypotheses: Array.isArray(raw.initialHypotheses) ? raw.initialHypotheses.map(String).slice(0, 8) : [],
    missingEvidence: Array.isArray(raw.missingEvidence) ? raw.missingEvidence.map(String).slice(0, 8) : [],
  };
}

function validateAssessment(value: unknown, agentId: AgentAssessment["agentId"], model: string, observationId: string): AgentAssessment {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const hypothesesRaw = Array.isArray(raw.hypotheses) ? raw.hypotheses : [];
  const hypotheses = hypothesesRaw.slice(0, 8).map((item) => {
    const h = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      name: String(h.name ?? "UNKNOWN"),
      confidence: clamp01(Number(h.confidence ?? 0)),
      supportingEvidence: Array.isArray(h.supportingEvidence) ? h.supportingEvidence.map(String).slice(0, 10) : [],
      contradictingEvidence: Array.isArray(h.contradictingEvidence) ? h.contradictingEvidence.map(String).slice(0, 10) : [],
      predictedConsequences: Array.isArray(h.predictedConsequences) ? h.predictedConsequences.map(String).slice(0, 10) : [],
    };
  });
  return {
    agentId,
    modelId: model,
    observationId,
    hypotheses,
    requestedObservation: raw.requestedObservation ? String(raw.requestedObservation) : null,
    conclusion: String(raw.conclusion ?? "No conclusion"),
    uncertainty: clamp01(Number(raw.uncertainty ?? 1)),
    abstain: Boolean(raw.abstain),
  };
}

function validateAdjudication(value: unknown, observationId: string): Adjudication {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const obs = raw.observability && typeof raw.observability === "object"
    ? raw.observability as Record<string, unknown>
    : {};
  const allowed = new Set(["UNASSESSED", "NOT_OBSERVABLE", "POSSIBLY_OBSERVABLE"]);
  const state = (name: string): Adjudication["observability"]["heartRate"] => {
    const value = String(obs[name] ?? "UNASSESSED");
    return allowed.has(value) ? value as Adjudication["observability"]["heartRate"] : "UNASSESSED";
  };
  const agreementRaw = String(raw.agreement ?? "INSUFFICIENT");
  const agreement = ["AGREE", "PARTIAL", "DISAGREE", "INSUFFICIENT"].includes(agreementRaw)
    ? agreementRaw as Adjudication["agreement"]
    : "INSUFFICIENT";
  return {
    mode: "shadow",
    observationId,
    agreement,
    dominantExplanation: String(raw.dominantExplanation ?? "insufficient evidence"),
    unresolvedContradictions: Array.isArray(raw.unresolvedContradictions)
      ? raw.unresolvedContradictions.map(String).slice(0, 12)
      : [],
    requestedObservation: raw.requestedObservation ? String(raw.requestedObservation) : null,
    abstain: Boolean(raw.abstain),
    observability: {
      heartRate: state("heartRate"),
      rhythm: state("rhythm"),
      morphology: state("morphology"),
      oxygenation: state("oxygenation"),
      pressure: state("pressure"),
      respiration: state("respiration"),
    },
    rationale: String(raw.rationale ?? ""),
    mayPublishVitals: false,
  };
}

const PLAN_SCHEMA = `Return ONLY JSON:
{
  "requestedTools": [{"name": "one allowed tool", "reason": "why"}],
  "initialHypotheses": ["..."],
  "missingEvidence": ["..."]
}`;

const ASSESSMENT_SCHEMA = `Return ONLY JSON:
{
  "hypotheses": [{
    "name": "...",
    "confidence": 0.0,
    "supportingEvidence": ["tool/result references"],
    "contradictingEvidence": ["..."],
    "predictedConsequences": ["what should happen next if true"]
  }],
  "requestedObservation": null,
  "conclusion": "...",
  "uncertainty": 0.0,
  "abstain": true
}`;

const OPTICAL_SYSTEM = `You are the Optical Scene Agent for a smartphone contact-PPG research application.
Your job is to reason about the visual/optical scene, not to diagnose and not to output vital values.
Distinguish tissue-like optical coupling, open flash, side-light leakage, global camera exposure changes, spatial/common-mode motion, pressure changes, static objects and insufficient evidence.
You may use only the supplied observation and tool results. A red scene is not proof of blood. Periodicity is not proof of perfusion.
Explicitly identify contradictions and predict what should be observed next. Abstain when evidence is insufficient.`;

const SKEPTIC_SYSTEM = `You are the Artifact Skeptic Agent for a smartphone contact-PPG research application.
Your goal is adversarial: try to explain the apparent physiological signal as motion, auto-exposure, lighting, filter ringing, stale samples, periodic external stimulus or an inert scene.
Do not output vital values. Do not accept a cardiac-band frequency as proof. Use tools, cite their results and state what observation would falsify your artifact hypothesis. Abstain when evidence is insufficient.`;

const ADJUDICATOR_SYSTEM = `You are the Measurement Adjudicator in SHADOW MODE.
You receive assessments from two independent agents and their tool traces. Reconcile disagreements without averaging scores.
You may mark a variable only POSSIBLY_OBSERVABLE, NOT_OBSERVABLE or UNASSESSED. You MUST NOT output BPM, SpO2, blood pressure or any numerical vital value. You MUST set mayPublishVitals=false.
Prefer abstention when current physical evidence, provenance or tool integrity is insufficient. Identify unresolved contradictions and request a discriminating observation when useful.`;

async function runAgent(
  agentId: AgentAssessment["agentId"],
  systemPrompt: string,
  packet: PhysiologicalObservationPacket,
  apiKey: string,
  model: string,
  includeImages: boolean,
): Promise<{ plan: AgentPlan; tools: ToolResult[]; assessment: AgentAssessment; latencyMs: number }> {
  const compact = compactPacket(packet);
  const planResponse = await callModel(
    apiKey,
    model,
    systemPrompt,
    `${PLAN_SCHEMA}\nAllowed tools: ${ALL_TOOLS.join(", ")}\nObservation summary:\n${JSON.stringify(compact)}`,
    includeImages ? packet.keyframes : [],
  );
  const plan = validatePlan(planResponse.parsed);
  if (plan.requestedTools.length === 0) {
    plan.requestedTools.push(
      { name: "inspect_window_integrity", reason: "minimum provenance check" },
      { name: "inspect_motion_contamination", reason: "minimum artifact check" },
    );
  }
  const tools = plan.requestedTools.map((request) => runTool(request.name, packet));
  const finalResponse = await callModel(
    apiKey,
    model,
    systemPrompt,
    `${ASSESSMENT_SCHEMA}\nObservation summary:\n${JSON.stringify(compact)}\nInitial plan:\n${JSON.stringify(plan)}\nTool results:\n${JSON.stringify(tools)}`,
    includeImages ? packet.keyframes : [],
  );
  return {
    plan,
    tools,
    assessment: validateAssessment(finalResponse.parsed, agentId, model, packet.observationId),
    latencyMs: planResponse.latencyMs + finalResponse.latencyMs,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) throw new Error("request body too large");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: userData, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");
    const model = Deno.env.get("PHYSIO_AGENT_MODEL") ?? "google/gemini-3-flash-preview";

    const body = await req.json();
    const packet = sanitizePacket(body?.observation ?? body);
    const startedAt = Date.now();

    const [optical, skeptic] = await Promise.all([
      runAgent("optical-scene-agent", OPTICAL_SYSTEM, packet, apiKey, model, true),
      runAgent("artifact-skeptic-agent", SKEPTIC_SYSTEM, packet, apiKey, model, false),
    ]);

    const adjudicationResponse = await callModel(
      apiKey,
      model,
      ADJUDICATOR_SYSTEM,
      `Return ONLY JSON with keys agreement, dominantExplanation, unresolvedContradictions, requestedObservation, abstain, observability, rationale, mayPublishVitals.\nObservation ID: ${packet.observationId}\nOptical assessment:\n${JSON.stringify(optical.assessment)}\nArtifact assessment:\n${JSON.stringify(skeptic.assessment)}\nTool traces:\n${JSON.stringify({ optical: optical.tools, skeptic: skeptic.tools })}`,
    );
    const adjudication = validateAdjudication(adjudicationResponse.parsed, packet.observationId);

    return new Response(JSON.stringify({
      mode: "shadow",
      model,
      sessionId: packet.sessionId,
      observationId: packet.observationId,
      agents: {
        opticalScene: optical.assessment,
        artifactSkeptic: skeptic.assessment,
      },
      adjudication,
      trace: {
        opticalPlan: optical.plan,
        opticalTools: optical.tools,
        skepticPlan: skeptic.plan,
        skepticTools: skeptic.tools,
        latencyMs: {
          optical: optical.latencyMs,
          skeptic: skeptic.latencyMs,
          adjudicator: adjudicationResponse.latencyMs,
          total: Date.now() - startedAt,
        },
      },
      analyzedAt: new Date().toISOString(),
      warning: "Research shadow output only. It cannot publish or replace live vital measurements.",
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("physiological-agent-orchestrator error:", message);
    const timeout = message.includes("aborted") || message.includes("timeout");
    return new Response(JSON.stringify({ error: timeout ? "AI model timeout" : message }), {
      status: timeout ? 504 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
