// Simple retry helper for 429 rate limits
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

// Netlify Function (CommonJS)
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { question } = JSON.parse(event.body || "{}");
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

  // 1) Moderate the question (optional but recommended)
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

  // 2) Ask the model with Structured Output
  const schema = {
    type: "object",
    additionalProperties: false, // <-- required by Responses API structured outputs
    properties: {
      disclaimer: { type: "string" },
      edu_answer: { type: "string" },
      red_flags: { type: "array", items: { type: "string" } },
      when_to_seek_help: { type: "string" },
      references: { type: "array", items: { type: "string" } }
    },
    required: ["disclaimer", "edu_answer", "red_flags", "when_to_seek_help"]
  };

  const sys = `You are a cautious medical educator (PH + AU audience).
- Provide general education only; do NOT give personal medical advice.
- Short, clear language. Bullet points when helpful.
- Always include a strong disclaimer and “see a doctor” guidance for red flags.
- Do not request or use personal identifiers (names, DOB, addresses, photos).`;

  const payload = {
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: sys },
      { role: "user", content: `Question: ${question}\nReturn JSON matching the schema keys.` }
    ],
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

  // 3) Pull the JSON result out of the Responses API shape
  let parsed;
  try {
    if (data.output_text) {
      parsed = JSON.parse(data.output_text);
    } else if (Array.isArray(data.output)) {
      const textItem = data.output[0]?.content?.find?.(
        c => c.type === "output_text" || c.type === "text"
      );
      if (textItem?.text) parsed = JSON.parse(textItem.text);
    }
  } catch {}

  return {
    statusCode: 200,
    body: JSON.stringify(parsed ? { ok: true, result: parsed } : { ok: false, raw: data })
  };
};
