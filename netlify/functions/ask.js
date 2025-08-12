// netlify/functions/ask.js  — schema-free fallback to kill pattern errors

async function callOpenAIWithBackoff(headers, payload, tries = 3) {
  let wait = 1000, last;
  for (let i = 0; i < tries; i++) {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", headers, body: JSON.stringify(payload)
    });
    if (res.status !== 429) return res;
    last = res; await new Promise(r => setTimeout(r, wait)); wait *= 2;
  }
  return last;
}

function normalizeHistory(raw){
  if (!Array.isArray(raw)) return [];
  const clean = raw.filter(t => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
                   .map(t => ({ role:t.role, content:t.content.slice(0,800) }));
  return clean.slice(-12);
}

function cors(json, status=200){
  return {
    statusCode: status,
    headers: {
      "Content-Type":"application/json",
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Headers":"Content-Type",
      "Access-Control-Allow-Methods":"POST, OPTIONS",
      "X-App-Version": "no-schema-1" // helps us confirm deploy
    },
    body: JSON.stringify(json),
  };
}

exports.handler = async function(event){
  if (event.httpMethod === "OPTIONS") return cors({ok:true});
  if (event.httpMethod !== "POST")   return cors({error:"Method Not Allowed"},405);

  let body; try { body = JSON.parse(event.body||"{}"); } catch { return cors({ok:false,error:"Invalid JSON"},400); }
  const { question, history:rawHistory=[], images:rawImages=[] } = body;

  if (!question || question.trim().length < 10) return cors({ error:"Please ask a longer question." }, 400);

  const key = process.env.OPENAI_API_KEY;
  if (!key) return cors({ error:"Missing OPENAI_API_KEY" }, 500);

  const headers = { Authorization:`Bearer ${key}`, "Content-Type":"application/json" };

  // moderation
  try {
    const m = await fetch("https://api.openai.com/v1/moderations", {
      method:"POST", headers,
      body: JSON.stringify({ model:"omni-moderation-latest", input: question })
    });
    const mj = await m.json();
    if (!m.ok) return cors({ ok:false, error: mj?.error?.message || "Moderation failed" }, m.status);
    if (mj.results?.[0]?.flagged) return cors({ ok:false, error:"Question blocked by moderation." }, 400);
  } catch {
    return cors({ ok:false, error:"Moderation request failed" }, 500);
  }

  const history = normalizeHistory(rawHistory);
  const isFollowUp = history.length >= 2;

  const sys = isFollowUp
    ? `You are "Doc Adams Q&A". Brief follow-up (2–4 sentences). General education only. End with one clarifying question.`
    : `You are "Doc Adams Q&A", a cautious triage nurse + medical educator for PH + AU. General education only. 
       For first message, cover: possible causes → home remedies → investigations → treatments a doctor might do → red flags → when to seek help.
       Keep it short, scannable. End with one clarifying question.`;

  const userContent = [{ type:"input_text", text: question }];
  const imgs = Array.isArray(rawImages) ? rawImages.slice(0,3) : [];
  for (const dataUrl of imgs) {
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      userContent.push({ type:"input_image", image_url: dataUrl });
    }
  }

  const messages = [
    { role:"system", content: sys },
    ...history,
    { role:"user", content: userContent },
  ];

  const payload = {
    model: "gpt-4o-mini",
    input: messages,
    temperature: 0.25,
    max_output_tokens: isFollowUp ? 380 : 1100,
    // NOTE: no response_format — always plain text
  };

  const res = await callOpenAIWithBackoff(headers, payload);
  let data; try { data = await res.json(); } catch {}

  if (!res.ok) {
    return cors({ ok:false, error: data?.error?.message || "OpenAI request failed" }, res.status);
  }

  // extract plain text
  let text = data?.output_text || "";
  if (!text && Array.isArray(data?.output)) {
    const item = data.output[0]?.content?.find?.(c => c.type === "output_text" || c.type === "text");
    text = item?.text || "";
  }
  if (!text) text = "Sorry, I couldn't generate a reply.";

  // minimal shape the frontend understands
  return cors({
    ok: true,
    result: {
      chat_reply: text,
      ask_back: "Can you share a bit more detail about your symptoms or timeline?",
    }
  });
};
