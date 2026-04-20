#!/usr/bin/env node
/**
 * demo-agent.mjs — single-session agent runner for the Phase 3 demo.
 *
 * One process = one "session". Boots a DocsVFS with memory enabled against
 * a read-only docs folder, wires up `docs` (bash) + `remember` (pin note)
 * tools, runs the local llama3.1:8b model via Ollama's OpenAI-compat
 * endpoint through the Vercel AI SDK with a 15-step budget, streams every
 * thought/tool-call/tool-result to stdout AND an NDJSON log file.
 *
 * Usage:
 *   node scripts/demo-agent.mjs \
 *     --session S1 \
 *     --docs ~/data-attribution-demo/docs \
 *     --db ~/.docsvfs-demo/db/demo.db \
 *     --log ~/.docsvfs-demo/logs/S1.ndjson \
 *     --goal "Explore..." \
 *     --steps 15
 *
 * All paths expand ~ to $HOME.
 */

import { createDocsVFS, createRememberTool } from "../dist/index.js";
import { generateText, tool, jsonSchema, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── CLI parsing ─────────────────────────────────────────────────
function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

const SESSION_ID = arg("session", "S?");
const DOCS = expandHome(arg("docs", "./demo-docs"));
const DB_PATH = expandHome(arg("db", `~/.docsvfs-demo/db/${SESSION_ID}.db`));
const LOG = expandHome(arg("log", `~/.docsvfs-demo/logs/${SESSION_ID}.ndjson`));
const STEPS = parseInt(arg("steps", "15"), 10);
const MODEL_ID = arg("model", "llama3.1:8b");
const GOAL = arg("goal", "Explore the docs and summarize what you find.");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/v1";

const tag = (name) => `\x1b[36m[${name}]\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// Parse remember(topic=..., content=..., append?, note?) from free-form text.
// Accepts kwargs with =, colons, or JSON; single or double quotes; and either
// ```remember(...)``` fences or bare backticks. Returns an array of arg objects.
function extractRememberCalls(text) {
  const out = [];
  if (!text) return out;
  const candidates = [];
  const reCallBlock = /remember\s*\(([\s\S]*?)\)/gi;
  let m;
  while ((m = reCallBlock.exec(text)) !== null) candidates.push(m[1]);
  const reJson = /\{[^{}]*"name"\s*:\s*"remember"[^{}]*"(?:parameters|arguments|input)"\s*:\s*(\{[\s\S]*?\})[^{}]*\}/gi;
  while ((m = reJson.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj.topic && obj.content) out.push(normalizeArgs(obj));
    } catch {}
  }
  for (const body of candidates) {
    const parsed = parseKwargs(body);
    if (parsed && parsed.topic && parsed.content) out.push(normalizeArgs(parsed));
  }
  return dedupe(out);
}

function parseKwargs(body) {
  const result = {};
  const reKv = /(topic|content|append|note)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|True|False|true|false)/gi;
  let m;
  while ((m = reKv.exec(body)) !== null) {
    const key = m[1].toLowerCase();
    let raw = m[2];
    if (raw === "True" || raw === "true") result[key] = true;
    else if (raw === "False" || raw === "false") result[key] = false;
    else result[key] = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, "\n");
  }
  return result;
}

function normalizeArgs(a) {
  const o = { topic: String(a.topic), content: String(a.content) };
  if (a.append === true) o.append = true;
  if (typeof a.note === "string" && a.note.length > 0) o.note = a.note;
  return o;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const k = a.topic + "\x00" + a.content;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

// ensure log dir
mkdirSync(path.dirname(LOG), { recursive: true });
writeFileSync(LOG, ""); // truncate
const logEvent = (ev) => {
  try {
    appendFileSync(LOG, JSON.stringify({ ts: Date.now(), session: SESSION_ID, ...ev }) + "\n");
  } catch {}
};

console.log(tag("BOOT"), `session=${SESSION_ID} docs=${DOCS}`);
console.log(tag("BOOT"), `db=${DB_PATH} log=${LOG}`);
console.log(tag("BOOT"), `model=${MODEL_ID} steps=${STEPS}`);
console.log(tag("BOOT"), `goal: ${GOAL}\n`);

logEvent({ kind: "boot", docs: DOCS, db: DB_PATH, model: MODEL_ID, steps: STEPS, goal: GOAL });

// ─── Boot the VFS ────────────────────────────────────────────────
const t0 = performance.now();
const vfs = await createDocsVFS({
  rootDir: DOCS,
  memory: true,
  memoryDbUrl: `file:${DB_PATH}`,
  sessionId: SESSION_ID,
  noCache: true, // always fresh, don't pollute ~/.cache
});
const bootMs = Math.round(performance.now() - t0);
console.log(tag("BOOT"), `vfs up in ${bootMs}ms — ${vfs.stats.fileCount} files, ${vfs.stats.dirCount} dirs\n`);
logEvent({ kind: "vfs_ready", bootMs, stats: vfs.stats });

// ─── Tool adapters (AI SDK v6 shape) ─────────────────────────────
const docsToolImpl = {
  description:
    `Bash shell over the read-only documentation folder (${vfs.stats.fileCount} files under /docs). ` +
    "Use standard Unix commands to explore: tree, ls, cat, grep, find, head, tail, wc. " +
    "Writes to /docs return EROFS — only /memory and /workspace accept writes. " +
    "Start with `tree / -L 2` to see the structure. Also available: `density <path> <term>` " +
    "ranks files by term frequency and suggests a drill-in command.",
  inputSchema: jsonSchema({
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "A bash command to run. Supports pipes, redirects, grep/cat/find/etc.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  }),
  execute: async ({ command }) => {
    const started = performance.now();
    try {
      const result = await vfs.exec(command);
      const elapsed = Math.round(performance.now() - started);
      console.log(tag("TOOL"), `docs.exec (${elapsed}ms): ${command}`);
      if (result.stdout) console.log(dim(result.stdout.split("\n").slice(0, 20).join("\n")));
      if (result.stderr) console.log(dim(`stderr: ${result.stderr.slice(0, 200)}`));
      logEvent({
        kind: "tool_call",
        tool: "docs",
        command,
        elapsedMs: elapsed,
        exitCode: result.exitCode,
        stdout_bytes: result.stdout.length,
        stdout_head: result.stdout.slice(0, 800),
        stderr: result.stderr.slice(0, 200),
      });
      let out = "";
      if (result.stdout) out += result.stdout;
      if (result.stderr) out += (out ? "\n" : "") + `stderr: ${result.stderr}`;
      if (result.exitCode !== 0 && !out) out = `exit ${result.exitCode}`;
      return out || "(no output)";
    } catch (err) {
      logEvent({ kind: "tool_error", tool: "docs", command, error: String(err.message) });
      return `Error: ${err.message}`;
    }
  },
};

const rememberBase = createRememberTool({ vfs });
const rememberToolImpl = {
  description: rememberBase.description,
  inputSchema: jsonSchema({
    type: "object",
    properties: {
      topic: { type: "string", description: "Short topic; becomes the filename slug." },
      content: { type: "string", description: "Markdown body to store." },
      append: { type: "boolean", description: "Append instead of overwrite. Default false." },
      note: { type: "string", description: "Optional provenance note (e.g. why you wrote this)." },
    },
    required: ["topic", "content"],
    additionalProperties: false,
  }),
  execute: async (args) => {
    const started = performance.now();
    try {
      const result = await rememberBase.execute(args);
      const elapsed = Math.round(performance.now() - started);
      console.log(tag("TOOL"), `remember (${elapsed}ms): topic="${args.topic}" mode=${result.mode} bytes=${result.bytes}`);
      console.log(dim(`  → ${result.path}`));
      logEvent({
        kind: "tool_call",
        tool: "remember",
        topic: args.topic,
        append: !!args.append,
        note: args.note,
        elapsedMs: elapsed,
        result,
      });
      return JSON.stringify(result);
    } catch (err) {
      logEvent({ kind: "tool_error", tool: "remember", args, error: String(err.message) });
      return `Error: ${err.message}`;
    }
  },
};

// ─── Model ───────────────────────────────────────────────────────
const ollama = createOpenAI({
  baseURL: OLLAMA_URL,
  apiKey: "ollama",
  // Ollama responds with some non-standard fields; loose the check
  compatibility: "compatible",
});

// ─── System prompt ───────────────────────────────────────────────
const systemPrompt = `You are an agent exploring documentation via function tools.

You have two function tools you can INVOKE (not describe in text):
- \`docs(command)\` — runs a bash command against a virtual filesystem.
  /docs is read-only source docs, /memory persists across sessions, /workspace is 24h scratch.
- \`remember(topic, content, append?, note?)\` — writes /memory/<slug>.md. The ONLY way to save findings.

Critical rules:

1. Writing text like "\`remember ...\`" or JSON that looks like a tool call does NOTHING. Only a real tool invocation persists anything. If you want something saved, you MUST call the \`remember\` function — never type the call out as prose.
2. Emit exactly ONE tool call per turn. Work one step at a time.
3. First turn of every session: call \`docs\` with \`ls /memory\` to see prior notes. If there are relevant files, \`cat\` them before /docs.
4. Never call \`remember\` until you have \`cat\`'d the specific file you're summarizing. No speculation.
5. In your final text reply, cite each fact as "(file: /docs/FOO.md)".
6. When the goal is done, stop.

Goal:
${GOAL}`;

logEvent({ kind: "system_prompt", content: systemPrompt });

// ─── Run ─────────────────────────────────────────────────────────
const runT0 = performance.now();
let stepN = 0;

try {
  const { text, steps, usage, finishReason } = await generateText({
    // Ollama's OpenAI-compat endpoint speaks Chat Completions, not Responses.
    model: ollama.chat(MODEL_ID),
    system: systemPrompt,
    prompt: GOAL,
    temperature: 0,
    tools: {
      docs: tool(docsToolImpl),
      remember: tool(rememberToolImpl),
    },
    stopWhen: stepCountIs(STEPS),
    // Force sequential tool use — small local models batch calls otherwise and
    // emit remember() before they've actually looked at anything.
    providerOptions: {
      openai: {
        parallelToolCalls: false,
      },
    },
    onStepFinish: (step) => {
      stepN++;
      console.log(tag("STEP"), `${stepN} finishReason=${step.finishReason ?? "—"} toolCalls=${step.toolCalls?.length ?? 0}`);
      if (step.text) console.log(dim(`  say: ${step.text.slice(0, 400)}`));
      logEvent({
        kind: "step",
        n: stepN,
        finishReason: step.finishReason,
        text: step.text,
        toolCalls: (step.toolCalls ?? []).map((c) => ({ name: c.toolName, input: c.input })),
      });
    },
  });
  const runMs = Math.round(performance.now() - runT0);

  console.log("\n" + tag("DONE"), `steps=${steps?.length ?? stepN} runMs=${runMs} finishReason=${finishReason}`);
  if (text) console.log(tag("FINAL"), text.slice(0, 1000));
  logEvent({ kind: "done", steps: steps?.length ?? stepN, runMs, finishReason, text, usage });

  // ─── Fallback: parse remember(...) from final text ─────────
  // Small local models via Ollama's OpenAI-compat layer often emit the final
  // remember() call as text instead of as a structured tool_call. Catch that
  // pattern and invoke the real tool; log the event distinctly.
  let fallbackRemembered = 0;
  if (text) {
    const fbMatches = extractRememberCalls(text);
    for (const fbArgs of fbMatches) {
      console.log(tag("FALLBACK"), `parsed remember(topic="${fbArgs.topic}") from final text`);
      logEvent({ kind: "remember_fallback_parsed", args: fbArgs });
      try {
        await rememberToolImpl.execute(fbArgs);
        fallbackRemembered++;
      } catch (err) {
        logEvent({ kind: "remember_fallback_failed", error: String(err.message) });
      }
    }
  }

  // ─── Scorecard ──────────────────────────────────────────────
  let docsCalls = 0, rememberCalls = 0;
  const rememberedPaths = [];
  for (const step of steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      if (call.toolName === "docs") docsCalls++;
      if (call.toolName === "remember") {
        rememberCalls++;
        // best-effort path from slug
      }
    }
  }
  // Pull actual remembered paths from log
  // (logEvent already captured result.path per call)
  const scorecard = {
    session: SESSION_ID,
    docsCalls,
    rememberCalls,
    rememberFallbacks: fallbackRemembered,
    runMs,
    steps: steps?.length ?? stepN,
    finishReason,
  };
  console.log("\n" + tag("SCORE"), JSON.stringify(scorecard));
  logEvent({ kind: "scorecard", ...scorecard });
} catch (err) {
  console.error(tag("ERR"), err.message);
  logEvent({ kind: "run_error", error: String(err.message), stack: err.stack });
  process.exitCode = 1;
} finally {
  await vfs.close();
  logEvent({ kind: "closed" });
}
