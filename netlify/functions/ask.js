// netlify/functions/ask.js

// === knobs ===
const MAX_INTAKE_TURNS = 2;      // one short question per turn, then advice
const ADVICE_WORD_LIMIT = 200;   // concise advice target

const FRIENDLY_OPENER =
  "Just a reminder: I’m not a substitute for a clinician, so I can’t give specific medical advice. I can outline common causes, what clinicians often check, and practical things people sometimes do while waiting to be seen.";

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
  return clean.slice(-12);
}

// ---- topic inference (broad coverage) ----
function inferTopic(userText, history) {
  const txt = (history.map(h => h.content).join(" ") + " " + (userText || "")).toLowerCase();
  if (/\buric|urate|gout\b/.test(txt)) return "lab_test";
  if (/(tablet|pill|capsule|dose|vitamin|supplement|medicine|medication)\b/.test(txt)) return "vitamin_or_med";
  if (/\b(rash|itch|hives|urticaria|spots?)\b/.test(txt)) return "symptom_rash";
  if (/\b(headache|head ache|migraine)\b/.test(txt)) return "symptom_headache";
  if (/\b(stomach|tummy|belly|abd(omen|ominal)|epigastr)\b/.test(txt)) return "symptom_abdominal";
  if (/\b(height|tall|short|growth|stature|small for age|grow taller)\b/.test(txt)) return "growth_development";
  if (/\b(chest pain|breathless|shortness of breath|wheeze|asthma)\b/.test(txt)) return "symptom_cardioresp";
  if (/\bpregnan|pregnancy|pregnant|breastfeed|lactat/i.test(txt)) return "pregnancy_related";
  if (/\bhair\s*loss|shedding\b/.test(txt) && /\bfatigue|tired\b/.test(txt)) return "fatigue_hair";
  return "other";
}

// ---- red-flag detector to nudge urgent advice ----
function detectUrgency(userText) {
  const s = String(userText || "").toLowerCase();
  const patterns = [
    /severe chest pain|crushing chest|pain to left arm|shortness of breath|can't breathe/,
    /stroke|face droop|slurred speech|weakness one side/,
    /faint(ed|ing)|passed out|collapse/,
    /anaphylaxis|throat closing|lip swelling|hives all over|wheezing/,
    /suicid(al|e)|self[- ]harm|want to die/,
    /pregnan\w+.*(bleeding|severe pain|reduced movements)/,
    /high fever.*(confusion|rash)/,
    /major trauma|car crash|serious injury/,
  ];
  return patterns.some(rx => rx.test(s));
}

// --- topic-aware fallback (so we never send an empty bubble) ---
function fallbackQuestion(step, userText = "", topic = "other") {
  const Q = {
    vitamin_or_med: [
      "What’s the exact product and dose, and why are you taking it?",
      "How long have you been using it, and any side effects so far?"
    ],
    lab_test: [
      "Which test are you asking about and what was the number and unit (if you know)?",
      "Why was the test ordered, and have you had red, hot, very painful joints?"
    ],
    symptom_headache: [
      "When did the headache start—sudden or gradual?",
      "How severe is it (0–10), and any nausea or light sensitivity?"
    ],
    symptom_abdominal: [
      "When did the tummy pain start—sudden or gradual?",
      "Where is it (upper/lower/central/right/left), and how severe is it (0–10)?"
    ],
    symptom_rash: [
      "When did the rash start, and where on your body is it?",
      "Is it itchy, painful, or spreading, and do you have a fever?"
    ],
    symptom_cardioresp: [
      "When did the chest or breathing symptom start—sudden or gradual?",
      "What makes it better or worse (rest, activity, cold air, lying down)?"
    ],
    growth_development: [
      "How tall are you now, and roughly how much have you grown in the last 6–12 months?",
      "Have you started puberty changes yet (e.g., growth spurt, periods, voice change)? If you know, what are your parents’ heights?"
    ],
    pregnancy_related: [
      "How many weeks pregnant are you, and what symptoms are you noticing?",
      "Any bleeding, severe pain, or reduced baby movements?"
    ],
    fatigue_hair: [
      "Are your periods heavy or irregular, and have you had recent illness, stress, or big weight change?",
      "Do you follow a vegetarian/vegan diet or take any thyroid/iron-related medicines?"
    ],
    other: [
      "When did this start—sudden or gradual?",
      "How severe is it (0–10), and what makes it better or worse?"
    ]
  };
  const arr = Q[topic] || Q.other;
  const s = arr[Math.min(step, arr.length - 1)];
  return s.endsWith("?") ? s : s + "?";
}

// limit pain-scale questions to pain/itch/breath topics
function topicAllowsPainScale(topic) {
  return ["symptom_headache","symptom_abdominal","symptom_cardioresp","symptom_rash","other"].includes(topic);
}

// --- sanitize advice: remove dosing/imperatives; keep general tone ---
function sanitizeAdvice(text = "") {
  let t = String(text);

  // Strip explicit dosing / % / units
  t = t.replace(/\b\d+\s?(mg|mcg|g|ml|units?|%|mcL|mL|IU)\b/gi, "a doctor-directed dose");
  // Strip timed regimens (e.g., 15–20 minutes, 3x/day)
  t = t.replace(/\b\d+(\s?–|-| to )\d+\s?(minutes?|hours?|hrs?)\b/gi, "a short time");
  t = t.replace(/\b\d+\s?(minutes?|hours?|hrs?)\b/gi, "a short time");
  t = t.replace(/\b(\d+|one|two|three|four)\s?(x|times?)\/(day|night|week)\b/gi, "regularly as advised by a clinician");

  // De-imperativize common starts (line or bullet)
  t = t.replace(/(^|\n)\s*[-•]?\s*(Take|Use|Apply|Start|Stop|Begin|Increase|Decrease|Avoid|Ice|Elevate|Rest|Wear|Do)\b/gi,
                (m, pfx, verb) => `${pfx}• People sometimes ${verb.toLowerCase()}… (discuss with your clinician)`);

  // You should/need to → consider discussing
  t = t.replace(/\b(you (should|need to|must))\b/gi, "it may be worth discussing with your clinician whether you could");

  // Tighten whitespace
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

// --- build the system prompt (warmer opener; pathway advice) ---
function buildSystemPrompt(assistantTurns, topicHint, urgent) {
  return `
You are a conversational medical information assistant for general education.

Opener to include verbatim at the start of advice: "${FRIENDLY_OPENER}"

Safety & Scope
- Education only. You can make mistakes. Not a medical service, diagnosis, or treatment plan.
- Never give dosing, schedules, or prescriptive instructions. No brand/dose recommendations.
- Use non-directive language: “could”, “sometimes”, “worth discussing with your clinician”.
- If clear emergency red flags, prioritise an urgent-care warning with the reason.

Intake (short, topic-relevant)
- Infer topic_type from: ["growth_development","symptom_headache","symptom_abdominal","symptom_rash","symptom_cardioresp","vitamin_or_med","lab_test","pregnancy_related","fatigue_hair","other"].
- Use hint: topic_hint="${topicHint}".
- Ask **exactly ONE short question (<25 words)** per turn, tailored to topic_type.
- Do NOT ask 0–10 severity unless topic is pain/itch/breathing.
- Output during intake: put the single question in "chat_reply"; leave "ask_back" empty.

Advice (teach-back; personalised but not prescriptive; max ~${ADVICE_WORD_LIMIT} words)
- Begin with the provided opener sentence above.
- Then produce **advice_text** with this outline and headings:
  1) **Quick take** — recap using at least two specifics the user gave.
  2) **Don’t-miss to rule out** — 1–3 serious possibilities relevant to the topic and why.
  3) **What clinicians often do first** — focused history/exam plus typical tests (name them in plain English, e.g., CBC, ferritin/iron studies, TSH, B12/folate).
  4) **Causes that commonly fit** — 2–4 likely explanations linked to the user’s details.
  5) **Diet & day-to-day (comfort-only)** — 2–3 practical ideas with a short “why”.
  6) **What to bring/track** — up to 3 items that help the visit (logs, photos, med list).
  7) **Watch-outs (urgent)** — targeted red flags.
  8) **Next step** — one supportive line such as: “If symptoms persist, worsen, or you’re unsure, arranging a timely clinic visit with a qualified clinician is sensible.”
- Keep "chat_reply" to a **2–3 sentence intro**; place most content in "advice_text".

Output JSON
- stage: "intake" or "advice"
- topic_type
- chat_reply
- advice_text
- summary (1–2-line recap)
- info_gaps[] (things a clinician may ask/check)
- urgent_triggers[] (watch-outs)
- final_reminder (use the “Next step” style above)
- disclaimer (optional; you may include the opener again)

Control
- assistant_turns_in_history = ${assistantTurns}
- urgent_flag = ${urgent ? "true" : "false"}
- If urgent_flag is true → stage="advice" now with a clear urgent message.
- Else if assistant_turns_in_history < ${MAX_INTAKE_TURNS} → stage="intake".
- Else → stage="advice".
`;
}

// keep one relevant question; synthesize if empty or inappropriate
function enforceOneQuestion(o, step, userText, topic) {
  let q = (o.chat_reply || "").trim();
  const qm = q.indexOf("?");
  if (qm !== -1) q = q.slice(0, qm + 1);
  const mentionsScale = /0\s*(?:–|-|to)\s*10/.test(q) || /\b0-10\b/.test(q);
  if ((!q || !q.endsWith("?")) || (mentionsScale && !topicAllowsPainScale(topic))) {
    q = fallbackQuestion(step, userText, topic);
  }
  o.chat_reply = q;
  o.ask_back = "";
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
  const topicHint = inferTopic(question, history);
  const urgentFlag = detectUrgency(question);

  const baseMessages = [
    { role: "system", content: buildSystemPrompt(assistantTurns, topicHint, urgentFlag) },
    { role: "system", content: `CONTROL: topic_hint="${topicHint}". Ask ONE short question unless stage="advice".` },
    ...history,
    { role: "user", content: question }
  ];

  // 3) JSON schema
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      stage: { type: "string", enum: ["intake", "advice"] },
      topic_type: { type: "string" },
      disclaimer: { type: "string" },
      chat_reply: { type: "string" },
      advice_text: { type: "string" },
      summary: { type: "string" },
      info_gaps: { type: "array", items: { type: "string" } },
      urgent_triggers: { type: "array", items: { type: "string" } },
      final_reminder: { type: "string" }
    },
    required: ["stage", "chat_reply"]
  };

  async function callOnce(forceAdvice = false) {
    const messages = forceAdvice
      ? [{ role: "system", content: 'CONTROL: Respond with stage="advice" now. Produce advice_text (<= ' + ADVICE_WORD_LIMIT + ' words), non-prescriptive, tied to the user specifics, using the pathway template.' }, ...baseMessages]
      : baseMessages;

    const payload = {
      model: "gpt-4o-mini",
      input: messages,
      temperature: 0.2,
      max_output_tokens: 900,
      text: {
        format: {
          type: "json_schema",
          name: "MedQA_WarmTeachBack",
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

  // Force advice after MAX_INTAKE_TURNS or if urgent
  if ((!ok || !parsed || parsed.stage !== "advice") && (urgentFlag || assistantTurns >= MAX_INTAKE_TURNS)) {
    ({ ok, parsed, raw, status } = await callOnce(true));
  }

  // If still bad, return a safe intake Q so UI never blanks
  if (!ok || !parsed) {
    const step = Math.min(assistantTurns, MAX_INTAKE_TURNS - 1);
    const safe = {
      stage: urgentFlag ? "advice" : "intake",
      topic_type: topicHint,
      chat_reply: urgentFlag
        ? "This sounds potentially urgent. If you have severe pain, trouble breathing, fainting, or stroke-like symptoms, please seek urgent care now."
        : fallbackQuestion(step, question, topicHint),
      advice_text: urgentFlag ? `${FRIENDLY_OPENER}\n\nWatch-outs (urgent): chest pain, trouble breathing, one-sided weakness, heavy bleeding, signs of a severe allergic reaction. If these are present, using urgent care or emergency services is sensible.` : undefined,
      disclaimer: FRIENDLY_OPENER,
      final_reminder: "If symptoms persist, worsen, or you’re unsure, arranging a timely clinic visit with a qualified clinician is sensible."
    };
    return { statusCode: 200, body: JSON.stringify({ ok:true, result: safe, raw }) };
  }

  // Intake: enforce single, relevant question
  if (parsed.stage === "intake") {
    const topic = parsed.topic_type || topicHint;
    parsed = enforceOneQuestion(parsed, Math.min(assistantTurns, MAX_INTAKE_TURNS - 1), question, topic);
  }

  // Advice: ensure defaults + sanitize language
  if (parsed.stage === "advice") {
    parsed.disclaimer = FRIENDLY_OPENER;
    if (parsed.advice_text) parsed.advice_text = sanitizeAdvice(parsed.advice_text);
    if (!parsed.final_reminder || !parsed.final_reminder.trim()) {
      parsed.final_reminder = "If symptoms persist, worsen, or you’re unsure, arranging a timely clinic visit with a qualified clinician is sensible.";
    }
    // Guard against empty advice_text
    if (!parsed.advice_text || parsed.advice_text.trim().length < 40) {
      const watch = (parsed.urgent_triggers || []).slice(0,5);
      const gaps  = (parsed.info_gaps || []).slice(0,3);
      parsed.advice_text = sanitizeAdvice([
        "Quick take — based on what you shared, here’s a general picture.",
        "Don’t-miss to rule out — a few serious possibilities clinicians consider.",
        "What clinicians often do first — focused history/exam and common labs or scans.",
        watch.length ? `Watch-outs (urgent): ${watch.join("; ")}` : "",
        gaps.length ? `What to bring/track: ${gaps.join("; ")}` : "",
        parsed.final_reminder
      ].filter(Boolean).join("\n\n"));
    }
  }

  // Absolute safeguard: never return an empty chat_reply
  if (!parsed.chat_reply || !parsed.chat_reply.trim()) {
    parsed.stage = "intake";
    const topic = parsed.topic_type || topicHint;
    parsed.chat_reply = fallbackQuestion(Math.min(assistantTurns, MAX_INTAKE_TURNS - 1), question, topic);
  }

  return { statusCode: 200, body: JSON.stringify({ ok:true, result: parsed }) };
};
