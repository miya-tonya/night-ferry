// The MCP entry point, driven the way a client drives it: newline-delimited JSON-RPC over stdio.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-mcp-"));
  const env = { ...process.env, NIGHT_FERRY_DATA: dataDir, NIGHT_FERRY_LLM: "none" };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "mcp.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", nextId = 1;
  const waiting = new Map(), stray = [];
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line); // anything on stdout that is not JSON would break a real client too
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } else stray.push(msg);
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error("no reply to " + method)), 15000);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  const raw = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  return { call, notify, raw, stray, stop: () => new Promise((r) => { child.on("exit", r); child.stdin.end(); }) };
}

test("mcp: handshake, tool listing, a full write, errors", async () => {
  const c = start();
  try {
    const init = await c.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.strictEqual(init.result.protocolVersion, "2025-06-18");
    assert.deepStrictEqual(init.result.capabilities, { tools: {} });
    assert.strictEqual(init.result.serverInfo.name, "night-ferry");
    c.notify("notifications/initialized");

    const list = await c.call("tools/list", {});
    assert.strictEqual(list.result.tools.length, 1);
    const tool = list.result.tools[0];
    assert.strictEqual(tool.name, "night_ferry");
    assert.strictEqual(tool.inputSchema.type, "object");
    assert.ok(tool.inputSchema.properties.background.enum.length >= 1);

    const text = (r) => JSON.parse(r.result.content[0].text);
    const read = await c.call("tools/call", { name: "night_ferry", arguments: { action: "read" } });
    assert.strictEqual(read.result.isError, false);
    assert.strictEqual(text(read).written_tonight, null);

    const bg = tool.inputSchema.properties.background.enum[0];
    const bad = await c.call("tools/call", { name: "night_ferry", arguments: { action: "write", title: "灯塔", body: "太短" } });
    assert.strictEqual(bad.result.isError, true);
    const good = await c.call("tools/call", { name: "night_ferry", arguments: { action: "write", title: "每座灯塔都有自己的心跳", body: "每座灯塔闪的节奏都不一样。".repeat(10), background: bg } });
    assert.strictEqual(text(good).ok, true);
    const again = await c.call("tools/call", { name: "night_ferry", arguments: { action: "read" } });
    assert.strictEqual(text(again).written_tonight.title, "每座灯塔都有自己的心跳");

    assert.strictEqual((await c.call("tools/call", { name: "nope", arguments: {} })).error.code, -32602);
    assert.strictEqual((await c.call("resources/list", {})).error.code, -32601);
    assert.deepStrictEqual((await c.call("ping", {})).result, {});
    assert.deepStrictEqual(c.stray, []); // the notification got no reply, nothing else leaked onto stdout

    // protocol edges: an unknown revision gets ours; things that are not requests are not answered as if they were
    assert.strictEqual((await c.call("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion, "2025-06-18");
    c.raw({ jsonrpc: "2.0", id: 999, result: {} });            // a response to a question we never asked
    c.raw({ jsonrpc: "2.0", method: "initialize", params: {} }); // a request with no id is a notification
    c.raw([1, 2, 3]);                                          // not an object → one "invalid request" with id null
    assert.deepStrictEqual((await c.call("ping", {})).result, {});
    assert.deepStrictEqual(c.stray.map((m) => [m.id, m.error && m.error.code]), [[null, -32600]]);
  } finally { await c.stop(); }
});
