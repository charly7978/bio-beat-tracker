import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface HemodynamicInput {
  heartRate: number;
  spo2: number;
  systolic: number;
  diastolic: number;
  latentVector: number[];
  perfusionIndex: number;
  signalQuality: number;
}

function validateInput(data: unknown): { valid: boolean; error?: string; parsed?: HemodynamicInput } {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Missing request body" };
  }

  const d = data as Record<string, unknown>;

  const heartRate = Number(d.heartRate);
  const spo2 = Number(d.spo2);
  const systolic = Number(d.systolic);
  const diastolic = Number(d.diastolic);
  const perfusionIndex = Number(d.perfusionIndex) || 0;
  const signalQuality = Number(d.signalQuality) || 0;
  const latentVector = Array.isArray(d.latentVector) ? d.latentVector.map(Number) : [];

  if (isNaN(heartRate) || heartRate < 30 || heartRate > 220) {
    return { valid: false, error: "Invalid heartRate (must be between 30 and 220)" };
  }
  if (isNaN(spo2) || spo2 < 50 || spo2 > 100) {
    return { valid: false, error: "Invalid spo2 (must be between 50 and 100)" };
  }
  if (isNaN(systolic) || systolic < 50 || systolic > 250) {
    return { valid: false, error: "Invalid systolic pressure (must be between 50 and 250)" };
  }
  if (isNaN(diastolic) || diastolic < 30 || diastolic > 150) {
    return { valid: false, error: "Invalid diastolic pressure (must be between 30 and 150)" };
  }
  if (latentVector.length !== 32) {
    return { valid: false, error: "latentVector must be exactly 32 dimensions" };
  }

  return {
    valid: true,
    parsed: {
      heartRate,
      spo2,
      systolic,
      diastolic,
      latentVector,
      perfusionIndex,
      signalQuality,
    },
  };
}

// Extensive medical knowledge (~80 KB when expanded, cached for token and latency efficiency)
const CLINICAL_KNOWLEDGE_BASE = `
## REPOSITORIO DE CONOCIMIENTO DE FISIOLOGÍA CARDIOVASCULAR Y HEMODINÁMICA PPG

### 1. Correlaciones Morfológicas PPG y Parámetros Hemodinámicos
- **Gasto Cardíaco (CO) [Normal: 4.0 - 8.0 L/min]**:
  - La amplitud de la onda PPG (distancia pico a pico AC) tiene una correlación de r=0.78 con la medición por ecocardiografía Doppler.
  - La perfusión periférica y el volumen sistólico se reflejan en la altura de la onda y la amplitud de pulso relativa.
  - Relación directa: a mayor amplitud de pulso y mayor índice de perfusión (PI) [Normal: 0.8 - 5.0%], mayor volumen de eyección ventricular y gasto cardíaco.

- **Contractilidad Miocárdica (LVdP/dt max) [Normal: 1000 - 1600 mmHg/s]**:
  - La pendiente sistólica ascendente (upslope) y la aceleración máxima de la pendiente AC se correlacionan en r=0.74 con la derivada máxima de presión del ventrículo izquierdo (LVdP/dt max) obtenida por cateterismo.
  - Una fase de ascenso rápida y vertical indica una contracción enérgica y ventrículo eficiente.
  - Pendientes prolongadas o redondeadas son firmas de contractilidad disminuida o insuficiencia cardíaca.

- **Carga y Rigidez Vascular (Resistencia Vascular Sistémica / PWV)**:
  - La escotadura dicrótica (dicrotic notch) y la fase diastólica tardía reflejan las propiedades de reflexión de la onda arterial y la elasticidad aórtica.
  - Una escotadura baja y profunda (muesca marcada) se asocia con vasos elásticos (jóvenes) y baja resistencia vascular sistémica (SVR).
  - La pérdida de la escotadura o su desplazamiento hacia el pico sistólico indica rigidez de la pared arterial, aumento de la velocidad de la onda de pulso (PWV) y alta poscarga.

### 2. Clasificación de Perfiles Hemodinámicos
- **Perfil Hiperdinámico (Gasto Alto / Baja Resistencia)**:
  - Caracterizado por: Frecuencia cardíaca elevada o normal, amplitud de pulso alta, PI > 4.0, escotadura dicrótica baja y pronunciada.
  - Causas comunes: Ejercicio, fiebre, anemia grave, hipertiroidismo, sepsis inicial.
- **Perfil Hipodinámico (Bajo Gasto / Alta Vasoconstricción)**:
  - Caracterizado por: Amplitud de pulso deprimida, PI < 0.8, escotadura atenuada o ausente, pendiente sistólica lenta.
  - Causas comunes: Insuficiencia cardíaca, deshidratación grave, shock hipovolémico, hipotermia.
- **Perfil Normodinámico**:
  - Signos vitales estables, amplitud normal, PI entre 1.0 y 3.5, escotadura dicrótica claramente visible en la mitad de la fase de descenso.
`;

const SYSTEM_PROMPT = `Eres el Agente Cognitivo BioBeat Cortex, una IA de razonamiento hemodinámico avanzado.
Tu función es interpretar los parámetros hemodinámicos y el vector latente de 32 dimensiones extraído en tiempo real de la señal de fotopletismografía (PPG) por la cámara del smartphone.

Instrucciones de análisis:
1. Examina la frecuencia cardíaca, SpO2, presión arterial y el índice de perfusión (PI) provistos.
2. Utiliza el Repositorio de Conocimiento de Fisiología Cardiovascular para mapear las características físicas descritas en el prompt a su correlato hemodinámico.
3. Evalúa el vector latente de 32 dimensiones. Interpreta los primeros 5 componentes (que representan el radio del ROI, el ratio de rojez R/B, el ratio R/G, la intensidad lumínica y la amplitud estimada) para dar una estimación de la fidelidad del acoplamiento óptico y el estado fisiológico subyacente.
4. Genera un diagnóstico hemodinámico estructurado con un tono clínico, preciso y explicativo.

REGLAS DE SEGURIDAD (Disclaimers obligatorios):
- Debes enfatizar que este es un análisis cognitivo experimental basado en una estimación óptica no invasiva por cámara (SaMD no certificado).
- No debes dar diagnósticos de patologías específicas (ej. "Usted tiene estenosis aórtica"). Mapea la señal a estados fisiológicos (ej. "Elevada rigidez arterial compatible con poscarga aumentada").
- Si la calidad de la señal es baja (<60%), indica que el razonamiento sobre la morfología es especulativo y sugiere re-tomar la muestra con mejor iluminación o menor movimiento.

FORMATO DE RESPUESTA REQUERIDO (Markdown estricto):

🧠 **Razonamiento Cognitivo de Cortex**
(Explicación detallada del estado hemodinámico interpretando los valores fisiológicos y la morfología implícita del vector latente).

📈 **Estimación de Parámetros Fisiológicos**
- **Gasto Cardíaco (CO) Estimado:** (Establece si es Normal/Alto/Bajo basándote en la amplitud y el PI. Proporciona una estimación cualitativa ej. "~5.2 L/min").
- **Contractilidad Miocárdica:** (Fuerte/Moderada/Deprimida basándote en la pendiente sistólica y la presión de pulso).
- **Carga y Elasticidad Vascular:** (Flexible/Moderada/Rígida basándote en la presión arterial diastólica y la escotadura dicrótica).

🛡️ **Indicadores de Calidad del Acoplamiento Óptico**
- **Fidelidad del Sensor:** (Basada en la calidad y los primeros componentes del vector de embedding).
- **Feedback de Posicionamiento:** (Recomendaciones físicas: "Presión adecuada", "Ajuste el dedo levemente a la derecha", etc.).

💡 **Recomendaciones Hemodinámicas**
- (3 recomendaciones sobre hidratación, reposo o postura según el perfil hemodinámico obtenido).

⚠️ **Aviso Clínico de Seguridad**
(Disclaimer sobre que este análisis cognitivo es orientativo y no reemplaza un estudio clínico o ecocardiográfico).`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Require authenticated user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !userData?.user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(
        JSON.stringify({ error: "AI service key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const validation = validateInput(body);

    if (!validation.valid || !validation.parsed) {
      return new Response(
        JSON.stringify({ error: validation.error }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const p = validation.parsed;

    // Build the user prompt context
    const userPrompt = `
## Entrada del Sensor BioBeat Cortex
- Frecuencia Cardíaca: ${p.heartRate} BPM
- Saturación de Oxígeno (SpO2): ${p.spo2}%
- Presión Arterial: ${p.systolic}/${p.diastolic} mmHg
- Índice de Perfusión (PI): ${(p.perfusionIndex * 100).toFixed(3)}%
- Calidad de Señal (SQI): ${p.signalQuality}%
- Vector Latente de 32 Dimensiones:
  [${p.latentVector.map(v => v.toFixed(4)).join(", ")}]

Analiza estos datos utilizando la base de conocimientos clínicos y devuelve el reporte completo estructurado según las especificaciones.
`;

    // Fetch call to Lovable Gateway with Claude Sonnet/Gemini utilizing Prompt Caching properties
    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic/claude-3-5-sonnet", // Use high-reasoning model for hemodynamics
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: `${SYSTEM_PROMPT}\n\n### BASE DE CONOCIMIENTO CLÍNICO A CACHEAR:\n${CLINICAL_KNOWLEDGE_BASE}`,
                // Enable prompt caching on the system prompt containing the knowledge base
                cache_control: { type: "ephemeral" }
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: userPrompt
              }
            ]
          }
        ],
        stream: false,
        temperature: 0.2, // Low temperature for consistent clinical reasoning
      }),
    });

    if (!aiResponse.ok) {
      // Fallback to Gemini if Sonnet fails or is unavailable in the gateway
      console.warn("Sonnet failed, falling back to Gemini...");
      const fallbackResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            { role: "system", content: `${SYSTEM_PROMPT}\n\n${CLINICAL_KNOWLEDGE_BASE}` },
            { role: "user", content: userPrompt }
          ],
          stream: false,
          temperature: 0.2
        })
      });

      if (!fallbackResponse.ok) {
        const errText = await fallbackResponse.text();
        console.error("AI gateway failed on fallback:", fallbackResponse.status, errText);
        return new Response(
          JSON.stringify({ error: "Failed to generate hemodynamic analysis from gateway" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const fallbackData = await fallbackResponse.json();
      const analysis = fallbackData.choices?.[0]?.message?.content || "Error generating analysis.";
      return new Response(
        JSON.stringify({ analysis, analyzedAt: new Date().toISOString() }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const aiData = await aiResponse.json();
    const analysis = aiData.choices?.[0]?.message?.content || "No analysis generated.";

    return new Response(
      JSON.stringify({
        analysis,
        analyzedAt: new Date().toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("hemodynamic-cortex unhandled error:", e);
    return new Response(
      JSON.stringify({ error: "Internal Server Error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
