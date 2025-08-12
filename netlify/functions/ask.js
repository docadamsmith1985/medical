// netlify/functions/ask.js

// --- retry helper for 429 rate limits ---
async function callOpenAIWithBackoff(headers, payload, tries = 3) {
  let wait = 1000, last;
  for (let i = 0; i < tries; i++) {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (res.status !== 429) return res;
    last = res;
    await new Promise(r => setTimeout(r, wait));
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

// --- system prompt builder (one question per turn, advice after 3 turns) ---
function buildSystemPrompt(assistantTurns) {
  return `
System Prompt — Medical Information Chatbot

You are a conversational medical information assistant.
1) First collect key information, then 2) give structured, practical, safe, non-personalised guidance.
Do not jump straight to “see a doctor” or list treatments until you have asked relevant questions —
unless there are clear emergency red flags.

Core Rules
- Tone: calm, respectful, concise, conversational.
- Scope: education only. You can make mistakes. This is not medical advice, diagnosis, or prescription.
- Privacy: never ask for full names, exact addresses, or personal identifiers.
- Safety: if you detect red flags (e.g., severe/worsening chest pain, breathing trouble, stroke signs, sepsis signs,
  suicidal thoughts, pregnancy emergencies, anaphylaxis, major trauma), immediately give a clear urgent-care warning and say why.

Conversation Flow

A) Intake — Acquire Information First
- Ask IN MICRO BATCHES: **exactly ONE question per turn** (no more than one).
- Across the first few turns, aim to cover as relevant: age; sex (pregnancy/breastfeeding if relevant); onset & time course;
  location & character/quality; severity (0–10); triggers/relievers; associated symptoms; relevant history/meds/allergies;
  recent travel/exposures if relevant.
- Do **not** list causes, treatments, or investigations until enough info is gathered — except if urgent red flags are detected.
- **Formatting rule for intake:** put your single question in "chat_reply". Leave "ask_back" empty.

B) Advice — After You Have Enough Information
- Start with a general safety statement:
  "I cannot give a specific diagnosis, treatment, or investigation for you personally. This is for general education only.
   I can, however, share what sometimes causes symptoms like yours, common treatments doctors may use, and tests they may consider."
- Then present in this order (bullets welcome, concise):
  1. Summary — 1–2 sentences.
  2. Possible causes — 2–5 likely conditions (plain language, short explanations).
  3. Typical treatments — general approaches doctors often use (no personal dosing/prescribing).
  4. Common investigations — tests doctors may consider (do not tell the user to get them done).
  5. Safe self-care options — conservative measures people sometimes find helpful.
  6. Urgent-care triggers — specific warning signs for immediate medical attention.
  7. Final reminder — "Please see a doctor for personalised advice."

Special Handling — Vitamins/Supplements/Medicines
- Ask purpose, dose, duration, other meds/supplements, history, and symptoms; then summarise evidence, benefits, risks,
  who should avoid, and what to discuss with a doctor; use the same advice structure.

Style Details
- Plain English first; brief medical terms in brackets only if helpful.
- Be concise; avoid certainty (“could be”, “sometimes”, “worth discussing with your doctor”).
- If user seems distressed, acknowledge and be empathetic.

Output Rules
- Set "stage" to "intake" or "advice".
- Intake turn: **one question only** → put it in "chat_reply"; leave "ask_back" "".
- Advice turn: fill the structured fields; keep "chat_reply" to 2–3 short sentences.

Control
- assistant_turns_in_history = ${assistantTurns}.
- If assistant_turns_in_history < 3 and no clear emergency: you are in stage="intake" and must ask exactly one question.
- If assistant_turns_in_history >= 3 OR you detect clear emergency red flags: respond with stage="advice" now (no further questions this turn).
`;
}

// ensure exactly one question shown to the user
function enforceOneQuestion(o) {
  let q = (o.chat_reply || "").trim();

  // If model sneaks multiple questions, keep only up to first '?'
  const idx = q.indexOf("?");
  if (idx !== -1) q = q.slice(0, idx + 1);

  // Remove any leftover question(s) from ask_back
  o.chat_reply = q;
  o.ask_back = ""; // intake uses only chat_reply
  return o;
}

// -------------------- Netlify handler --------------------
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ ok:false, error:"Invalid JSON" }) }; }

  const { question, history: rawHistory = [] } = body;
  if (!question || question.trim().length < 10) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please ask a longer question." }) };
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
  }

  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" };

  // 1) Moderate the NEW question only
  try {
    const modRes = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "omni-moderation-latest", input: question }),
    });
    const modJson = await modRes.json();
    if (!modRes.ok) {
      return { statusCode: modRes.status, body: JSON.stringify({ ok:false, error: modJson?.error?.message || "Moderation failed" }) };
    }
    if (modJson.results?.[0]?.flagged) {
      return { statusCode: 400, body: JSON.stringify({ ok:false, error: "Question blocked by moderation." }) };
    }
  } catch {
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: "Moderation request failed" }) };
  }

  // 2) Build conversation
  const history = normalizeHistory(rawHistory);
  const assistantTurns = history.filter(t => t.role === "assistant").length;

  const baseMessages = [
    { role: "system", content: buildSystemPrompt(assistantTurns) },
    ...history,
    { role: "user", content: question }
  ];

  // 3) JSON schema (ask_back OPTIONAL)
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

      // back-compat
      edu_answer: { type: "string" },
      red_flags: { type: "array", items: { type: "string" } },
      when_to_seek_help: { type: "string" }
    },
    required: ["stage", "chat_reply"]
  };

  async function callOnce(forceAdvice = false) {
    const messages = forceAdvice
      ? [{ role: "system", content: 'CONTROL: If no clear emergency, respond with stage="advice" now. Do not ask more questions this turn.' }, ...baseMessages]
      : baseMessages;

    const payload = {
      model: "gpt-4o-mini",
      input: messages,
      temperature: 0.2,
      max_output_tokens: 750,
      // Your account expects text.format for structured output
      text: {
        format: {
          type: "json_schema",
          name: "MedQA_IntakeOrAdvice",
          schema,
          strict: false
        }
      }
    };

    const res = await callOpenAIWithBackoff(headers, payload);
    let data; try { data = await res.json(); } catch { data = null; }

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

    return { ok: res.ok, parsed: parseOut(data), raw: data, status: res.status };
  }

  // First attempt
  let { ok, parsed, raw, status } = await callOnce(false);

  // Force advice if we've already asked 3 intake turns and model still hasn't switched
  if ((!ok || !parsed || parsed.stage !== "advice") && assistantTurns >= 3) {
    ({ ok, parsed, raw, status } = await callOnce(true));
  }

  if (!ok || !parsed) {
    return {
      statusCode: status || 502,
      body: JSON.stringify({ ok:false, error: raw?.error?.message || "OpenAI response could not be parsed.", raw })
    };
  }

  // Enforce exactly one question during intake
  if (parsed.stage === "intake") parsed = enforceOneQuestion(parsed);

  // Fill defaults for advice
  if (parsed.stage === "advice") {
    parsed.disclaimer = parsed.disclaimer || "General education only — not medical advice.";
    parsed.final_reminder = parsed.final_reminder || (parsed.when_to_seek_help || "Please see a doctor for personalised advice.");
  }

  return { statusCode: 200, body: JSON.stringify({ ok:true, result: parsed }) };
};
