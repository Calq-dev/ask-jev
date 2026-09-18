#!/usr/bin/env node
// jev-ask — answer questions about files without reading them into the agent's context.
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
const MODEL = clean(process.env.JEV_ASK_MODEL) || "jev-latest";
const MAX_CHARS = Number(clean(process.env.JEV_ASK_MAX_CHARS)) || 60000;
const CONCURRENCY = 6;
const NAME = "jev-ask";
const VERSION = "0.1.0";

/** The key, in order: this plugin's own setting, then the environment. */
function key() {
  const k = process.env.JEV_ASK_API_KEY
    || process.env.CLAUDE_PLUGIN_OPTION_apiKey
    || process.env.TYPESAFE_API_KEY;
  if (!k) {
    throw new Error(
      "No TypeSafe key. Set it with /plugin configure jev-ask@jev-ask, " +
      "or export TYPESAFE_API_KEY before starting Claude Code.");
  }
  return k;
}

/** One request, many questions about the same state. That is the cheap direction. */
async function ask(state, questions) {
  const body = {
    state,
    questions: Object.fromEntries(questions.map((q, i) => [`q${i}`, {
      type: "noul",
      instructions: q,
      criteria: { true: "Yes, this holds for the file shown.", false: "No, it does not hold." },
    }])),
    model: MODEL,
  };
  const response = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TypeSafe ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  return {
    model: data.model,
    tokens: data.usage?.input_tokens ?? 0,
    values: questions.map((_, i) => data.answers[`q${i}`]?.noul ?? null),
  };
}

async function fileState(path) {
  const full = resolve(path);
  let text = await readFile(full, "utf8");
  const cut = text.length > MAX_CHARS;
  if (cut) text = text.slice(0, MAX_CHARS);
  return { state: { path, content: text }, chars: text.length, cut };
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

const TOOLS = [
  {
    name: "ask_file",
    description:
      "Ask Jev one or more yes/no questions about a file, without reading the file into your " +
      "context. Use this when you need a fact about a file rather than its contents: does it " +
      "still call the old API, does it have tests, does it handle errors. Returns a probability " +
      "per question. Above 0.70 read it as yes, below 0.30 as no, in between read the file " +
      "yourself. Several questions in one call cost the same as one.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file." },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "One to ten yes/no questions, each about one thing.",
        },
      },
      required: ["path", "questions"],
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
      },
      required: ["paths", "question"],
    },
  },
];

function text(value) {
  return { content: [{ type: "text", text: value }] };
}

function pct(value) {
  return value === null ? "—" : value.toFixed(2);
}

async function askFile({ path, questions }) {
  if (!Array.isArray(questions) || questions.length === 0) throw new Error("give at least one question");
  const { state, chars, cut } = await fileState(path);
  const answer = await ask(state, questions);
  const lines = questions.map((q, i) => `${pct(answer.values[i])}  ${q}`);
  lines.push("", `${path} · ${chars} chars${cut ? " (cut)" : ""} · ${answer.tokens} tokens · ${answer.model}`);
  return text(lines.join("\n"));
}

async function filterFiles({ paths, question }) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("give at least one path");
  const results = await pool(paths, async (path) => {
    const { state, cut } = await fileState(path);
    const answer = await ask(state, [question]);
    return { path, value: answer.values[0], cut, tokens: answer.tokens };
  });
  const ok = results.filter((r) => !r.error).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const failed = results.filter((r) => r.error);
  const tokens = ok.reduce((sum, r) => sum + r.tokens, 0);
  const lines = [`${question}`, ""];
  for (const r of ok) lines.push(`${pct(r.value)}  ${r.path}${r.cut ? "  (cut)" : ""}`);
  if (failed.length) {
    lines.push("", "could not read:");
    for (const r of failed) lines.push(`  ${r.error}`);
  }
  lines.push("", `${ok.length} files · ${tokens} tokens · ${MODEL}`);
  return text(lines.join("\n"));
}

const HANDLERS = { ask_file: askFile, filter_files: filterFiles };

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
