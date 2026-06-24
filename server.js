/**
 * BOOTH BUDDY - local backend
 * - Serves the front-end (public/)
 * - Exposes POST /chat : { message, character, history } -> { reply }
 * - Simple RAG: loads all Markdown files in ./knowledge, retrieves the most
 *   relevant chunks for the question, and injects them into Claude's system prompt.
 * - The Claude API key stays on the server (never sent to the browser).
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const PORT = process.env.PORT || 3000;
const MODEL = (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6").trim(); // .trim()で前後の空白・改行を除去（not_found対策）
const APP_PASSWORD = (process.env.APP_PASSWORD || "").trim(); // 空ならゲートなし
const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("\n[!] ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n");
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 4,      // 接続が切れた時にSDKが自動で再試行
  timeout: 60000,     // 60秒
});

// 一時的な接続切れ（Premature close 等）に対して数回リトライする薄いラッパー。
// 本当の4xx（残高不足など）はそのまま投げる（リトライしない）。
async function callClaude(params, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      lastErr = e;
      const status = e && e.status;
      const msg = String((e && e.message) || e).toLowerCase();
      const transient =
        !status &&
        /premature close|econnreset|terminated|fetch failed|socket hang up|connection error|network/.test(msg);
      if (!transient) throw e;
      console.warn(`[/chat] transient error (attempt ${attempt}/${tries}): ${msg}`);
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  throw lastErr;
}

/* ---------------- Characters (personas) ---------------- *
 * Knowledge is shared by ALL characters; only the persona/voice differs.
 * This is what lets you add more characters cheaply. */
const CHARACTERS = {
  boss: {
    name: "The Boss",
    persona:
      "You are 'The Boss', a gruff but caring senior auto-body technician. " +
      "You speak plainly and briefly, like an old shop foreman. You encourage the worker, " +
      "push them to learn by doing, and never sugar-coat. Keep replies short.",
  },
  color: {
    name: "Color Pro",
    persona:
      "You are 'Color Pro', a meticulous paint and color specialist. " +
      "You are precise and a little technical, and you get genuinely excited about color. " +
      "You explain the 'why' clearly and practically.",
  },
  hype: {
    name: "Hype Buddy",
    persona:
      "You are 'Hype Buddy', an upbeat, playful younger co-worker. " +
      "You are mainly here for small talk and to lift the mood. Keep it light, warm and fun. " +
      "You can still answer shop questions, but always keep an easygoing tone.",
  },
  calm: {
    name: "Calm One",
    persona:
      "You are 'Calm One', a gentle, supportive listener. You are calm, reassuring and never " +
      "judgmental. You focus on listening and easing stress. Keep replies soft and short.",
  },
};

const SAFETY =
  "Always answer in the SAME language the user used. " +
  "Base technical answers on the REFERENCE KNOWLEDGE below when it is relevant; " +
  "if the knowledge does not cover it, say so honestly instead of guessing. " +
  "For anything involving safety, regulations, warranty, or vehicle safety systems, do NOT give " +
  "definitive instructions; remind the user to follow the shop's procedures and the paint/parts " +
  "maker's official instructions. Never invent specific mixing ratios or numbers that are not in the knowledge.";

/* ---------------- Load + chunk the Markdown knowledge ---------------- */
function loadKnowledge() {
  const chunks = [];
  let files = [];
  try {
    files = fs.readdirSync(KNOWLEDGE_DIR).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch (e) {
    console.warn("[knowledge] folder not found:", KNOWLEDGE_DIR);
    return chunks;
  }
  for (const file of files) {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), "utf8");
    // Split on Markdown headings (##, ###) so each section becomes one chunk.
    const parts = raw.split(/\n(?=#{1,6}\s)/g);
    for (const part of parts) {
      const text = part.trim();
      if (text.length > 0) chunks.push({ file, text });
    }
  }
  console.log(`[knowledge] loaded ${chunks.length} chunk(s) from ${files.length} file(s).`);
  return chunks;
}
let KNOWLEDGE = loadKnowledge();

/* ---------------- Simple retrieval (keyword + Japanese 2-gram overlap) ---------------- */
function tokenize(s) {
  const tokens = new Set();
  const lower = s.toLowerCase();
  // ASCII / number words of length >= 2
  (lower.match(/[a-z0-9]{2,}/g) || []).forEach((t) => tokens.add(t));
  // Japanese / CJK 2-grams
  const cjk = s.match(/[぀-ヿ一-鿿]+/g) || [];
  for (const run of cjk) {
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
    if (run.length === 1) tokens.add(run);
  }
  return [...tokens];
}

function retrieve(query, maxChars = 6000, topK = 6) {
  if (KNOWLEDGE.length === 0) return "";
  const total = KNOWLEDGE.reduce((n, c) => n + c.text.length, 0);
  // If the whole knowledge base is small, just include all of it.
  if (total <= maxChars) {
    return KNOWLEDGE.map((c) => c.text).join("\n\n---\n\n");
  }
  const qTokens = tokenize(query);
  const scored = KNOWLEDGE.map((c) => {
    const hay = c.text.toLowerCase();
    let score = 0;
    for (const t of qTokens) if (hay.includes(t)) score++;
    return { c, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  let out = [];
  let used = 0;
  for (const { c } of scored) {
    if (used + c.text.length > maxChars) break;
    out.push(c.text);
    used += c.text.length;
  }
  return out.join("\n\n---\n\n");
}

/* ---------------- Web server ---------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Health check (デプロイ先の死活監視・動作確認用)。ブラウザで /health を開けば状態が見える。
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    knowledgeChunks: KNOWLEDGE.length,
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    passwordRequired: Boolean(APP_PASSWORD),
  });
});

// フロントが「合言葉が必要か」を起動時に確認するための軽い口。
app.get("/config", (req, res) => {
  res.json({ passwordRequired: Boolean(APP_PASSWORD) });
});

app.post("/chat", async (req, res) => {
  try {
    // ---- 社内共有用の合言葉チェック（APP_PASSWORDが設定されている時だけ有効） ----
    if (APP_PASSWORD) {
      const given = (req.get("x-app-password") || (req.body && req.body.password) || "").trim();
      if (given !== APP_PASSWORD) {
        return res.status(401).json({ error: "unauthorized", reason: "合言葉が違います。" });
      }
    }

    const { message, character, history } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }
    const persona = (CHARACTERS[character] || CHARACTERS.boss).persona;
    const context = retrieve(message);

    const system =
      persona +
      "\n\n" +
      SAFETY +
      "\n\n===== REFERENCE KNOWLEDGE (auto body & paint) =====\n" +
      (context || "(no specific knowledge matched this question)");

    // Build the message history (last ~10 turns) + the new user message.
    const msgs = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        if (h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string") {
          msgs.push({ role: h.role, content: h.content });
        }
      }
    }
    msgs.push({ role: "user", content: message });

    const resp = await callClaude({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: msgs,
    });

    const reply = (resp.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    res.json({ reply });
  } catch (err) {
    const statusStr = err && err.status ? `HTTP ${err.status} ` : "";
    const nameStr = err && err.name ? `[${err.name}] ` : "";
    console.error("[/chat] error:", statusStr + nameStr + (err && err.message ? err.message : err));
    res.status(500).json({ error: "LLM request failed", detail: String((err && err.message) || err) });
  }
});

// Reload knowledge without restarting (handy while editing MD files).
app.post("/reload", (req, res) => {
  KNOWLEDGE = loadKnowledge();
  res.json({ chunks: KNOWLEDGE.length });
});

app.listen(PORT, () => {
  console.log(`\nBOOTH BUDDY running:  http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Knowledge chunks: ${KNOWLEDGE.length}`);
  console.log(`Access password: ${APP_PASSWORD ? "ON（合言葉が必要）" : "OFF（誰でも利用可）"}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[!] APIキー未設定のため、チャットは失敗します。.env を確認してください。");
  }
});
