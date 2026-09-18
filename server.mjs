#!/usr/bin/env node
// ask-jev — answer questions about files without reading them into the agent's context.
//
// The point: an agent often needs one fact about a file, not the file. Reading a file of
// six hundred lines costs about twelve thousand tokens; asking Jev costs the answer.
// The file goes to TypeSafe, never into the conversation.
//
// No dependencies. Speaks MCP over stdin and stdout, newline-delimited JSON-RPC.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const API = "https://api.typesafe.ai/v1/systemone";
const clean = (v) => (v && !v.startsWith("${") ? v : "");
const MODEL = clean(process.env.ASK_JEV_MODEL) || "jev-latest";
const MAX_CHARS = Number(clean(process.env.ASK_JEV_MAX_CHARS)) || 60000;
const CONCURRENCY = 6;      // requests in flight across all tools, not per pool
const NAME = "ask-jev";
const VERSION = "0.4.0";

// Retries follow the default policy of TypeSafe's own SDKs: two retries, backoff from half a
// second doubling to five, a quarter of jitter, and the server's Retry-After when it sends one.
const RETRIES = 2;
const BACKOFF_MS = 500;
const BACKOFF_MAX_MS = 5000;
const RETRY_AFTER_MAX_MS = 60000;
const TIMEOUT_MS = 30000;
const retryable = (status) => status === 408 || status === 429 || status >= 500;

/** The key, in order: this plugin's own setting, then the environment. */
function key() {
  const k = process.env.ASK_JEV_API_KEY
    || process.env.CLAUDE_PLUGIN_OPTION_apiKey
    || process.env.TYPESAFE_API_KEY;
  if (!k) {
    throw new Error(
      "No TypeSafe key. Set it with /plugin configure ask-jev@ask-jev, " +
      "or export TYPESAFE_API_KEY before starting Claude Code.");
  }
  return k;
}

let active = 0;
const waiting = [];

/** Run a task when a slot is free. Nested pools share these slots, so they cannot multiply. */
async function slot(task) {
  if (active < CONCURRENCY) active++;
  else await new Promise((resolve) => waiting.push(resolve));   // the slot is handed over below
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt) {
  return Math.min(BACKOFF_MS * 2 ** attempt, BACKOFF_MAX_MS) * (1 - 0.25 * Math.random());
}

/** The server's own wait, in milliseconds, when it names one we are willing to honour. */
function retryAfter(headers) {
  const ms = Number(headers.get("retry-after-ms"));
  const seconds = Number(headers.get("retry-after"));
  const wait = ms > 0 ? ms : seconds > 0 ? seconds * 1000 : 0;
  return wait > 0 && wait <= RETRY_AFTER_MAX_MS ? wait : null;
}

/** One call to the API. A rate limit, an overload or a dropped connection is retried. */
async function post(body) {
  const headers = { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" };
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await slot(async () => {
        const r = await fetch(API, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return { ok: r.ok, status: r.status, headers: r.headers, text: await r.text() };
      });
    } catch (error) {
      if (attempt < RETRIES) {
        await sleep(backoff(attempt));
        continue;
      }
      throw error;
    }
    if (response.ok) return JSON.parse(response.text);
    if (attempt < RETRIES && retryable(response.status)) {
      await sleep(retryAfter(response.headers) ?? backoff(attempt));
      continue;
    }
    throw new Error(`TypeSafe ${response.status}: ${response.text.slice(0, 200)}`);
  }
}

const NONE = "none of these";

/** A question as the agent wrote it: a plain string, or an object with criteria or options. */
function normalize(question) {
  const item = typeof question === "string" ? { question } : question ?? {};
  if (typeof item.question !== "string" || !item.question.trim()) {
    throw new Error("every question needs its text, as a string or as { question }");
  }
  return item;
}

const isChoice = (item) => Array.isArray(item.options) && item.options.length > 0;

/** Options make a Choice, with a way out when none fits; anything else is a yes/no Noul. */
function toQuestion(item) {
  if (isChoice(item)) {
    return {
      type: "choice",
      instructions: item.question,
      criteria: {
        ...Object.fromEntries(item.options.map((option) => [String(option), null])),
        [NONE]: "None of the other options holds for the file shown, or the file does not show it.",
      },
    };
  }
  return {
    type: "noul",
    instructions: item.question,
    criteria: {
      true: item.yes || "Yes, this holds for the file shown.",
      false: item.no || "No, it does not hold.",
    },
  };
}

/** One request, many questions about the same state. That is the cheap direction. */
async function ask(state, items) {
  const data = await post({
    state,
    questions: Object.fromEntries(items.map((item, i) => [`q${i}`, toQuestion(item)])),
    model: MODEL,
  });
  return {
    model: data.model,
    tokens: data.usage?.input_tokens ?? 0,
    answers: items.map((_, i) => data.answers?.[`q${i}`] ?? null),
  };
}

const OVERLAP_LINES = 20;   // a fact that straddles a boundary should land whole in one part
const MAX_PARTS = 8;        // a guard against paying for a very large file by accident

/** Cut a file into parts on line boundaries, each within the request budget. */
function parts(text) {
  const lines = text.split("\n");
  if (text.length <= MAX_CHARS) return [{ text, from: 1, to: lines.length, whole: true }];

  const out = [];
  let start = 0;
  while (start < lines.length && out.length < MAX_PARTS) {
    let end = start, size = 0;
    while (end < lines.length && size + lines[end].length + 1 <= MAX_CHARS) {
      size += lines[end].length + 1;
      end++;
    }
    if (end === start) end = start + 1;              // one line longer than the budget
    out.push({ text: lines.slice(start, end).join("\n"), from: start + 1, to: end, whole: false });
    if (end >= lines.length) break;
    start = Math.max(end - OVERLAP_LINES, start + 1);
  }
  const covered = out.length ? out[out.length - 1].to : 0;
  return Object.assign(out, { short: covered < lines.length ? lines.length - covered : 0 });
}

async function readParts(path) {
  const text = await readFile(resolve(path), "utf8");
  return { pieces: parts(text), chars: text.length };
}

/** How much a part says about a question: the yes of a Noul, the share off "none" of a Choice. */
function strength(answer) {
  if (!answer) return null;
  if (answer.type === "choice") return 1 - (answer.probabilities?.[NONE] ?? 0);
  return answer.noul ?? null;
}

/** Ask every part, and keep the strongest answer per question with the part it came from. */
async function askParts(path, pieces, items) {
  const answers = await pool(pieces, (piece) =>
    ask({ path, content: piece.text }, items).then((a) => ({ ...a, piece })));

  const failed = answers.find((a) => a.error);
  if (failed) throw new Error(failed.error);

  const tokens = answers.reduce((sum, a) => sum + a.tokens, 0);
  const best = items.map((_, i) => {
    let top = { value: null, answer: null, piece: pieces[0] };
    for (const a of answers) {
      const v = strength(a.answers[i]);
      if (v !== null && (top.value === null || v > top.value)) {
        top = { value: v, answer: a.answers[i], piece: a.piece };
      }
    }
    return top;
  });
  return { best, tokens, model: answers[0]?.model ?? MODEL };
}

function where(piece, count) {
  return count < 2 || piece.whole ? "" : `  [lines ${piece.from}-${piece.to}]`;
}

/** Run tasks a few at a time, keeping the order of the results. */
async function pool(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await worker(items[i]);
      } catch (error) {
        out[i] = { error: String(error.message || error) };
      }
    }
  }));
  return out;
}

const WINDOW_LINES = 200;   // a Choice takes at most 255 options
const MAX_WINDOWS = 12;
const LINE_CHARS = 200;
const FOUND = 0.70;         // the answer-present verdict uses the same band as every other answer
const ABSENT = 0.30;

/** Ask which line answers the question, and whether any line does. */
async function askWindow(path, question, window) {
  // The lines go in the state once, so both questions can read them. The choice options are
  // bare ids: repeating the text there would double the tokens and leave the noul blind.
  const lines = Object.fromEntries(
    window.lines.map(({ n, text }) => [String(n), text.trim().slice(0, LINE_CHARS)]));
  const options = Object.fromEntries(Object.keys(lines).map((n) => [n, null]));
  const data = await post({
    state: { path, lines },
    questions: {
      line: { type: "choice", instructions: `${question} Answer with the line id.`, criteria: options },
      exists: {
        type: "noul",
        instructions: `Do the lines shown answer this at all: ${question}`,
        criteria: {
          true: "One of the lines shown answers it.",
          false: "None of them do; the answer is elsewhere or absent.",
        },
      },
    },
    model: MODEL,
  });
  const choice = data.answers?.line ?? {};
  return {
    exists: data.answers?.exists?.noul ?? 0,
    probabilities: choice.probabilities ?? {},
    tokens: data.usage?.input_tokens ?? 0,
    model: data.model,
  };
}

/** Windows of numbered, non-empty lines. Empty lines cannot answer anything. */
function windows(text) {
  const numbered = text.split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter((line) => line.text.trim().length > 0);
  const out = [];
  for (let i = 0; i < numbered.length && out.length < MAX_WINDOWS; i += WINDOW_LINES) {
    const slice = numbered.slice(i, i + WINDOW_LINES);
    out.push({ lines: slice, from: slice[0].n, to: slice[slice.length - 1].n });
  }
  const seen = out.reduce((sum, w) => sum + w.lines.length, 0);
  return Object.assign(out, { short: numbered.length - seen, total: numbered.length });
}

const TOOLS = [
  {
    name: "ask_file",
    description:
      "Ask Jev one or more questions about a file, without reading the file into your " +
      "context. Use this when you need a fact about a file rather than its contents: does it " +
      "still call the old API, does it have tests, which test framework does it use. A yes/no " +
      "question returns a probability: above 0.70 read it as yes, below 0.30 as no, in between " +
      "read the file yourself. A question with options returns the likeliest option and a " +
      "confidence: under 0.50, read the file yourself. Jev reads literally and does not count, " +
      "compare numbers or dates, or follow double negatives. Several questions in one call " +
      "cost the same as one.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file." },
        questions: {
          type: "array",
          items: {
            anyOf: [
              { type: "string", description: "A yes/no question about one thing." },
              {
                type: "object",
                properties: {
                  question: { type: "string", description: "The question, about one thing." },
                  yes: { type: "string", description: "What counts as yes. Put boundary cases here." },
                  no: { type: "string", description: "What counts as no." },
                  options: {
                    type: "array",
                    items: { type: "string" },
                    description: "Makes it a choice: which one of these holds. " +
                      `"${NONE}" is added for you.`,
                  },
                },
                required: ["question"],
              },
            ],
          },
          description: "One to ten questions. A string is a yes/no question; use an object " +
            "to say what yes and no mean, or to give options.",
        },
      },
      required: ["path", "questions"],
    },
  },
  {
    name: "find_in_file",
    description:
      "Ask Jev which line of a file answers a question, without reading the file. Returns the " +
      "most likely lines with their text, so you can read those few lines instead of the file. " +
      "Also returns whether the file answers the question at all, which is the part that keeps " +
      "a confident-looking line from being a guess. Use it to locate something: where is the " +
      "timeout set, which line raises this error, where is this option read.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file." },
        question: { type: "string", description: "What you are looking for, in plain words." },
        max_results: { type: "number", description: "How many lines to return. Default 5." },
      },
      required: ["path", "question"],
    },
  },
  {
    name: "filter_files",
    description:
      "Ask Jev the same yes/no question about many files and get back which ones match, " +
      "without reading any of them. Use this to narrow a list before you open anything: which " +
      "of these forty files still use the old helper, which contain a hard-coded secret. " +
      "Returns every file with its probability, highest first.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "The files to check." },
        question: { type: "string", description: "One yes/no question, asked about each file." },
        yes: { type: "string", description: "What counts as yes. Put boundary cases here." },
        no: { type: "string", description: "What counts as no." },
      },
      required: ["paths", "question"],
    },
  },
];

function text_(value) {
  return { content: [{ type: "text", text: value }] };
}

function pct(value) {
  return value === null ? "—" : value.toFixed(2);
}

/** A yes/no answer is its probability; a choice is its likeliest option, the runners-up and confidence. */
function answerLine(item, best, count) {
  const at = where(best.piece, count);
  if (best.answer?.type !== "choice") return `${pct(best.value)}${at}  ${item.question}`;
  const [[option, probability], ...rest] = Object.entries(best.answer.probabilities)
    .sort((a, b) => b[1] - a[1]);
  const notes = rest.filter(([, p]) => p >= 0.05).map(([o, p]) => `${o} ${pct(p)}`);
  notes.push(`confidence ${pct(best.answer.confidence)}`);
  return `${pct(probability)}  ${option}  (${notes.join(" · ")})${at}  ${item.question}`;
}

async function askFile({ path, questions }) {
  if (!Array.isArray(questions) || questions.length === 0) throw new Error("give at least one question");
  const items = questions.map(normalize);
  const { pieces, chars } = await readParts(path);
  const { best, tokens, model } = await askParts(path, pieces, items);

  const lines = items.map((item, i) => answerLine(item, best[i], pieces.length));
  const spread = pieces.length > 1 ? ` · ${pieces.length} parts` : "";
  const missed = pieces.short ? ` · ${pieces.short} lines beyond part ${MAX_PARTS} not read` : "";
  lines.push("", `${path} · ${chars} chars${spread}${missed} · ${tokens} tokens · ${model}`);
  return text_(lines.join("\n"));
}

async function filterFiles({ paths, question, yes, no }) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("give at least one path");
  const item = normalize({ question, yes, no });
  const results = await pool(paths, async (path) => {
    const { pieces } = await readParts(path);
    const { best, tokens } = await askParts(path, pieces, [item]);
    return { path, value: best[0].value, piece: best[0].piece, count: pieces.length, tokens };
  });
  const ok = results.filter((r) => !r.error).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const failed = results.filter((r) => r.error);
  const tokens = ok.reduce((sum, r) => sum + r.tokens, 0);
  const lines = [`${question}`, ""];
  for (const r of ok) lines.push(`${pct(r.value)}  ${r.path}${where(r.piece, r.count)}`);
  if (failed.length) {
    lines.push("", "could not read:");
    for (const r of failed) lines.push(`  ${r.error}`);
  }
  lines.push("", `${ok.length} files · ${tokens} tokens · ${MODEL}`);
  return text_(lines.join("\n"));
}

async function findInFile({ path, question, max_results }) {
  if (!question) throw new Error("give a question");
  const text = await readFile(resolve(path), "utf8");
  const parts = windows(text);
  if (parts.length === 0) return text_(`${path} is empty.`);

  const answers = await pool(parts, (w) => askWindow(path, question, w));
  const failed = answers.find((a) => a.error);
  if (failed) throw new Error(failed.error);

  const found = [];
  for (const answer of answers) {
    for (const [line, probability] of Object.entries(answer.probabilities)) {
      found.push({ line: Number(line), probability, exists: answer.exists });
    }
  }
  const lines = text.split("\n");
  const top = found
    .map((f) => ({ ...f, score: f.probability * f.exists }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(Number(max_results) || 5, 20)));

  const tokens = answers.reduce((sum, a) => sum + a.tokens, 0);
  const best = Math.max(...answers.map((a) => a.exists));
  const out = [`${question}`, ""];
  if (best < ABSENT) out.push(`Not in this file (${pct(best)}). The lines below are only the closest.`, "");
  else if (best < FOUND) out.push(`Partly answered (${pct(best)}). Read the lines below before you rely on them.`, "");
  for (const f of top) {
    out.push(`${pct(f.score)}  line ${f.line}  ${(lines[f.line - 1] || "").trim().slice(0, 160)}`);
  }
  const missed = parts.short > 0 ? ` · ${parts.short} lines beyond window ${MAX_WINDOWS} not read` : "";
  out.push("", `${path} · ${parts.total} non-empty lines · ${parts.length} windows${missed} · ` +
    `answer present ${pct(best)} · ${tokens} tokens · ${answers[0]?.model ?? MODEL}`);
  return text_(out.join("\n"));
}

const HANDLERS = { ask_file: askFile, find_in_file: findInFile, filter_files: filterFiles };

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    };
  }
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") {
    const handler = HANDLERS[params?.name];
    if (!handler) throw new Error(`unknown tool: ${params?.name}`);
    return await handler(params.arguments || {});
  }
  if (method === "ping") return {};
  throw new Error(`unknown method: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.id === undefined) continue;      // a notification needs no reply
    try {
      send({ jsonrpc: "2.0", id: request.id, result: await handle(request) });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: String(error.message || error) },
      });
    }
  }
});
