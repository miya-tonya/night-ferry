// Let a model write tonight's article, end to end: it reads what the reader asked for,
// writes, waits for the pictures, looks at them, approves or sends them back.
//
//   ANTHROPIC_API_KEY=... npm run write
//
// This is the whole integration in one file. In a real companion you would not run a
// separate script: you add `ferry.tool` to the tools your agent already has, route its
// calls to `ferry.execute`, and put `ferry.wakeNote()` / `ferry.imagesNotice()` into the
// prompt whenever the agent wakes up on its own.
"use strict";
const Anthropic = require("@anthropic-ai/sdk");
const { createFerry } = require("../server/ferry");

const MODEL = process.env.NIGHT_FERRY_MODEL || "claude-opus-5-5";
const MAX_TURNS = 24;

async function main() {
  const client = new Anthropic();
  const ferry = createFerry();
  const tools = [{ name: ferry.tool.name, description: ferry.tool.description, input_schema: ferry.tool.input_schema }];

  const note = [ferry.wakeNote(), ferry.imagesNotice()].filter(Boolean).join("\n\n"); // unwritten article, unread notes, pictures waiting
  if (!note) { console.log("Nothing to do: tonight's article is written and there are no unread notes or pictures waiting."); return; }
  const messages = [{ role: "user", content: note + "\n\n先 read 看看，再动笔。写完如果有配图，等一会儿 check_images，全部过目完再结束。" }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // If a safety classifier declines a turn, the API re-runs it on a fallback model
      // instead of stopping. Remove these two lines if you would rather it just stop.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: "你在给一位固定的读者写「夜航船」：每晚一篇有意思的冷知识或科普，像睡前读的那种。拿不准的事实就说拿不准，不要编出处。",
      tools,
      messages,
    });
    // Keep the whole content array (thinking blocks included) — it has to go back unchanged.
    messages.push({ role: "assistant", content: response.content });
    for (const b of response.content) if (b.type === "text" && b.text.trim()) console.log("\n" + b.text.trim());

    if (response.stop_reason === "refusal") { console.error("The model declined (" + ((response.stop_details && response.stop_details.category) || "no category") + ")."); return; }
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") break;

    const results = [];
    for (const b of response.content) {
      if (b.type !== "tool_use") continue;
      console.log("→ night_ferry " + (b.input.action || "?") + (b.input.title ? " 《" + b.input.title + "》" : "") + (b.input.n ? " #" + b.input.n : ""));
      let content, isError = false;
      try {
        const out = await ferry.execute(b.input);
        content = ferry.toolResultContent(out);
        if (out.result && out.result.note) console.log("  " + out.result.note);
        if (out.result && out.result.error) console.log("  ✗ " + out.result.error);
      } catch (e) { content = "night_ferry failed: " + e.message; isError = true; }
      results.push({ type: "tool_result", tool_use_id: b.id, content, ...(isError ? { is_error: true } : {}) });
    }
    // The pictures take ten-odd seconds each; give them a moment before the model looks.
    if (ferry.imagesNotice() === "" && ferry.load().entries.some((e) => (e.images || []).some((j) => j.status === "searching"))) {
      await new Promise((r) => setTimeout(r, 15000));
    }
    messages.push({ role: "user", content: results });
  }
  const tonight = ferry.load().entries.find((e) => e.night === ferry.ferryNight());
  console.log(tonight ? "\nTonight: 《" + tonight.title + "》 — open the reader page to see it." : "\nNo article was written this run.");
}

main().catch((error) => {
  if (error instanceof Anthropic.AuthenticationError) console.error("No valid Claude API credential (set ANTHROPIC_API_KEY, or run `ant auth login`).");
  else if (error instanceof Anthropic.RateLimitError) console.error("Rate limited — try again in a minute.");
  else if (error instanceof Anthropic.APIError) console.error("Claude API error " + error.status + ": " + error.message);
  else console.error(error);
  process.exit(1);
});
