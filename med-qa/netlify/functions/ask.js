// Netlify Function: server-side proxy (keeps your OpenAI key secret)
export async function handler(event) {
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

  // 1) Moderate the incoming question
  const modRes = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "omni-moderation-latest", input: question })
  });
  const modJson = await modRes.json();
  if (modRes.status !== 200) {
    return { statusCode: modRes.status, body: JSON.stringify(modJson) };
  }
  if (modJson.results?.[0]?.flagged) {
    return { statusCode: 400, body: JSON.stringify({ error: "Question blocked by moderation." }) };
  }

  // 2) Ask the model with a strict JSON schema (Structured Outputs)
  const schema = {
    type: "object",
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

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: sys },
        { role: "user", content: `Question: ${question}\nReturn JSON matching the schema keys.` }
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "MedQA", strict: true, schema }
      }
    })
  });

  const data = await res.json();

  // Try to extract the structured JSON from Responses API
  let parsed;
  try {
    if (data.output_text) {
      parsed = JSON.parse(data.output_text);
    } else if (Array.isArray(data.output)) {
      const first = data.output[0];
      const textItem = first?.content?.find?.(c => c.type === "output_text" || c.type === "text");
      parsed = JSON.parse(textItem?.text ?? "{}");
    }
  } catch (e) {
    // fall back to raw
  }

  // Return a clean payload for the frontend
  return {
    statusCode: res.status,
    body: JSON.stringify(
      parsed
        ? { ok: true, result: parsed }
        : { ok: false, raw: data }
    )
  };
}
