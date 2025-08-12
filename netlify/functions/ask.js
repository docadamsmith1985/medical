// netlify/functions/ask.js

// === knobs ===
const MAX_INTAKE_TURNS = 2; // ask 1 short question per turn, then switch to advice (change to 3 if you want one more)

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
    last = res; await new Promise(r => setTimeout(r, wait)); wait *= 2;
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

// --- topic aware fallback so we never send an empty bubble ---
function fallbackQuestion(step, userText = "", topic = "") {
  const base = String(userText || "").toLowerCase();
  const t = topic || (
    /\buric|urate|gout/.test(base) ? "lab_test" :
    /(tablet|pill|capsule|dose|vitamin|supplement|medicine|medication)/.test(base) ? "vitamin_or_med" :
    /\brash|itch|hives|spots?/.test(base) ? "symptom_rash" :
    /\b(headache|head ache|migraine)\b/.test(base) ? "symptom_headache" :
    /\b(stomach|tummy|belly|abd(omen|ominal)|epigastr)/.test(base) ? "symptom_abdominal" :
    "other"
  );

  const Q = {
    vitamin_or_med: [
      "What’s the exact product and dose, and why are you taking it?",
      "How long have you been using it, and any side effects so far?",
      "Do you take other meds or supplements, and do you have any medical conditions or allergies?"
    ],
    lab_test: [
      "What test are you asking about and what was the number and unit (if you have it)?",
      "Why was the test done, and have you had symptoms like joint pain, swelling, or kidney issues?",
      "When was the last test, and do you take any medicines that could affect it?"
    ],
    symptom_headache: [
      "When did the headache start—sudden or gradual?",
      "How severe is it (0–10), and any nausea, light sensitivity, or vision changes?",
      "Where is it exactly (front/one side/behind an eye/whole head), and what does it feel like?"
    ],
    symptom_abdominal: [
      "When did the stomach pain start—sudden or gradual?",
      "Where is it (upper/lower/central/right/left), and how severe is it (0–10)?",
      "Is it sharp, crampy, or burning, and does it move or stay in one spot?"
    ],
    symptom_rash: [
      "When did the rash start, and where on your body is it most noticeable?",
      "Is it itchy, painful, or spreading, and do you have a fever?",
      "Any new soaps, creams, detergents, foods, meds, or insect bites before it started?"
    ],
    other: [
      "When did this start—sudden or gradual?",
      "How severe is it (0–10), and what makes it better or worse?",
      "Where exactly is it, and what does it feel like?"
    ]
  };

  const arr = Q[t] || Q.other;
  const s = arr[Math.min(step, arr.length - 1)];
  return s.endsWith("?") ? s : s + "?";
}

// --- system prompt (topic-aware; one question/turn; advice after MAX_INTAKE_TURNS; personalised advice) ---
function buildSystemPrompt(assistantTurns) {
  return `
You are a conversational medical information assistant.

Goal
1) First collect key information, then 2) give structured, practical, safe, non-personalised guidance.
Do not jump straight to “see a doctor” or list treatments until you have asked relevant questions—unless emergency red flags.

Core Rules
- Tone: calm, respectful, concise, conversational.
- Scope: education only. You can make mistakes. Not medical advice, diagnosis, or prescription.
- Privacy: never ask for full names, exact addresses, or personal identifiers.
- Safety: if you detect red flags (e.g., severe/worsening chest pain, breathing trouble, stroke signs, sepsis signs, suicidal thoughts, pregnancy emergencies, anaphylaxis, major trauma), give a clear urgent-care warning and say why.

Topic & Flow
- First, infer a topic_type: one of
  ["symptom","vitamin_or_med","lab_test","chronic_condition","lifestyle","admin","other"].
- Intake: ask **exactly ONE short question (<25 words)** per turn, tailored to topic_type.
  Across the first few turns, aim to cover (as relevant): age; sex (pregnancy/breastfeeding if relevant); onset/time course;
  location & character; severity (0–10); triggers/relievers; associated symptoms; relevant history/meds/allergies; exposures.
  Output for intake = put the single question in "chat_reply". Leave "ask_back" empty.
- Advice: after enough info, start with this safety statement:
  "I cannot give a specific diagnosis, treatment, or investigation for you personally. This is for general education only.
   I can, however, share what sometimes causes symptoms like yours, common treatments doctors may use, and tests they may consider."
  Then provide (concise, tie points to the user's details):
   1) summary; 2) possible_causes (2–5); 3) typical_treatments; 4) common_investigations;
   5) self_care; 6) urgent_triggers; 7) final_reminder ("Please see a doctor for personalised advice.").

Style
- Plain English first; brief medical terms in brackets only if helpful. Avoid certainty (“could be”, “sometimes”).
- Be empathetic if the user sounds distressed.

Output JSON
- stage: "intake" or "advice"
- topic_type: from the list above
- chat_reply: string (for intake: single short question; for advice: 2–3 sentence intro)
- ask_back: string (usually empty during intake)
- summary, possible_causes[], typical_treatments[], common_investigations[], self_care[], urgent_triggers[], final_reminder, references[]

Control
- assistant_turns_in_history = ${assistantTurns}
- If assistant_turns_in_history < ${MAX_INTAKE_TURNS} and no emergency → stage="intake".
- If assistant_turns_in_history ≥ ${MAX_INTAKE_TURNS} OR emergency red flags → stage="advice" now (no questions this turn).
- Never output more than ONE question in a single intake turn.
`;
}

// keep only one question and ensure it ends with '?'
function enforceOneQuestion(o, step, userText) {
  let q = (o.chat_reply || "").trim();
  const qm = q.indexOf("?");
  if (qm !== -1) q = q.slice(0, qm + 1);
  if (!q || !q.endsWith("?")) q = fallbackQuestion(step, userText, o.topic_type || "");
  o.chat_reply = q;
  o.ask_back = ""; // intake uses only one question
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
  // allow very short replies like "7/10"
  if (!question || question.trim().length < 2) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please add a bit more detail." }) };
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
      topic_type: { type: "string" },
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

      // legacy (safe to ignore)
      edu_answer: { type: "string" },
      red_flags: { type: "array", items: { type: "string" } },
      when_to_seek_help: { type: "string" }
    },
    required: ["stage", "chat_reply"]
  };

  async function callOnce(forceAdvice = false) {
    const messages = forceAdvice
      ? [{ role: "system", content: 'CONTROL: Respond with stage="advice" now. Do not ask further questions this turn unless there are immediate emergency red flags.' }, ...baseMessages]
      : baseMessages;

    const payload = {
      model: "gpt-4o-mini",
      input: messages,
      temperature: 0.2,
      max_output_tokens: 900,
      // Responses API → use text.format
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

  // Force advice after MAX_INTAKE_TURNS if model didn't switch
  if ((!ok || !parsed || parsed.stage !== "advice") && assistantTurns >= MAX_INTAKE_TURNS) {
    ({ ok, parsed, raw, status } = await callOnce(true));
  }

  // If still bad, return a safe intake question so UI never blanks
  if (!ok || !parsed) {
    const step = Math.min(assistantTurns, MAX_INTAKE_TURNS - 1);
    const safe = {
      stage: "intake",
      topic_type: "other",
      chat_reply: fallbackQuestion(step, question),
      disclaimer: "General education only — not medical advice."
    };
    return { statusCode: 200, body: JSON.stringify({ ok:true, result: safe, raw }) };
  }

  // Intake: enforce single, non-empty question
  if (parsed.stage === "intake") {
    parsed = enforceOneQuestion(parsed, Math.min(assistantTurns, MAX_INTAKE_TURNS - 1), question);
  }

  // Advice: ensure defaults and a brief intro
  if (parsed.stage === "advice") {
    parsed.disclaimer = parsed.disclaimer || "General education only — not medical advice.";
    if (!parsed.chat_reply || !parsed.chat_reply.trim()) {
      parsed.chat_reply = "Here’s a general overview based on what you’ve shared.";
    }
  }

  // Absolute safeguard: never return an empty chat_reply
  if (!parsed.chat_reply || !parsed.chat_reply.trim()) {
    parsed.stage = "intake";
    parsed.chat_reply = fallbackQuestion(Math.min(assistantTurns, MAX_INTAKE_TURNS - 1), question, parsed.topic_type);
  }

  return { statusCode: 200, body: JSON.stringify({ ok:true, result: parsed }) };
};
