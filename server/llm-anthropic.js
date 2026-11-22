// The small model behind the picture pipeline, on the Claude API.
//
//   const { anthropicLlm } = require("./llm-anthropic");
//   createNightFerry({ ..., llm: anthropicLlm() });
//
// It is asked two things per picture: turn "what the writer wants to show" into Commons
// search words, and look at up to eight thumbnails and pick one. Both are short, so a
// small model is enough. Credentials come from the environment (ANTHROPIC_API_KEY, or an
// `ant auth login` profile) — nothing is read from this repository.
"use strict";
const Anthropic = require("@anthropic-ai/sdk");

function anthropicLlm(options) {
  const o = options || {};
  const client = o.client || new Anthropic();
  const model = o.model || process.env.NIGHT_FERRY_IMAGE_MODEL || "claude-haiku-5-5";
  return async function llm({ system, messages }) {
    const response = await client.messages.create({ model, max_tokens: 2000, system, messages });
    if (response.stop_reason === "refusal") throw new Error("the model declined this request");
    return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  };
}

module.exports = { anthropicLlm };
