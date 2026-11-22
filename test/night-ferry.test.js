// Tests for the server module. No network and no model: the picture pipeline is exercised
// up to the point where it would go out (and with a stubbed fetch for one full round).
//   npm test
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createNightFerry } = require("../server/night-ferry");

const BGS = [
  { name: "月夜海", file: "moonsea.webp", thumb: "moonsea-t2.webp", default: true },
  { name: "海浪", file: "wave.webp", thumb: "wave-t2.webp" },
  { name: "星空", file: "starry.webp" },
];
const BODY = "信天翁几乎不扇翅膀。".repeat(12);
function make(extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nf-test-"));
  let t = Date.UTC(2026, 10, 2, 20, 0, 0); // 22:00 at +02:00
  const pushes = [];
  const nf = createNightFerry({
    dataDir, backgrounds: BGS, utcOffsetMinutes: 120, now: () => t, logger: () => {},
    notify: async (m) => { pushes.push(m); return true; }, ...extra,
  });
  return { nf, dataDir, pushes, advance: (ms) => { t += ms; }, run: async (input) => (await nf.execute(input)).result };
}

test("the tool definition lists the wallpapers, without the default one", () => {
  const { nf } = make();
  assert.strictEqual(nf.tool.name, "night_ferry");
  assert.deepStrictEqual(nf.tool.input_schema.properties.background.enum, ["海浪", "星空"]);
  assert.ok(nf.tool.description.includes("夜航船"));
});

test("write: needs a title, a body and a wallpaper; one article a night", async () => {
  const { run, pushes, advance, nf } = make();
  assert.match((await run({ action: "write", title: "", body: BODY, background: "海浪" })).error, /title/);
  assert.match((await run({ action: "write", title: "t", body: "太短", background: "海浪" })).error, /太短/);
  assert.match((await run({ action: "write", title: "t", body: BODY })).error, /background/);
  assert.match((await run({ action: "write", title: "t", body: BODY, background: "月夜海" })).error, /挑一个/);
  const ok = await run({ action: "write", title: "信天翁", body: BODY, background: "海浪", topic: "动物", place: "南大洋" });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.night, "2026-11-02");
  assert.strictEqual(ok.pushed, true);
  assert.deepStrictEqual(pushes.map((p) => p.body), ["《信天翁》"]);
  assert.match((await run({ action: "write", title: "又一篇", body: BODY, background: "星空" })).error, /今晚已经写过了/);
  advance(4 * 3600000); // 02:00 next day still counts as the same night
  assert.match((await run({ action: "write", title: "又一篇", body: BODY, background: "星空" })).error, /今晚已经写过了/);
  advance(24 * 3600000);
  assert.strictEqual((await run({ action: "write", title: "第二晚", body: BODY, background: "星空" })).ok, true);
  assert.strictEqual(nf.load().entries.length, 2);
});

test("wishes: writing the wished topic crosses it off; read shows only open ones", async () => {
  const { nf, run } = make();
  const app = require("express")();
  app.use("/api/night-ferry", nf.router());
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port + "/api/night-ferry";
  try {
    const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const w = (await post("/wishes", { name: "信天翁怎么飞" })).entry;
    await post("/theme", { text: "海洋" });
    let r = await run({ action: "read" });
    assert.deepStrictEqual(r.wishes.map((x) => x.name), ["信天翁怎么飞"]);
    assert.strictEqual(r.theme, "海洋");
    assert.strictEqual(r.written_tonight, null);
    assert.match(nf.wakeNote(), /还没写/);
    const written = await run({ action: "write", title: "信天翁", body: BODY, background: "海浪", wish_id: w.id });
    assert.strictEqual(written.wish_done, "信天翁怎么飞");
    r = await run({ action: "read" });
    assert.deepStrictEqual(r.wishes, []);
    assert.strictEqual(r.written_tonight.title, "信天翁");

    // the page's view
    const page = await fetch(base + "?limit=5").then((x) => x.json());
    assert.strictEqual(page.entries.length, 1);
    assert.strictEqual(page.entries[0].background, "海浪");
    assert.deepStrictEqual(page.backgrounds.map((b) => b.name), ["月夜海", "海浪", "星空"]);
    assert.strictEqual(page.backgrounds[0].default, true);
    assert.strictEqual(page.backgrounds[1].url, "assets/backgrounds/wave.webp");

    // ship's log: the reader writes, the writer is told, reading marks it read, the writer answers
    assert.strictEqual(nf.wakeNote(), "");
    const note = await post("/log", { entry_id: written.id, text: "原来翅膀会锁住。" });
    assert.strictEqual(note.log.who, "reader");
    assert.match(nf.wakeNote(), /新写了 1 条/);
    r = await run({ action: "read" });
    assert.deepStrictEqual(r.log_unread, [{ id: written.id, title: "信天翁", count: 1 }]);
    const one = await run({ action: "read", id: written.id });
    assert.strictEqual(one.entry.log.length, 1);
    assert.strictEqual(nf.wakeNote(), "");
    const back = await run({ action: "log", id: written.id, text: "像卡扣一样。" });
    assert.strictEqual(back.ok, true);
    const after = await fetch(base).then((x) => x.json());
    assert.deepStrictEqual(after.entries[0].log.map((l) => l.who), ["reader", "writer"]);
    // the reader may delete their own note, not the writer's
    const del = (id) => fetch(base + "/log/" + id, { method: "DELETE" }).then((x) => x.status);
    assert.strictEqual(await del(after.entries[0].log[1].id), 403);
    assert.strictEqual(await del(after.entries[0].log[0].id), 200);
  } finally { server.close(); }
});

let hasSharp = true;
try { require("sharp"); } catch (_) { hasSharp = false; }
test("picture markers: parsed from the body, capped, and the article waits for them", { skip: hasSharp ? false : "sharp is not installed (it is an optional dependency)" }, async () => {
  // a model that has nothing to say → each search fails cleanly before any network call (needs sharp installed)
  const { run, pushes, nf } = make({ llm: async () => "" });
  const body = BODY + "\n\n【图：滑翔的信天翁 | 照片】\n\n" + BODY + "\n\n[图：信天翁的求偶舞]";
  const w = await run({ action: "write", title: "信天翁", body, background: "海浪" });
  assert.strictEqual(w.images_pending, 2);
  assert.strictEqual(w.pushed, false);
  const c = await run({ action: "check_images", id: w.id });
  assert.deepStrictEqual(c.images.map((j) => [j.n, j.want, j.req, j.status]), [[1, "滑翔的信天翁", "照片", "failed"], [2, "信天翁的求偶舞", "", "failed"]]);
  assert.match(nf.imagesNotice(), /2 张没找到/);
  assert.deepStrictEqual(pushes, []);
  // dropping both = everything has been looked at → the reader is told now
  await run({ action: "reject", id: w.id, n: 1, drop: true });
  const last = await run({ action: "reject", id: w.id, n: 2, drop: true });
  assert.strictEqual(last.pushed, true);
  assert.strictEqual(nf.imagesNotice(), "");
  assert.match((await run({ action: "reject", id: w.id, n: 9, drop: true })).error, /没有第 9 张/);
});

test("without a picture pipeline, markers are ignored and the article is announced at once", async () => {
  const { run, pushes } = make(); // no llm configured
  const w = await run({ action: "write", title: "信天翁", body: BODY + "\n\n【图：滑翔的信天翁】", background: "海浪" });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(w.pushed, true);
  assert.strictEqual(w.images_pending, undefined);
  assert.match(w.note, /1 处图标记不会显示/);
  assert.deepStrictEqual(pushes.map((p) => p.body), ["《信天翁》"]);
});

test("limits: an over-long body is refused, not cut; a long wallpaper name can be chosen", async () => {
  const long = "夜".repeat(24);
  const { run, nf } = make({ backgrounds: BGS.concat([{ name: long, file: "x.webp" }]) });
  const tooLong = await run({ action: "write", title: "t", body: "字".repeat(3001), background: "海浪" });
  assert.match(tooLong.error, /太长了/);
  assert.strictEqual(nf.load().entries.length, 0);
  const ok = await run({ action: "write", title: "t", body: BODY, background: long });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(nf.load().entries[0].background, long);
});

test("a line cut short by a crash does not swallow the next record", async () => {
  const { run, nf, dataDir } = make();
  const w = await run({ action: "write", title: "信天翁", body: BODY, background: "海浪" });
  fs.appendFileSync(path.join(dataDir, "night-ferry.jsonl"), '{"kind":"log","id":"nfl_torn","entry_id"'); // no newline: a torn write
  assert.strictEqual((await run({ action: "log", id: w.id, text: "补一句。" })).ok, true);
  assert.deepStrictEqual(nf.load().logs.map((l) => l.text), ["补一句。"]);
});

test("storage is append-only: nothing is rewritten, later lines win", async () => {
  const { run, dataDir } = make();
  await run({ action: "write", title: "信天翁", body: BODY, background: "海浪" });
  const file = path.join(dataDir, "night-ferry.jsonl");
  const before = fs.readFileSync(file, "utf-8");
  await run({ action: "log", id: (await run({ action: "read" })).recent[0].id, text: "补一句。" });
  const after = fs.readFileSync(file, "utf-8");
  assert.ok(after.startsWith(before));
  assert.ok(after.length > before.length);
});

test("toolResultContent: JSON first, pictures after", () => {
  const { nf } = make();
  const content = nf.toolResultContent({ result: { ok: true }, images: [{ media_type: "image/jpeg", data: "QUJD" }] });
  assert.deepStrictEqual(content, [
    { type: "text", text: '{"ok":true}' },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
  ]);
});
