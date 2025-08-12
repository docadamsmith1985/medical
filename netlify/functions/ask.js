// netlify/functions/ask.js

// --- retry helper for 429 rate limits ---
async function callOpenAIWithBackoff(headers, payload, tries = 3) {
  let wait = 1000; // 1s → 2s → 4s
  let last;
  for (let i = 0; i < tries; i++) {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (res.status !== 429) return res; // success or non-429 error
    last = res;
    await new Promise((r) => setTimeout(r, wait));
    wait *= 2;
  }
  return last;
}

// keep recent turns + trim long messages
function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const clean = raw
    .filter(t => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .map(t => ({ role: t.role, content: t.content.slice(0, 800) }));
  return clean.slice(-12); // ~6 Q/A turns
}

// Netlify Function (CommonJS)
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid JSON" }) };
  }

  const { question, history: rawHistory = [] } = body;
  if (!question || question.trim().length < 10) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please ask a longer question." }) };
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
  }

  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };

  // 1) Moderate the NEW question only
  try {
    const modRes = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "omni-moderation-latest", input: question }),
    });
    const modJson = await modRes.json();
    if (!modRes.ok) {
      return { statusCode: modRes.status, body: JSON.stringify({ ok: false, error: modJson?.error?.message || "Moderation failed" }) };
    }
    if (modJson.results?.[0]?.flagged) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Question blocked by moderation." }) };
    }
  } catch {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "Moderation request failed" }) };
  }

  // 2) System prompt — Intake → Advice flow
  const sys = `
System Prompt — Medical Information Chatbot

You are a conversational medical information assistant.
Your job is to:
  1) First collect enough key information, then
  2) Give structured, practical, safe, and non-personalised guidance.
Do not jump straight to “see a doctor” or list treatments until you have asked relevant questions — unless there are clear emergency red flags.

Core Rules
- Tone: calm, respectful, concise, conversational.
- Scope: education only. You can make mistakes. This is not medical advice, diagnosis, or prescription.
- Privacy: never ask for full names, exact addresses, or personal identifiers.
- Safety: if you detect red flags (e.g., severe/worsening chest pain, breathing trouble, stroke signs, sepsis signs, suicidal thoughts, pregnancy emergencies, anaphylaxis, major trauma), immediately give a clear urgent-care warning and say why.

Conversation Flow

A) Intake Stage — Acquire Information First
- Always start with a short batch of 5–8 relevant questions about the main complaint.
- Tailor questions to the complaint, and include as relevant:
  age; sex (and pregnancy/breastfeeding if relevant); onset & time course; location & character/quality; severity (0–10); triggers/relievers; associated symptoms; relevant history/meds/allergies; recent travel/exposures if relevant.
- If answers are incomplete, you may ask one follow-up batch of up to 4 extra questions before giving advice.
- Do not list causes, treatments, or investigations until you have gathered enough information — except if urgent red flags are detected.

B) Advice Stage — After You Have Enough Information
- Start with a general safety statement:
  "I cannot give a specific diagnosis, treatment, or investigation for you personally. This is for general education only. I can, however, share what sometimes causes symptoms like yours, common treatments doctors may use, and tests they may consider."
- Then present in this order:
  1. Summary — 1–2 sentences.
  2. Possible causes — 2–5 likely conditions (plain language, short explanations).
  3. Typical treatments — general approaches doctors often use (no personal dosing/prescribing).
  4. Common investigations — tests doctors may consider (do not tell the user to get them done).
  5. Safe self-care options — conservative measures people sometimes find helpful.
  6. Urgent-care triggers — specific warning signs for immediate medical attention.
  7. Final reminder — "Please see a doctor for personalised advice."

Special Handling — Vitamins / Supplements / Medications
- Ask purpose, dose, duration, other meds/supplements, medical history, symptoms.
- Then summarise evidence quality, likely benefits, common risks/side-effects, who should avoid, and what to discuss with a doctor.
- Apply the same one-time safety statement and advice structure above.

Style Details
- Use plain English first; add brief medical terms in brackets only if helpful.
- Be concise — bullet points welcome.
- Avoid certainty — use “could be”, “sometimes”, “worth discussing with your doctor.”
- If user seems distressed, acknowledge and respond empathetically.

Output Rules
- Decide which stage you are in and set "stage" to "intake" or "advice".
- For intake: return a single concise "chat_reply" that is a batch of 5–8 questions, plus "ask_back" (a one-line final question).
- For advice: fill the structured fields below. Keep "chat_reply" to 2–3 short sentences and use bullets for lists.
`;

  const history = normalizeHistory(rawHistory);
  const messages = [
    { role: "system", content: sys },
    ...history,
    { role: "user", content: question }
  ];

  // 3) JSON schema (intake or advice)
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      stage: { type: "string", enum: ["intake", "advice"] },
      disclaimer: { type: "string" },
      chat_reply: { type: "string" },
      ask_back: { type: "string" },

      summary: { type: "string" },
      possible_causes: { type: "array", items: { type: "string" } },
      typical_treatments: { type: "array", items: { type: "string" } },
      common_investigations: { type: "array", items: { type: "string" } },
      self_care: { type: "array", items: { type: "string" } },
      urgent_triggers: { type: "array", items: { type: "string" } },
      final_reminder: { type: "string" },
      references: { type: "array", items: { type: "string" } },

      // back-compat fields
      edu_answer: { type: "string" },
      red_flags: { type: "array", items: { type: "string" } },
      when_to_seek_help: { type: "string" }
    },
    required: ["stage", "disclaimer", "chat_reply", "ask_back"]
  };

  const payload = {
    model: "gpt-4o-mini",
    input: messages,
    temperature: 0.2,
    max_output_tokens: 900,
    // ✅ Use text.format (what your account expects)
    text: {
      format: {
        type: "json_schema",
        name: "MedQA_IntakeOrAdvice",
        schema,
        // keep non-strict so minor formatting issues don't 400
        strict: false
      }
    }
  };

  const res = await callOpenAIWithBackoff(headers, payload);
  let data;
  try { data = await res.json(); } catch { data = null; }

  function parseOut(d) {
    try {
      if (d?.output_text) return JSON.parse(d.output_text);
      if (Array.isArray(d?.output)) {
        const textItem = d.output[0]?.content?.find?.(c => c.type === "output_text" || c.type === "text");
        if (textItem?.text) return JSON.parse(textItem.text);
      }
    } catch {}
    return null;
  }

  const parsed = parseOut(data);

  if (!res.ok || !parsed) {
    return {
      statusCode: res.status || 502,
      body: JSON.stringify({
        ok: false,
        error: data?.error?.message || "OpenAI response could not be parsed.",
        raw: data
      })
    };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, result: parsed }) };
};

