// --- retry helper for 429 rate limits ---
async function callOpenAIWithBackoff(headers, payload, tries = 3) {
  let wait = 1000; // 1s → 2s → 4s
  let last;
  for (let i = 0; i < tries; i++) {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    if (res.status !== 429) return res; // success or non-429 error
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

// Netlify Function (CommonJS)
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { question, history: rawHistory = [] } = JSON.parse(event.body || "{}");
  if (!question || question.trim().length < 10) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please ask a longer question." }) };
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
  }

  const headers = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  };

  // 1) Moderate the NEW question only
  try {
    const modRes = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "omni-moderation-latest", input: question })
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

  // 2) Build conversation
  const sys = `You are a cautious triage nurse and medical educator for a PH + AU audience.
- Provide general education only; do NOT give personal medical advice or diagnoses.
- Use a warm, conversational tone. Keep replies short (≤ 8 sentences).
- If the user’s message is unclear or missing key info, ask ONE gentle follow-up question at the end.
- Prefer bullet points for steps or red flags.
- Always include a strong disclaimer and “see a doctor” guidance for red flags.
- Do not request or use personal identifiers (names, DOB, addresses, photos).`;

  const history = normalizeHistory(rawHistory);
  const messages = [{ role: "system", content: sys }, ...history, { role: "user", content: question }];

  // 3) Strict structured output (plus a conversational reply)
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      disclaimer: { type: "string" },
      chat_reply: { type: "string" },    // conversational nurse-style reply
      edu_answer: { type: "string" },    // longer educational content (optional to show)
      red_flags: { type: "array", items: { type: "string" } },
      when_to_seek_help: { type: "string" },
      references: { type: "array", items: { type: "string" } },
      ask_back: { type: "string" }       // one follow-up question to keep the convo going
    },
    required: [
      "disclaimer",
      "chat_reply",
      "edu_answer",
      "red_flags",
      "when_to_seek_help",
      "references",
      "ask_back"
    ]
  };

  const payload = {
    model: "gpt-4o-mini",
    input: messages,
    temperature: 0.2,
    max_output_tokens: 900,
    text: {
      format: {
        type: "json_schema",
        name: "MedQA",
        strict: true,
        schema
      }
    }
  };

  const res = await callOpenAIWithBackoff(headers, payload);
  const data = await res.json();

  if (!res.ok) {
    return {
      statusCode: res.status,
      body: JSON.stringify({ ok: false, error: data?.error?.message || data?.message || "OpenAI request failed" })
    };
  }

  // 4) Extract the JSON from the Responses API
  let parsed;
  try {
    if (data.output_text) {
      parsed = JSON.parse(data.output_text);
    } else if (Array.isArray(data.output)) {
      const textItem = data.output[0]?.content?.find?.(c => c.type === "output_text" || c.type === "text");
      if (textItem?.text) parsed = JSON.parse(textItem.text);
    }
  } catch {}

  return {
    statusCode: 200,
    body: JSON.stringify(parsed ? { ok: true, result: parsed } : { ok: false, raw: data })
  };
};
