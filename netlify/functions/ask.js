// netlify/functions/ask.js  (Node 18+)

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
    .filter(
      (t) =>
        t &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string"
    )
    .map((t) => ({ role: t.role, content: t.content.slice(0, 800) }));
  return clean.slice(-12); // ~6 Q/A turns
}

function cors(json, status = 200) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*", // tighten to your domain in prod
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(json),
  };
}

// ------------ main handler ------------
exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return cors({ ok: true });
  }
  if (event.httpMethod !== "POST") {
    return cors({ error: "Method Not Allowed" }, 405);
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return cors({ ok: false, error: "Invalid JSON" }, 400);
  }

  const { question, history: rawHistory = [], images: rawImages = [] } = body;

  if (!question || question.trim().length < 10) {
    return cors({ error: "Please ask a longer question." }, 400);
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return cors({ error: "Missing OPENAI_API_KEY" }, 500);
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
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: question,
      }),
    });
    const modJson = await modRes.json();
    if (!modRes.ok) {
      return cors(
        {
          ok: false,
          error: modJson?.error?.message || "Moderation failed",
        },
        modRes.status
      );
    }
    if (modJson.results?.[0]?.flagged) {
      return cors(
        { ok: false, error: "Question blocked by moderation." },
        400
      );
    }
  } catch {
    return cors({ ok: false, error: "Moderation request failed" }, 500);
  }

  // 2) Build conversation
  const history = normalizeHistory(rawHistory);
  const isFollowUp = history.length >= 2; // after first full turn, treat as follow-up

  const sysInitial = `You are "Doc Adams Q&A", a cautious triage nurse + medical educator for a PH + AU audience.
- Provide general education only; do NOT give personal medical advice, diagnoses, or treatment plans.
- Warm, conversational tone.
- For the FIRST user message in a conversation: provide a compact but complete overview with sections:
  possible causes → home remedies/self-care → possible investigations → treatments a doctor might do → red flags → when to seek help.
- Keep language short and scannable.`;

  const sysFollowup = `You are "Doc Adams Q&A".
- This is a FOLLOW-UP in the same conversation.
- Be brief (2–4 sentences), conversational, and do NOT repeat earlier long lists unless specifically asked.
- Add NEW or clarifying info only, and finish with ONE short, targeted question to move the triage forward.
- If new red-flag features are suggested, briefly point them out.`;

  const sys = isFollowUp ? sysFollowup : sysInitial;

  // Create user message content (text + optional images as data URLs)
  const userContent = [{ type: "input_text", text: question }];

  const safeImages = Array.isArray(rawImages) ? rawImages.slice(0, 3) : [];
  for (const dataUrl of safeImages) {
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      userContent.push({ type: "input_image", image_url: dataUrl });
    }
  }

  const messages = [
    { role: "system", content: sys },
    ...history,
    { role: "user", content: userContent },
  ];

  // 3) Structured outputs (loosened)
  const schemaInitial = {
    type: "object",
    additionalProperties: true, // allow harmless extras
    properties: {
      disclaimer: { type: "string" },
      chat_reply: { type: "string", minLength: 1 },
      possible_causes: { type: "array", items: { type: "string" } },
      self_care: { type: "array", items: { type: "string" } },
      investigations: { type: "array", items: { type: "string" } },
      treatments: { type: "array", items: { type: "string" } },
      red_flags: { type: "array", items: { type: "string" } },
      when_to_seek_help: { type: "string" },
      references: { type: "array", items: { type: "string" } },
      ask_back: { type: "string", minLength: 1 },
    },
    required: ["chat_reply", "ask_back"], // make most fields optional
  };

  const schemaFollowup = {
    type: "object",
    additionalProperties: true,
    properties: {
      disclaimer: { type: "string" },
      chat_reply: { type: "string", minLength: 1 },
      ask_back: { type: "string", minLength: 1 },
      notes: { type: "array", items: { type: "string" } },
      red_flags: { type: "array", items: { type: "string" } },
    },
    required: ["chat_reply", "ask_back"],
  };

  const schema = isFollowUp ? schemaFollowup : schemaInitial;

  // Try structured first; if it fails, fall back to plain text
  const structuredPayload = {
    model: "gpt-4o-mini",
    input: messages,
    temperature: 0.25,
    max_output_tokens: isFollowUp ? 380 : 1100,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: isFollowUp ? "DocAdamsMedQA_Followup" : "DocAdamsMedQA",
        schema,
        // STRICT REMOVED to avoid hard validation failures
      },
    },
  };

  // --- attempt structured call ---
  const res = await callOpenAIWithBackoff(headers, structuredPayload);
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  // Helper to parse structured response
  function tryParseStructured(d) {
    try {
      if (d?.output_text) return JSON.parse(d.output_text);
      if (Array.isArray(d?.output)) {
        const textItem = d.output[0]?.content?.find?.(
          (c) => c.type === "output_text" || c.type === "text"
        );
        if (textItem?.text) return JSON.parse(textItem.text);
      }
    } catch {}
    return null;
  }

  let parsed = tryParseStructured(data);

  // If structured failed due to validation or parsing, do a plain-text fallback
  const validationFailed =
    !res.ok ||
    !parsed ||
    (data?.error?.message &&
      /schema|pattern|validate|expected/i.test(String(data.error.message)));

  if (validationFailed) {
    // Build a compact, safe plain-text answer
    const fallbackMessages = [
      {
        role: "system",
        content:
          'You are "Doc Adams Q&A". Give short, safe, general education only. No diagnosis. Finish with one clarifying question.',
      },
      { role: "user", content: [{ type: "input_text", text: question }] },
    ];

    const fallbackPayload = {
      model: "gpt-4o-mini",
      input: fallbackMessages,
      temperature: 0.25,
      max_output_tokens: 400,
    };

    const fbRes = await callOpenAIWithBackoff(headers, fallbackPayload);
    let fbData;
    try {
      fbData = await fbRes.json();
    } catch {}

    let textOut = "";
    if (fbData?.output_text) textOut = fbData.output_text;
    else if (Array.isArray(fbData?.output)) {
      const item = fbData.output[0]?.content?.find?.(
        (c) => c.type === "output_text" || c.type === "text"
      );
      textOut = item?.text || "";
    }

    // Return minimal shape the frontend understands
    return cors({
      ok: true,
      result: {
        chat_reply: textOut || "Sorry, I couldn't generate a reply.",
        ask_back:
          "Can you share a bit more detail about your symptoms or timeline?",
      },
      _fallback: true,
    });
  }

  // Structured success
  return cors({ ok: true, result: parsed });
};

