// netlify/functions/ask.js

// === knobs ===
const MIN_INTAKE_TURNS = 2;      // must ask at least 2 questions (one per message)
const MAX_INTAKE_TURNS = 3;      // may ask a 3rd if basics still missing
const ADVICE_WORD_LIMIT = 200;   // concise advice target (both modes)

// Warm opener used at the start of every advice message
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

// ---- mode & topic inference ----
function inferModeAndTopic(userText, history) {
  const txt = (history.map(h => h.content).join(" ") + " " + (userText || "")).toLowerCase();

  // Mode
  const isClinical =
    /\b(i|i'm|im|my|me|mine|i have|i feel|i got|i am)\b/.test(txt) ||
    /\b(headache|pain|rash|fever|cough|vomit|diarrhea|tummy|bleed|dizzy|shortness of breath|breathless|wheeze|itch|swelling)\b/.test(txt);

  const mode = isClinical ? "clinical" : "general";

  // Topic (broad buckets used for tailored intake questions)
  let topic = "other";
  if (/\buric|urate|gout\b/.test(txt)) topic = "lab_test";
  else if (/(tablet|pill|capsule|dose|vitamin|supplement|medicine|medication)\b/.test(txt)) topic = "vitamin_or_med";
  else if (/\b(rash|itch|hives|urticaria|spots?)\b/.test(txt)) topic = "symptom_rash";
  else if (/\b(headache|head ache|migraine)\b/.test(txt)) topic = "symptom_headache";
  else if (/\b(stomach|tummy|belly|abd(omen|ominal)|epigastr)\b/.test(txt)) topic = "symptom_abdominal";
  else if (/\b(chest pain|breathless|shortness of breath|wheeze|asthma)\b/.test(txt)) topic = "symptom_cardioresp";
  else if (/\b(height|tall|short|growth|stature|grow taller|small for age)\b/.test(txt)) topic = "growth_development";
  else if (/\bpregnan|pregnant|breastfeed|lactat/i.test(txt)) topic = "pregnancy_related";
  else if (/\bhair\s*loss|shedding\b/.test(txt) && /\bfatigue|tired\b/.test(txt)) topic = "fatigue_hair";
  else if (/\bwine|alcohol\b/.test(txt)) topic = "general_wine";
  else if (/\bdiabetes\b/.test(txt) && !isClinical) topic = "general_diabetes";
  else if (/\b(taller|height increase|grow taller)\b/.test(txt) && !isClinical) topic = "general_height";

  return { mode, topic };
}

// ---- detect product-specific asks (brands) ----
function detectProductSpecific(userText) {
  const s = String(userText || "");
  // crude brand/product cues: trademark symbols, CapitalizedWord™/®, ALLCAPS strings, or "brand"/"product" mentions
  return /[\u2122\u00AE]|brand\b|product\b/.test(s.toLowerCase()) ||
         /[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,2}/.test(s); // capitalized chunks (heuristic)
}

// ---- crude red-flag detector (clinical only) ----
function detectUrgency(userText) {
  const s = String(userText || "").toLowerCase();
  const patterns = [
    /severe chest pain|crushing chest|pain to left arm|shortness of breath|can't breathe|trouble breathing/,
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

// --- topic & mode aware fallback (so we never send an empty bubble) ---
function fallbackQuestion(step, userText = "", mode = "clinical", topic = "other") {
  if (mode === "general") {
    const G = [
      "What exactly are you most curious about — benefits, risks, or what good studies say?",
      "Are you asking for yourself or general interest, and what outcome matters most (energy, sleep, heart health, etc.)?",
      "Which specific type or example do you mean (if any)?"
    ];
    return (G[Math.min(step, G.length - 1)] + "?").replace(/\?\?+$/, "?");
  }

  const Q = {
    vitamin_or_med: [
      "What’s the exact product and dose, and why are you taking it?",
      "How long have you been using it, and any side effects so far?",
      "Do you take other meds/supplements or have any conditions we should keep in mind?"
    ],
    lab_test: [
      "Which test are you asking about and what was the number and unit (if you know)?",
      "Why was the test ordered, and any symptoms (e.g., red, hot, very painful joints)?",
      "When was it checked last, and are you on medicines that affect it?"
    ],
    symptom_headache: [
      "When did the headache start—sudden or gradual?",
      "How severe is it (0–10), and any nausea or light sensitivity?",
      "Where is it (front/one side/behind an eye), and what does it feel like?"
    ],
    symptom_abdominal: [
      "When did the tummy pain start—sudden or gradual?",
      "Where is it (upper/lower/central/right/left), and how severe is it (0–10)?",
      "Is it sharp, crampy, or burning, and does it move or stay in one spot?"
    ],
    symptom_rash: [
      "When did the rash start, and where on your body is it?",
      "Is it itchy, painful, or spreading, and do you have a fever?",
      "Any new soaps, creams, detergents, foods, meds, or insect bites?"
    ],
    symptom_cardioresp: [
      "When did the chest or breathing symptom start—sudden or gradual?",
      "What makes it better or worse (rest, activity, cold air, lying down)?",
      "Any chest tightness, wheeze, cough with phlegm, or fever?"
    ],
    growth_development: [
      "How tall are you now, and roughly how much have you grown in the last 6–12 months?",
      "Have you started puberty changes yet (e.g., periods, growth spurt, voice change)?",
      "If you know them, what are your parents’ heights?"
    ],
    pregnancy_related: [
      "How many weeks pregnant are you, and what symptoms are you noticing?",
      "Any bleeding, severe pain, fever, or reduced baby movements?",
      "Have you had any scans or check-ups yet, and were they reassuring?"
    ],
    fatigue_hair: [
      "Are your periods heavy or irregular, and any recent illness, stress, or big weight change?",
      "Do you follow a vegetarian/vegan diet or take any thyroid/iron-related medicines?",
      "Any other symptoms like feeling cold, palpitations, or brittle nails?"
    ],
    other: [
      "When did this start—sudden or gradual?",
      "How severe is it (0–10), and what makes it better or worse?",
      "Where exactly is it, and what does it feel like?"
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

// --- sanitize advice: remove dosing/imperatives; keep general tone; avoid brand commentary ---
function sanitizeAdvice(text = "") {
  let t = String(text);

  // Remove explicit dosing / % / units
  t = t.replace(/\b\d+\s?(mg|mcg|g|ml|units?|%|mcL|mL|IU)\b/gi, "a doctor-directed dose");
  // Remove timed regimens and x/day
  t = t.replace(/\b\d+(\s?–|-| to )\d+\s?(minutes?|hours?|hrs?)\b/gi, "a short time");
  t = t.replace(/\b\d+\s?(minutes?|hours?|hrs?)\b/gi, "a short time");
  t = t.replace(/\b(\d+|one|two|three|four)\s?(x|times?)\/(day|night|week)\b/gi, "regularly as advised by a clinician");

  // De-imperativize
  t = t.replace(/(^|\n)\s*[-•]?\s*(Take|Use|Apply|Start|Stop|Begin|Increase|Decrease|Avoid|Ice|Elevate|Rest|Wear|Do)\b/gi,
                (m, pfx, verb) => `${pfx}• People sometimes ${verb.toLowerCase()}… (discuss with a clinician)`);

  // You should/need to → consider discussing
  t = t.replace(/\b(you (should|need to|must))\b/gi, "it may be worth discussing with a clinician whether you could");

  // Tighten whitespace
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

// --- build the system prompt (supports clinical & general modes; 2–3 intake turns) ---
function buildSystemPrompt(assistantTurns, modeHint, topicHint, urgentFlag, productSpecific) {
  return `
You are a conversational medical information assistant for general education.

Global safety & tone
- Warm, friendly, short sentences. Education only. You can make mistakes. Not a diagnosis or treatment plan.
- No dosing, schedules, or prescriptive instructions. No brand/brand-like endorsements.
- If the user asked about a specific product: say clearly you can't comment on specific products/brands and speak at the category level.
- If clear emergency red flags, prioritise a brief urgent-care warning with the reason.

Intake (one question per turn; total 2–3)
- mode_hint="${modeHint}" (either "clinical" or "general")
- topic_hint="${topicHint}"
- Ask **exactly ONE short question (<25 words)** per turn, tailored to topic/type.
- Keep asking until at least **${MIN_INTAKE_TURNS}** questions have been asked. You MAY ask a **3rd** if key basics are missing (onset, location/character, severity, associated symptoms, relevant history/meds/exposures).
- Do NOT ask 0–10 severity unless topic is pain/itch/breathing.
- Output during intake: put the single question in "chat_reply"; set "need_another_intake" true/false; leave other fields minimal.

Advice (switch after 2–3 questions or immediately if urgent)
- Begin with this opener verbatim: "${FRIENDLY_OPENER}"
- Keep the whole advice to ~${ADVICE_WORD_LIMIT} words when possible.

Clinical pathway (mode="clinical") — headings and order:
  1) **Quick take** — recap using at least two specifics.
  2) **Common differentials (in plain English)** — 2–4, each with a brief "why it fits your story".
  3) **What clinicians often do first** — focused history/exam + named tests (plain English) with rationale.
  4) **Home-based & diet pointers (comfort-only)** — 2–3 practical ideas, each with a short "why".
  5) **What to watch out for (urgent)** — targeted red flags.
  6) **Next step** — friendly line: "If things aren’t improving or you’re unsure, arranging a timely clinic visit with a qualified clinician is sensible."

General topic pathway (mode="general") — headings and order:
  1) **Quick take** — clarify what they want to know.
  2) **What good studies say (evidence snapshot)** — up to 3 points; add source type+year (e.g., "Cochrane 2023", "WHO 2024", "RCTs 2021"); no URLs.
  3) **How professionals often approach it** — what clinicians consider/check (category-level; not personal instructions).
  4) **Day-to-day pointers (comfort-only)** — 2–3 safe, general habits with short "why".
  5) **Common myths & scams in the Philippines** — 2–3 short bullets (consumer-protection tone).
  6) **Watch-outs / when it’s not simple** — brief, relevant caveats.
  7) **Next step** — same friendly line as above.

Output JSON
- stage: "intake" or "advice"
- mode: "clinical" or "general"
- topic_type
- chat_reply (intake: the one question; advice: 2–3 sentence intro)
- need_another_intake: boolean (set during intake to indicate if a 3rd question is helpful)
- product_specific: boolean (true if user asked about a brand/product)
- advice_text (the composed message including headings)
- summary (1–2-line recap)
- info_gaps[] (what a clinician may ask/check next)
- urgent_triggers[] (watch-outs)
- final_reminder (friendly line above; avoid "please see a doctor" phrasing)
`;
}

// keep one relevant question; synthesize if empty or inappropriate
function enforceOneQuestion(o, step, userText, mode, topic) {
  let q = (o.chat_reply || "").trim();
  // collapse to first question in case the model wrote multiple
  const qm = q.indexOf("?");
  if (qm !== -1) q = q.slice(0, qm + 1);
  // restrict pain scale
  const mentionsScale = /0\s*(?:–|-|to)\s*10/.test(q) || /\b0-10\b/.test(q);
  if ((!q || !q.endsWith("?")) || (mentionsScale && (mode === "clinical" && !topicAllowsPainScale(topic)))) {
    q = fallbackQuestion(step, userText, mode, topic);
  }
  o.chat_reply = q;
  if (typeof o.need_another_intake !== "boolean") {
    o.need_another_intake = step + 1 < MIN_INTAKE_TURNS; // default: keep going until MIN met
  }
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

  // 2) Build conversation & hints
  const history = normalizeHistory(rawHistory);
  const assistantTurns = history.filter(t => t.role === "assistant").length;
  const { mode: modeHint, topic: topicHint } = inferModeAndTopic(question, history);
  const productSpecific = detectProductSpecific(question);
  const urgentFlag = modeHint === "clinical" && detectUrgency(question);

  const baseMessages = [
    { role: "system", content: buildSystemPrompt(assistantTurns, modeHint, topicHint, urgentFlag, productSpecific) },
    { role: "system", content: `CONTROL: mode_hint="${modeHint}", topic_hint="${topicHint}", product_specific=${productSpecific}. Ask ONE short question unless stage="advice".` },
    ...history,
    { role: "user", content: question }
  ];

  // 3) JSON schema
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      stage: { type: "string", enum: ["intake", "advice"] },
      mode: { type: "string", enum: ["clinical", "general"] },
      topic_type: { type: "string" },
      chat_reply: { type: "string" },
      need_another_intake: { type: "boolean" },
      product_specific: { type: "boolean" },
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
      ? [{ role: "system", content: 'CONTROL: Respond with stage="advice" now. Produce advice_text (<= ' + ADVICE_WORD_LIMIT + ' words), non-prescriptive, friendly, using the appropriate pathway.' }, ...baseMessages]
      : baseMessages;

    const payload = {
      model: "gpt-4o-mini",
      input: messages,
      temperature: 0.2,
      max_output_tokens: 900,
      text: {
        format: {
          type: "json_schema",
          name: "MedQA_DualMode_Pathway",
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

  // Intake/advice control:
  // - If urgent → advice now
  // - Else if assistantTurns < MIN → enforce intake
  // - Else if assistantTurns >= MIN and < MAX and parsed.need_another_intake === true → keep intake
  // - Else → force advice
  const needMoreIntake = parsed?.need_another_intake === true;
  const forceAdviceNow =
    urgentFlag ||
    (assistantTurns >= MIN_INTAKE_TURNS && (!needMoreIntake || assistantTurns >= MAX_INTAKE_TURNS));

  if ((!ok || !parsed) || (parsed.stage !== "advice" && forceAdviceNow)) {
    ({ ok, parsed, raw, status } = await callOnce(true));
  }

  // If still bad, return a safe intake question so UI never blanks
  if (!ok || !parsed) {
    const step = Math.min(assistantTurns, MAX_INTAKE_TURNS - 1);
    const safe = {
      stage: urgentFlag ? "advice" : "intake",
      mode: modeHint,
      topic_type: topicHint,
      chat_reply: urgentFlag
        ? "This sounds potentially urgent. If you have severe pain, trouble breathing, fainting, or stroke-like symptoms, please use urgent care now."
        : fallbackQuestion(step, question, modeHint, topicHint),
      advice_text: urgentFlag ? `${FRIENDLY_OPENER}\n\nWatch-outs (urgent): chest pain, trouble breathing, one-sided weakness, heavy bleeding, signs of a severe allergic reaction.` : undefined,
      final_reminder: "If things aren’t improving or you’re unsure, arranging a timely clinic visit with a qualified clinician is sensible."
    };
    return { statusCode: 200, body: JSON.stringify({ ok:true, result: safe, raw }) };
  }

  // Intake: enforce single, relevant question
  if (parsed.stage === "intake") {
    const mode = parsed.mode || modeHint;
    const topic = parsed.topic_type || topicHint;
    parsed = enforceOneQuestion(parsed, Math.min(assistantTurns, MAX_INTAKE_TURNS - 1), question, mode, topic);
  }

  // Advice: ensure opener, safety language, and friendly next-step
  if (parsed.stage === "advice") {
    // Product-specific guard: prepend a clear brand notice when needed
    const productFlag = parsed.product_specific || productSpecific;
    const brandNotice = productFlag
      ? "Note: I can’t comment on specific products or brands. I’ll speak generally about the category and what evidence says.\n\n"
      : "";

    const opener = FRIENDLY_OPENER;
    const nextStep = parsed.final_reminder && parsed.final_reminder.trim()
      ? parsed.final_reminder.trim()
      : "If things aren’t improving or you’re unsure, arranging a timely clinic visit with a qualified clinician is sensible.";

    let txt = `${opener}\n\n${brandNotice}${(parsed.advice_text || "").trim()}`;
    txt = sanitizeAdvice(txt);
    parsed.advice_text = txt;
    parsed.final_reminder = nextStep;
  }

  // Absolute safeguard: never return an empty chat_reply
  if (!parsed.chat_reply || !parsed.chat_reply.trim()) {
    const { mode, topic_type } = parsed;
    parsed.stage = "intake";
    parsed.chat_reply = fallbackQuestion(Math.min(assistantTurns, MAX_INTAKE_TURNS - 1), question, mode || modeHint, topic_type || topicHint);
  }

  return { statusCode: 200, body: JSON.stringify({ ok:true, result: parsed }) };
};
