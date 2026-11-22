// Picture jobs across restarts and processes, notification failures, line endings.
// No network: the model stub answers nothing, so every search ends before it would go out.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createNightFerry } = require("../server/night-ferry");

let hasSharp = true;
try { require("sharp"); } catch (_) { hasSharp = false; }
const needsSharp = { skip: hasSharp ? false : "sharp is not installed (it is an optional dependency)" };

const BGS = [{ name: "月夜海", file: "moonsea.webp", default: true }, { name: "海浪", file: "wave.webp" }];
const BODY = "每座灯塔闪的节奏都不一样。".repeat(10);
const MARKED = BODY + "\n\n【图：夜里的灯塔】\n\n" + BODY;
function open(dataDir, extra) {
  const nf = createNightFerry({ dataDir, backgrounds: BGS, utcOffsetMinutes: 0, logger: () => {}, ...extra });
  return { nf, run: async (input) => (await nf.execute(input)).result };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nf-pic-"));
const job = (nf, id) => nf.load().entries.find((e) => e.id === id).images[0];

test("a process without a model leaves another process's search alone", needsSharp, async () => {
  const dir = tmp();
  let release;
  const gate = new Promise((r) => { release = r; });
  const writer = open(dir, { llm: async () => { await gate; return ""; } }); // a search that is under way
  const w = await writer.run({ action: "write", title: "灯塔", body: MARKED, background: "海浪" });
  assert.strictEqual(w.images_pending, 1);

  const web = open(dir); // e.g. the web server, started with no model configured
  assert.strictEqual(web.nf.resumeImageJobs(), 1);
  await web.nf.idle();
  assert.strictEqual(job(web.nf, w.id).status, "searching"); // not marked failed behind the writer's back

  release();
  await writer.nf.idle();
  assert.strictEqual(job(writer.nf, w.id).status, "failed"); // the process that can search reached its own verdict
});

test("a claim left by a dead process is taken over; a live one is respected", needsSharp, async () => {
  const dir = tmp();
  // an article with a picture still "searching", as a crashed process would leave it
  const seed = open(dir, { llm: async () => "" });
  const entry = { kind: "entry", id: "nf_crashed", ts: new Date().toISOString(), night: "2026-01-01", title: "灯塔", body: MARKED, topic: "", wish_id: null, background: "海浪",
    images: [{ n: 1, want: "夜里的灯塔", req: "", status: "searching", round: 1, reasons: [], seen: [] }] };
  fs.appendFileSync(path.join(dir, "night-ferry.jsonl"), JSON.stringify(entry) + "\n");
  const claim = path.join(dir, "images", ".claim-nf_crashed-1-r1");

  fs.writeFileSync(claim, String(process.ppid)); // held by a process that is alive
  assert.strictEqual(seed.nf.resumeImageJobs(), 1);
  await seed.nf.idle();
  assert.strictEqual(job(seed.nf, "nf_crashed").status, "searching");

  fs.writeFileSync(claim, "2147483646"); // held by a pid that does not exist
  seed.nf.resumeImageJobs();
  await seed.nf.idle();
  assert.strictEqual(job(seed.nf, "nf_crashed").status, "failed"); // searched (and found nothing) instead of waiting forever
  assert.strictEqual(fs.existsSync(claim), false);
});

test("a search that never comes back can be dropped, and the article is then released", needsSharp, async () => {
  const dir = tmp();
  const pushes = [];
  const { nf, run } = open(dir, { llm: () => new Promise(() => {}), notify: async (m) => { pushes.push(m.body); return true; } }); // the model never answers
  const w = await run({ action: "write", title: "灯塔", body: MARKED, background: "海浪" });
  assert.strictEqual(job(nf, w.id).status, "searching");
  assert.match((await run({ action: "reject", id: w.id, n: 1, reason: "换一张" })).error, /还在找/);
  const d = await run({ action: "reject", id: w.id, n: 1, drop: true });
  assert.strictEqual(d.status, "dropped");
  assert.strictEqual(d.pushed, true);
  assert.deepStrictEqual(pushes, ["《灯塔》"]);
});

test("a notification that fails is recorded, not passed off as delivered", async () => {
  const { nf, run } = open(tmp(), { notify: async () => { throw new Error("push service down"); } });
  const w = await run({ action: "write", title: "灯塔", body: BODY, background: "海浪" });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(w.pushed, false);
  const e = nf.load().entries[0];
  assert.strictEqual(e.push_ok, false);
  assert.ok(e.pushed_at); // released to the page all the same
});

test("CRLF line endings do not glue paragraphs together or hide a marker", async () => {
  const { nf, run } = open(tmp());
  const w = await run({ action: "write", title: "灯塔", body: BODY + "\r\n\r\n" + BODY + "\r\n\r\n【图：夜里的灯塔】", background: "海浪" });
  assert.strictEqual(w.ok, true);
  const body = nf.load().entries[0].body;
  assert.strictEqual(body.includes("\r"), false);
  assert.strictEqual(body.split(/\n{2,}/).length, 3);
  assert.match(w.note, /1 处图标记/);
});
