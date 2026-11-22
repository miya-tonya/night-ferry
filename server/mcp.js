#!/usr/bin/env node
// Night Ferry as an MCP server (stdio), so an agent you already pay for by subscription —
// Claude Code, Codex, or any other MCP client — can be the writer. It exposes the one
// `night_ferry` tool; pictures found by the pipeline come back as image content, so the
// agent really looks at them before approving.
//
//   Claude Code:  claude mcp add --transport stdio night-ferry -- node /absolute/path/to/server/mcp.js
//   Codex:        codex mcp add night-ferry -- node /absolute/path/to/server/mcp.js
//
// Then just ask it: "写今晚的夜航船". See the README for running that on a schedule.
//
// It reads and writes the same data directory as the web server (NIGHT_FERRY_DATA), so
// both can run at once. Needs no packages of its own (MCP over stdio is newline-delimited
// JSON-RPC, handled right here); the picture pipeline additionally wants `sharp`.
// stdout carries the protocol and nothing else — all logging goes to stderr.
"use strict";
const readline = require("readline");
const { createFerry } = require("./ferry");

const ferry = createFerry();
ferry.resumeImageJobs(); // searches cut short when the last client went away pick up again

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]; // protocol revisions this server speaks, newest first
async function handle(msg) {
  const { id, method, params } = msg;
  const wantsReply = id !== undefined && id !== null;
  if (!wantsReply) return; // a notification: nothing to answer, whatever it is
  if (method === "initialize") {
    const asked = params && params.protocolVersion;
    return ok(id, {
      protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], // an unknown revision gets ours; the client decides whether it can live with it
      capabilities: { tools: {} },
      serverInfo: { name: "night-ferry", version: require("../package.json").version },
    });
  }
  if (method === "tools/list") {
    return ok(id, { tools: [{ name: ferry.tool.name, description: ferry.tool.description, inputSchema: ferry.tool.input_schema }] });
  }
  if (method === "tools/call") {
    if (!params || params.name !== ferry.tool.name) return fail(id, -32602, "unknown tool: " + (params && params.name));
    try {
      const out = await ferry.execute(params.arguments || {});
      const content = [{ type: "text", text: JSON.stringify(out.result) }];
      for (const b of out.images || []) content.push({ type: "image", data: b.data, mimeType: b.media_type });
      return ok(id, { content, isError: out.result && out.result.ok === false });
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: "night_ferry failed: " + e.message }], isError: true });
    }
  }
  fail(id, -32601, "method not found: " + method);
}

const rl = readline.createInterface({ input: process.stdin });
let pending = Promise.resolve();
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (_) { return fail(null, -32700, "parse error"); }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return fail(null, -32600, "invalid request");
  if (typeof msg.method !== "string") return; // a response to something (we never ask anything), or junk: not ours to answer
  if (msg.method === "ping" && msg.id != null) return ok(msg.id, {}); // answered at once, not behind a slow tool call
  // one call at a time, in order: the tool reads and appends to one file
  pending = pending.then(() => handle(msg)).catch((e) => { console.error("[night-ferry mcp]", e); if (msg && msg.id != null) fail(msg.id, -32603, "internal error"); });
});
// The client went away. Finish the call in hand and let any picture search that is running reach its
// end (so its result is saved and its claim released) before leaving — but not forever.
rl.on("close", () => {
  const bye = () => process.stdout.write("", () => process.exit(0));
  const giveUp = setTimeout(bye, 120000);
  pending.then(() => ferry.idle()).catch(() => {}).then(() => { clearTimeout(giveUp); bye(); });
});
