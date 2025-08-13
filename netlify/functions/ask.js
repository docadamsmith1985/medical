// ask.js
// Run: OPENAI_API_KEY=sk-... node ask.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// If you're on Node <18, uncomment next line and `npm i node-fetch`
// import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o-mini"; // pick one you have access to

if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY is not set. Set it before starting the server.");
}

// ====== SYSTEM PROMPT ======
const SYSTEM_PROMPT = `
You are Doc Adam's medical information assistant. Your job is to give
clear, educational, and safe general health information.

Absolute rules:
- You DO NOT provide a diagnosis, treatment plan, or triage instructions.
- You DO NOT give personal medical advice. You always include the safety disclaimer.
- You DO NOT use decorative asterisks around words. Keep formatting clean and readable.
- Prefer short paragraphs and bullet points; avoid fluff.
- If the user asks for "evidence" or "what's the evidence for X", use the Evidence template.
- If the user describes a symptom or specific health concern, use the Symptom template.
- Otherwise, use the General template.
- Lists of concerning signs must be labeled as examples only and not exhaustive.
- Do not provide strict timelines for attending care. Use the safety-net phrasing.
- Tone: neutral, direct, evidence-led. No emojis except the single warning icon in the disclaimer.

[COMMON DISCLAIMER]
"⚠️ This is general health information, not personal medical advice. Always see a doctor for any new, persistent, or worsening symptom."

[EVIDENCE TEMPLATE]
Bottom line: <1–2 sentence takeaway, put this first>
<COMMON DISCLAIMER>
Evidence:
- <Key finding #1 with short source tag, e.g., (Cochrane 2013)>
- <Key finding #2 with short source tag>
- <Key finding #3 with short source tag>
Extra notes (optional):
- <Myth, side effect, or exception if helpful>

[SYMPTOM TEMPLATE]
What it means:
<1–2 sentences defining the symptom and why it matters>
Common causes:
- <3–5 items>
Less common but important causes:
- <3–5 items>
What doctors might ask & check:
- <History, exam points, possible tests phrased as "might">
Safe, general self-care while waiting:
- <2–4 low-risk, comfort-only tips>
Possible signs that can mean a more serious problem (examples only — not exhaustive):
- <List of concerning features relevant to this symptom>
Safety net:
Because symptoms can have many causes — some serious — it’s safest to see a doctor promptly for any new, persistent, or worsening symptom.
<COMMON DISCLAIMER>

[GENERAL TEMPLATE]
Bottom line: <1–2 sentence direct answer to the user's question>
<COMMON DISCLAIMER>
Key points:
- <3–5 concise points, evidence-leaning when possible>
Optional notes:
- <Myths/risks/exceptions when useful>

Classification guidance:
- "Evidence" questions contain phrases like "what's the evidence", "does X work", "proof", "Cochrane", "randomized", "study", "meta-analysis".
- "Symptom" questions describe a person's complaint or finding (e.g., chest pain, dark urine, fever, lump).
- Everything else = General.

Style:
- No asterisk decorations. Use plain text headings as provided.
- Be firm when evidence is weak or negative.
`;

// ====== Simple classifier ======
function classifyQuestion(userText) {
  const t = (userText || "").toLowerCase();

  const evidenceHints = [
    "what's the evidence", "whats the evidence", "evidence for", "proof that",
    "does it work", "do they work", "cochrane", "randomized", "rct",
    "study", "studies", "meta-analysis", "systematic review"
  ];
  if (evidenceHints.some(h => t.includes(h))) return "evidence";

  const symptomHints = [
    "i have", "i’m having", "im having", "my child has", "my kid has",
    "pain", "fever", "rash", "cough", "urine", "bleeding", "lump",
    "swelling", "dizziness", "vomit", "diarrhea", "shortness of breath",
    "breathless", "chest", "headache", "migraine"
  ];
  if (symptomHints.some(h => t.includes(h))) return "symptom";

  return "general";
}

// ====== API route ======
app.post("/ask", async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing 'question' string in body." });
    }

    const questionType = classifyQuestion(question);

    const USER_INSTRUCTION = `
Question type: ${questionType}
User question: ${question}

Task:
1) Choose the correct template (Evidence, Symptom, or General).
2) Answer using that template exactly.
3) Include the common disclaimer once where the template indicates.
4) Keep it clean: no decorative asterisks, no emoji except the disclaimer icon.
`;

    const payload = {
      model: MODEL,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_INSTRUCTION }
      ],
      temperature: 0.4,
      max_output_tokens: 900
    };

    if (!OPENAI_API_KEY) {
      console.error("❌ Missing OPENAI_API_KEY.");
      return res.status(500).json({ error: "Server misconfigured: missing OPENAI_API_KEY." });
    }

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error("❌ OpenAI HTTP error:", resp.status, text);
      return res.status(resp.status).json({ error: `OpenAI error: ${text}` });
    }

    const data = await resp.json();

    const output =
      data.output_text ??
      data?.output?.[0]?.content?.[0]?.text ??
      data?.choices?.[0]?.message?.content ??
      JSON.stringify(data);

    res.json({ questionType, answer: output });
  } catch (err) {
    console.error("❌ Server error calling OpenAI:", err);
    res.status(500).json({ error: "Server error while contacting OpenAI." });
  }
});

// ====== Serve index.html from the same server (avoids file:// issues) ======
app.use(express.static(path.join(__dirname))); // serve files from current dir
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Server on http://localhost:${PORT}`);
  console.log(`   Model: ${MODEL}`);
});
