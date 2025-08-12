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

function buildSystemPrompt(assistantTurns) {
  return `
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
- Ask IN SMALL BATCHES: **1–2 questions per turn only**. Keep each turn short.
- Across turns, aim to cover as relevant: age; sex (and pregnancy/breastfeeding if relevant); onset & time course;
  location & character/quality; severity (0–10); triggers/relievers; associated symptoms; relevant history/meds/allergies;
  recent travel/exposures if relevant.
- You may ask at most one additional small batch (again 1–2 questions) if answers are incomplete.
- Do **not** list causes, treatments, or investigations until you have enough information — except if urgent red flags are detected.
- **Formatting rule for intake:** put the first question in "chat_reply". If you need a second, put it in "ask_back". Never exceed two total questions in a single turn.

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
- **For intake:** return at most two questions. Put the first in "chat_reply". If you need a second, put it in "ask_back"; otherwise leave "ask_back" empty.
- **For advice:** fill the structured fields below. Keep "chat_reply" to 2–3 short sentences and use bullets for lists.

Control
- assistant_turns_in_history = ${assistantTurns}.
- If assistant_turns_in_history >= 2: **switch to stage="advice" now** and do not ask more questions this turn.
`;
}

// enforce no more than 2 questions in the UI output
function enforceTwoQuestions(o) {
  let cr = String(o.chat_reply || "");
  let ab = String(o.ask_back || "");

  // If chat_reply contains more than one '?', split and move the second to ask_back
  const qParts = cr.split('?').map(s => s.trim()).filter(Boolean);
  if (qParts.length > 1) {
    cr = qParts[0] + '?';
    ab = ab || (qParts[1] ? qParts[1] + '?' : '');
  } else if (qParts.length === 1 && !cr.endsWith('?')) {
    // If it's clearly a question but missing '?', leave as-is.
  }

  // If ask_back contains multiple questions, keep only the first
  if ((ab.match(/\?/g) || []).length > 1) {
    ab = ab.split('?').map(s => s.trim()).filter(Boolean)[0] + '?';
  }

  o.chat_reply = cr;
  o.ask_back = ab;
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
  const adviceNow = assistantTurns >= 2;

  const baseMessages = [
    { role: "system", content: buildSystemPrompt(assistantTurns) },
    ...history,
    { role: "user", content: question }
  ];

  // 3) JSON schema (ask_back now OPTIONAL to avoid crashes)
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
    required: ["stage", "chat_reply"] // ask_back no longer required (prevents crash)
  };

  async function callOnce(forceAdvice = false) {
    const messages = forceAdvice
      ? [{ role: "system", content: 'CONTROL: Force advice now. Respond with stage="advice". Do not ask further questions this turn.' }, ...baseMessages]
      : baseMessages;

    const payload = {
      model: "gpt-4o-mini",
      input: messages,
      temperature: 0.2,
      max_output_tokens: 700,
      // Your account expects text.format
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

  // If we’re past 2 assistant turns but the model still didn’t switch to advice, force it once
  if ((!ok || !parsed || parsed.stage !== "advice") && adviceNow) {
    ({ ok, parsed, raw, status } = await callOnce(true));
  }

  if (!ok || !parsed) {
    return {
      statusCode: status || 502,
      body: JSON.stringify({ ok: false, error: raw?.error?.message || "OpenAI response could not be parsed.", raw })
    };
  }

  // Enforce max 2 questions in output
  parsed = enforceTwoQuestions(parsed);

  // Fill sensible defaults for advice if missing
  if (parsed.stage === "advice") {
    parsed.disclaimer = parsed.disclaimer || "General education only — not medical advice.";
    parsed.final_reminder = parsed.final_reminder || (parsed.when_to_seek_help || "Please see a doctor for personalised advice.");
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, result: parsed }) };
};
