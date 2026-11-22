// One place that turns environment variables into a configured Night Ferry — shared by the
// web server (server/index.js) and the MCP server (server/mcp.js) so both see the same thing.
//
//   NIGHT_FERRY_DATA          data directory (default ./data)
//   NIGHT_FERRY_READER        what the writer is told to call the reader (default 读者)
//   NIGHT_FERRY_PRONOUN       …and the pronoun (default TA)
//   NIGHT_FERRY_LLM           the picture pipeline's small model: anthropic | claude-code | codex | none
//                               anthropic    the Claude API (needs a credential)   ← default when ANTHROPIC_API_KEY or
//                                            ANTHROPIC_AUTH_TOKEN is set; if you logged in with `ant auth login`
//                                            instead, say NIGHT_FERRY_LLM=anthropic yourself
//                               claude-code  `claude -p`, on your Claude subscription
//                               codex        `codex exec`, on your ChatGPT subscription
//                               none         no pictures                          ← default otherwise
//   NIGHT_FERRY_IMAGE_MODEL   which model that is (defaults: claude-haiku-5-5 / haiku / your Codex default)
"use strict";
const path = require("path");
const { createNightFerry } = require("./night-ferry");

const ROOT = path.join(__dirname, "..");

function createFerry(extra) {
  const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const which = (process.env.NIGHT_FERRY_LLM || (hasKey ? "anthropic" : "none")).toLowerCase();
  let llm = null;
  try {
    if (which === "anthropic") llm = require("./llm-anthropic").anthropicLlm();
    else if (which === "claude-code") llm = require("./llm-cli").claudeCodeLlm();
    else if (which === "codex") llm = require("./llm-cli").codexLlm();
    else if (which !== "none") console.error("[night-ferry] unknown NIGHT_FERRY_LLM=" + which + " — picture pipeline off");
  } catch (e) { console.error("[night-ferry] picture pipeline off:", e.message); }
  return createNightFerry({
    dataDir: process.env.NIGHT_FERRY_DATA || path.join(ROOT, "data"),
    backgrounds: path.join(ROOT, "public", "assets", "backgrounds", "backgrounds.json"),
    readerName: process.env.NIGHT_FERRY_READER || undefined,
    readerPronoun: process.env.NIGHT_FERRY_PRONOUN || undefined,
    llm,
    // notify: async ({ title, body, url }) => { ...send a push to the reader's phone...; return true; },
    // onImagesReady: (entry) => { ...wake your agent so it can check the pictures now... },
    ...extra,
  });
}

module.exports = { createFerry, ROOT };
