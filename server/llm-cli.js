// The picture pipeline's small model, through a coding-agent CLI you are already logged in to —
// so it runs on your subscription instead of an API key.
//
//   NIGHT_FERRY_LLM=claude-code npm start      (uses `claude -p`, Claude Code's print mode)
//   NIGHT_FERRY_LLM=codex npm start            (uses `codex exec`)
//
// The pipeline asks two things per picture: three lines of search words, and "which of these
// eight thumbnails fits". Both CLIs take text on stdin; pictures are written to a temporary
// folder and handed over as files (Claude Code opens them with its Read tool, Codex takes
// them with --image). Each call starts a fresh, tool-restricted, one-shot session in that
// temporary folder — it cannot see or touch your project.
//
// Slower than the API (a CLI start-up per call, typically 5–20s) and it uses your plan's
// allowance. The writer itself does not go through here — see server/mcp.js for that.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const WIN = process.platform === "win32";

// On Windows the CLIs are .cmd shims, which need a shell, and a shell wants one command line.
// So every piece is checked before it gets there: only letters, digits, spaces and a few path /
// flag characters are allowed (no quotes, &, |, <, >, ^, %, ! …), and pieces with a space are
// wrapped in double quotes. Model output, article text and file names from the internet never
// reach the command line — they go in on stdin or as files we name ourselves — so this only
// guards the operator's own settings (the command path and the model name).
const SAFE = /^[\p{L}\p{N}_ .:\\/\-\[\],=@+~()]+$/u; // letters of any script: a home folder is not always ASCII
function shellPiece(x) {
  if (!SAFE.test(x)) throw new Error("refusing to put this on a command line: " + JSON.stringify(x));
  return /\s/.test(x) ? '"' + x + '"' : x;
}
function run(cmd, args, { cwd, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = WIN
      ? spawn([cmd].concat(args).map(shellPiece).join(" "), { cwd, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    // On Windows child.kill() would only end the shell and leave the CLI running, so take the whole tree down.
    const stop = () => { if (WIN) { try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch (_) {} } else child.kill(); };
    const timer = setTimeout(() => { stop(); reject(new Error(cmd + " timed out after " + Math.round(timeoutMs / 1000) + "s")); }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); // decode across chunk boundaries
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error("could not start `" + cmd + "` (" + e.message + ") — is it installed and on PATH?")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(cmd + " exited with " + code + ": " + (err || out).trim().slice(-300)));
      resolve(out);
    });
    child.stdin.end(input);
  });
}

// Anthropic-style messages → one prompt text + the pictures saved as files in `dir`.
function flatten(messages, dir, mention) {
  const files = [], parts = [];
  for (const m of messages) {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of content) {
      if (b.type === "text") parts.push(b.text);
      else if (b.type === "image" && b.source && b.source.type === "base64") {
        const name = "candidate-" + (files.length + 1) + (/png/.test(b.source.media_type) ? ".png" : ".jpg");
        fs.writeFileSync(path.join(dir, name), Buffer.from(b.source.data, "base64"));
        files.push(name);
        parts.push(mention(name, files.length));
      }
    }
  }
  return { prompt: parts.join("\n"), files };
}
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "night-ferry-llm-"));
  // On Windows a just-killed process tree can hold the folder for a moment: retry, and try once more a little later.
  const remove = () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); return true; } catch (_) { return false; } };
  return Promise.resolve().then(() => fn(dir)).finally(() => { if (!remove()) setTimeout(remove, 5000).unref(); });
}

// Claude Code, print mode. Logged in with a subscription → runs on it (an ANTHROPIC_API_KEY in
// the environment takes precedence, as always with `claude -p`).
function claudeCodeLlm(options) {
  const o = options || {};
  const bin = o.command || "claude";
  const model = o.model || process.env.NIGHT_FERRY_IMAGE_MODEL || "haiku";
  return ({ system, messages }) => withTempDir(async (dir) => {
    const { prompt, files } = flatten(messages, dir, (name) => "（这张图存在当前目录的 " + name + "，用 Read 工具打开看）");
    fs.writeFileSync(path.join(dir, "system.txt"), system || "");
    const args = [
      "-p", "Answer the request given on stdin.",
      "--model", model,
      "--system-prompt-file", "system.txt",
      "--output-format", "json",
      "--strict-mcp-config",            // do not load the user's MCP servers into this one-shot
      "--setting-sources", "project",   // ...nor their hooks and personal settings (the working folder is an empty temp dir)
      "--max-turns", String(files.length + 4),
      ...(files.length ? ["--allowedTools", "Read"] : []),
    ];
    const out = await run(bin, args, { cwd: dir, input: prompt, timeoutMs: o.timeoutMs || 180000 });
    let j;
    try { j = JSON.parse(out); } catch (_) { throw new Error("claude -p did not return JSON: " + out.slice(0, 200)); }
    if (j.is_error) throw new Error("claude -p reported an error: " + String(j.result || "").slice(0, 200));
    return String(j.result || "");
  });
}

// Codex, non-interactive. Reuses the saved `codex login`.
function codexLlm(options) {
  const o = options || {};
  const bin = o.command || "codex";
  const model = o.model || process.env.NIGHT_FERRY_IMAGE_MODEL || "";
  return ({ system, messages }) => withTempDir(async (dir) => {
    const { prompt, files } = flatten(messages, dir, (name, n) => "（第 " + n + " 张附图）");
    const args = [
      "exec", "--skip-git-repo-check", "--sandbox", "read-only",
      "--output-last-message", "answer.txt",
      ...(model ? ["--model", model] : []),
      ...(files.length ? ["--image", files.join(",")] : []),
      "-",                               // read the prompt from stdin
    ];
    await run(bin, args, { cwd: dir, input: (system ? system + "\n\n" : "") + prompt, timeoutMs: o.timeoutMs || 240000 });
    try { return fs.readFileSync(path.join(dir, "answer.txt"), "utf-8"); }
    catch (_) { throw new Error("codex exec finished without writing an answer"); } // (the raw error would carry a temp path)
  });
}

module.exports = { claudeCodeLlm, codexLlm };
