#!/usr/bin/env node
// Copy the demo articles into the data directory so a fresh install has something to read:
//   npm run seed
// Refuses to touch a data directory that already has articles in it.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const dataDir = process.env.NIGHT_FERRY_DATA || path.join(ROOT, "data");
const file = path.join(dataDir, "night-ferry.jsonl");
if (fs.existsSync(file) && fs.readFileSync(file, "utf-8").trim()) {
  console.error(file + " already has content — not seeding over it.");
  process.exit(1);
}
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, "demo", "data.json"), "utf-8"));
fs.mkdirSync(path.join(dataDir, "images"), { recursive: true });
const lines = [];
for (const e of demo.entries) {
  const images = (e.images || []).filter((j) => j.file).map((j) => {
    fs.copyFileSync(path.join(ROOT, "public", "demo", "images", j.file), path.join(dataDir, "images", j.file));
    return { n: j.n, want: j.caption, req: "", status: "approved", round: 1, reasons: [], seen: [], file: j.file, caption: j.caption, credit: j.credit, note: j.note, source_url: j.source_url, license: j.license, pushed: true };
  });
  lines.push({ kind: "entry", ...e, images, pushed_at: e.ts });
}
for (const w of demo.wishes || []) lines.push({ kind: "wish", ...w });
for (const l of demo.logs || []) lines.push({ kind: "log", ...l });
if (demo.theme) lines.push({ kind: "theme", id: "theme", ts: new Date().toISOString(), text: demo.theme });
fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
console.log("seeded " + demo.entries.length + " articles into " + file);
