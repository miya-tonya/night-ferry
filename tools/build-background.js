#!/usr/bin/env node
// Turn any picture into a Night Ferry wallpaper.
//
//   node tools/build-background.js <image> <name> [--id <file-id>] [--ratio 1.3] [--default]
//
// Writes into public/assets/backgrounds/:
//   <id>.webp      1080px wide block: the picture on top, its vertical mirror below.
//                  The reader tiles this block down the page, so the wallpaper loops
//                  without a seam however long the article is.
//   <id>-t2.webp   540x243 strip (centred 30% down the picture) for the overview list.
// and adds / updates the entry in backgrounds.json. <name> is what the writer picks
// (`background` in the night_ferry tool), <id> is only the file name.
//
// --ratio crops to height/width = ratio first (centre of interest kept); leave it out
// to keep the picture's own proportions. Needs `sharp`.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const WIDTH = 1080, THUMB_W = 540, THUMB_H = 243, THUMB_CENTRE = 0.3;
const DIR = path.join(__dirname, "..", "public", "assets", "backgrounds");
const LIST = path.join(DIR, "backgrounds.json");

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--default") opt.default = true;
    else if (a === "--id" || a === "--ratio") opt[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { src: pos[0], name: pos[1], opt };
}

async function build(src, name, opt) {
  opt = opt || {};
  const id = opt.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw new Error("this name has no latin letters to make a file name from; pass --id <file-id>");
  fs.mkdirSync(DIR, { recursive: true });

  let input = await sharp(src).rotate().toBuffer();
  const ratio = Number(opt.ratio) || 0;
  if (ratio > 0) {
    // cover-crop to the wanted proportions, keeping the busiest part of the picture.
    // (Done as its own step: a second .resize() on one pipeline replaces the first.)
    const meta = await sharp(input).metadata();
    const w = Math.min(meta.width, Math.round(meta.height / ratio));
    const h = Math.min(meta.height, Math.round(w * ratio));
    input = await sharp(input).resize({ width: w, height: h, fit: "cover", position: sharp.strategy.attention }).toBuffer();
  }
  const top = await sharp(input).resize({ width: WIDTH }).flatten({ background: "#000" }).toBuffer();
  const { height } = await sharp(top).metadata();
  const mirror = await sharp(top).flip().toBuffer();
  await sharp({ create: { width: WIDTH, height: height * 2, channels: 3, background: "#000" } })
    .composite([{ input: top, left: 0, top: 0 }, { input: mirror, left: 0, top: height }])
    .webp({ quality: 80 })
    .toFile(path.join(DIR, id + ".webp"));

  const small = await sharp(top).resize({ width: THUMB_W }).toBuffer();
  const sm = await sharp(small).metadata();
  const stripH = Math.min(THUMB_H, sm.height);
  const y = Math.max(0, Math.min(sm.height - stripH, Math.round(sm.height * THUMB_CENTRE - stripH / 2)));
  await sharp(small).extract({ left: 0, top: y, width: THUMB_W, height: stripH }).webp({ quality: 78 }).toFile(path.join(DIR, id + "-t2.webp"));

  let list = [];
  try { list = JSON.parse(fs.readFileSync(LIST, "utf-8")); } catch (_) {}
  if (!Array.isArray(list)) throw new Error("backgrounds.json is not a list — fix it by hand first");
  const entry = { name, file: id + ".webp", thumb: id + "-t2.webp" };
  if (opt.default) { for (const b of list) delete b.default; entry.default = true; }
  const at = list.findIndex((b) => b.name === name);
  if (at >= 0) list[at] = { ...list[at], ...entry }; else list.push(entry);
  fs.writeFileSync(LIST, JSON.stringify(list, null, 2) + "\n");
  return { id, width: WIDTH, height: height * 2 };
}

module.exports = { build };

if (require.main === module) {
  const { src, name, opt } = parseArgs(process.argv.slice(2));
  if (!src || !name) {
    console.error("usage: node tools/build-background.js <image> <name> [--id <file-id>] [--ratio 1.3] [--default]");
    process.exit(1);
  }
  build(src, name, opt).then(
    (r) => console.log("wrote " + r.id + ".webp (" + r.width + "x" + r.height + ") and " + r.id + "-t2.webp; listed as \"" + name + "\""),
    (e) => { console.error(e.message); process.exit(1); }
  );
}
