// Night Ferry — one short bedtime article a night, written by an AI for one reader.
//
//   const nf = createNightFerry({ dataDir, backgrounds, llm, notify, onImagesReady, ... });
//   app.use("/api/night-ferry", nf.router());          // what the reader page talks to
//   nf.tool                                            // tool definition for the writer (Anthropic tool format)
//   await nf.execute(input)  → { result, images }      // run one tool call
//   nf.toolResultContent(out)                          // → content blocks for a tool_result
//   nf.wakeNote() / nf.imagesNotice()                  // one-liners to drop into the writer's next prompt
//   nf.resumeImageJobs()                               // call once at start-up: continue searches a restart interrupted
//   await nf.idle()                                    // resolves when no picture search is running (call before exiting)
//
// Options (only dataDir is required):
//   dataDir            where night-ferry.jsonl and images/ live
//   backgrounds        wallpapers the writer may pick: an array [{name, file, thumb?, default?}] or the path of a JSON file holding one
//   backgroundsUrl     URL prefix of those files as the page sees them (default "assets/backgrounds")
//   llm                async ({purpose, system, messages}) => text — the small model of the picture pipeline; none = no pictures
//   notify             async ({title, body, url}) => truthy — tell the reader something is ready (a push, a mail…); optional.
//                      A failed notify is logged and recorded on the entry (push_ok: false), not retried.
//   onImagesReady      (entry) => void — pictures are waiting for the writer; wake your agent here; optional
//   readerName, readerPronoun   how the tool's instructions refer to the reader (defaults "读者" / "TA")
//   utcOffsetMinutes   the reader's timezone (default: this machine's); nightShiftHours: how late still counts as "tonight" (default 6)
//   maxImages (4), maxRounds (4), userAgent (sent to Commons — name your site), imagesUrl, pageUrl, now, logger
//
// Storage is a single append-only JSONL file (dataDir/night-ferry.jsonl). A later line
// with the same id replaces the earlier one; {id, deleted:true} is a tombstone. Nothing
// is ever rewritten in place, so the file is also the history.
//
// Illustrations: a line in the article body that reads 【图：what to show | requirement】
// asks for a picture. The pipeline turns it into search words (llm), searches Wikimedia
// Commons, lets the llm look at the candidates and pick one, stores it, and then waits
// for the writer to check it (check_images → approve / reject). The reader is only
// notified once every picture has been looked at. Needs `sharp` and an `llm`; without
// them articles still work, they just have no pictures.
//
// No authentication here. Mount the router behind whatever protects your site.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let sharp = null;
try { sharp = require("sharp"); } catch (_) { /* optional: only the picture pipeline needs it */ }

const LOG_MAX = 300;
const BODY_MAX = 3000;
const WISH_OPEN_MAX = 100;      // open wishes the page may hold
const LOG_PER_ENTRY_MAX = 200;  // notes under one article
// CSS sepia(.12) as a colour matrix, then a touch less contrast: the "old photograph"
// look is baked into the file so the page needs no filter (filters repaint every frame
// during the entrance animation).
const SEPIA = (() => {
  const a = 0.12, S = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
  return S.map((r, i) => r.map((v, j) => (1 - a) * (i === j ? 1 : 0) + a * v));
})();

const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const stripHtml = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const newId = (prefix) => prefix + "_" + crypto.randomBytes(6).toString("base64url");

function createNightFerry(options) {
  const o = options || {};
  if (!o.dataDir) throw new Error("createNightFerry: dataDir is required");
  const FILE = path.join(o.dataDir, "night-ferry.jsonl");
  const IMAGE_DIR = path.join(o.dataDir, "images");
  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  const READER = o.readerName || "读者";           // how the writer is told to call the reader
  const P = o.readerPronoun || "TA";               // …and the pronoun
  const MAX_IMAGES = o.maxImages || 4;
  const MAX_ROUNDS = o.maxRounds || 4;
  const USER_AGENT = o.userAgent || "night-ferry/0.1 (self-hosted reader; set userAgent to identify your site)";
  const IMAGES_URL = o.imagesUrl || "api/night-ferry/images"; // as the page sees it (page-relative by default)
  const PAGE_URL = o.pageUrl || "night-ferry.html";
  // "Tonight" = local date shifted back a few hours, so an article written at 00:30 still
  // belongs to the evening before.
  // asked per moment rather than fixed at start-up, so a daylight-saving change is followed
  const utcOffsetMin = (ms) => (o.utcOffsetMinutes != null ? o.utcOffsetMinutes : -new Date(ms).getTimezoneOffset());
  const NIGHT_SHIFT_H = o.nightShiftHours != null ? o.nightShiftHours : 6;
  const now = o.now || (() => Date.now());
  const log = o.logger || ((...a) => console.error("[night-ferry]", ...a));

  // ---- wallpapers the writer may choose from: [{name, file, thumb, default?}] ----
  const BG_URL = o.backgroundsUrl || "assets/backgrounds";
  function loadBackgrounds() {
    let list = o.backgrounds;
    if (typeof list === "string") { try { list = JSON.parse(fs.readFileSync(list, "utf-8")); } catch (_) { list = []; } }
    return (Array.isArray(list) ? list : []).filter((b) => b && b.name && b.file);
  }
  const bgNames = () => loadBackgrounds().filter((b) => !b.default).map((b) => b.name);
  const bgPublic = () => loadBackgrounds().map((b) => ({ name: b.name, url: BG_URL + "/" + b.file, thumb: b.thumb ? BG_URL + "/" + b.thumb : null, default: !!b.default }));

  // ---- storage ----
  // If a crash left the last line unfinished, start on a fresh line instead of gluing this record onto the fragment.
  function endsClean() {
    try {
      const fd = fs.openSync(FILE, "r");
      try { const size = fs.fstatSync(fd).size; if (!size) return true; const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); return b[0] === 10; }
      finally { fs.closeSync(fd); }
    } catch (_) { return true; }
  }
  function append(obj) { fs.appendFileSync(FILE, (endsClean() ? "" : "\n") + JSON.stringify(obj) + "\n"); }
  function load() {
    let raw;
    try { raw = fs.readFileSync(FILE, "utf-8"); }
    catch (_) { return { entries: [], wishes: [], theme: "", logs: [], logReads: {} }; }
    const byId = new Map();
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let obj;
      try { obj = JSON.parse(s); } catch (_) { continue; }
      if (!obj || !obj.id) continue;
      if (obj.deleted === true) byId.delete(obj.id);
      else byId.set(obj.id, obj);
    }
    const all = [...byId.values()];
    const newestFirst = (a, b) => (a.ts > b.ts ? -1 : 1);
    const themeObj = byId.get("theme");
    const logReads = {};
    for (const x of all) if (x.kind === "logread" && x.entry_id) logReads[x.entry_id] = x.ts;
    return {
      logs: all.filter((x) => x.kind === "log" && x.entry_id && x.text).sort((a, b) => (a.ts < b.ts ? -1 : 1)),
      logReads,
      entries: all.filter((x) => x.kind === "entry").sort(newestFirst),
      wishes: all.filter((x) => x.kind === "wish").sort((a, b) => {
        if (!!a.done_at !== !!b.done_at) return a.done_at ? 1 : -1;
        return newestFirst(a, b);
      }),
      theme: themeObj ? String(themeObj.text || "") : "",
    };
  }
  const nowIso = () => new Date(now()).toISOString();
  function ferryNight(ms) {
    const t = ms || now();
    return new Date(t + utcOffsetMin(t) * 60000 - NIGHT_SHIFT_H * 3600000).toISOString().slice(0, 10);
  }
  function localTime(ts) {
    const t = new Date(ts).getTime(), d = new Date(t + utcOffsetMin(t) * 60000), p = (n) => String(n).padStart(2, "0");
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
  }
  function findEntry(data, id) {
    id = String(id || "").trim();
    if (!id) return null;
    return data.entries.find((e) => e.id === id) || (id.length >= 6 ? data.entries.find((e) => e.id.startsWith(id)) : null) || null;
  }
  function saveEntry(entry) { entry.updated_at = nowIso(); append(entry); return entry; }

  // ---- article fields & picture markers ----
  function parseMarkers(body) {
    const out = [];
    for (const line of String(body || "").split("\n")) {
      const m = line.trim().match(/^[【\[]图[:：]\s*(.+?)\s*[】\]]$/);
      if (!m) continue;
      const parts = m[1].split("|");
      out.push({ want: parts[0].trim().slice(0, 80), req: parts.slice(1).join("|").trim().slice(0, 80) });
    }
    return out.slice(0, MAX_IMAGES);
  }
  function applyFields(entry, input) {
    const changed = [];
    for (const [k, max] of [["title", 40], ["topic", 20], ["background", 60], ["note", 80], ["weather", 20], ["place", 20], ["coords", 40]]) {
      if (input[k] == null) continue;
      const v = clean(input[k], max);
      if (k === "title" && !v) continue;
      if (k === "background" && v && !bgNames().includes(v)) return { error: "background 要从这些里挑一个：" + bgNames().join(" / ") };
      if ((entry[k] || "") !== v) { entry[k] = v; changed.push(k); }
    }
    return { changed };
  }
  // Turn the body's markers into picture jobs (new markers start a search). There is no "edit" action
  // today, so this only ever runs on a new article; it is written to also re-sync an edited body —
  // jobs whose marker text is unchanged keep their state — should one be added.
  function syncImageJobs(entry, body) {
    const marks = parseMarkers(body);
    const old = Array.isArray(entry.images) ? entry.images : [];
    const used = new Set();
    entry.images = marks.map((m, i) => {
      const k = old.findIndex((x, idx) => !used.has(idx) && x.want === m.want && (x.req || "") === m.req);
      if (k >= 0) { used.add(k); return { ...old[k], n: i + 1 }; }
      return { n: i + 1, want: m.want, req: m.req, status: "searching", round: 1, reasons: [], seen: [] };
    });
    return entry.images.filter((j) => j.status === "searching").length;
  }
  // none | searching | waiting (something for the writer to look at) | done
  function imageStatus(e) {
    const imgs = Array.isArray(e.images) ? e.images : [];
    if (!imgs.length) return "none";
    if (imgs.some((j) => j.status === "searching")) return "searching";
    if (imgs.some((j) => j.status === "ready" || j.status === "failed")) return "waiting";
    return "done";
  }

  // ---- ship's log: notes under each article, by the reader and by the writer ----
  // The writer's "unread" is state, not bookkeeping at format time: a reader note newer
  // than the writer's last `read` of that article is unread.
  const logsOf = (data, entryId) => (data.logs || []).filter((l) => l.entry_id === entryId);
  function logUnread(data, entryId) {
    const seen = (data.logReads || {})[entryId] || "";
    return logsOf(data, entryId).filter((l) => l.who === "reader" && l.ts > seen);
  }
  function logMarkRead(entryId) { append({ kind: "logread", id: "nflr_" + entryId, entry_id: entryId, ts: nowIso() }); }
  const logForWriter = (data, entryId) => logsOf(data, entryId).map((l) => ({ who: l.who === "reader" ? READER : "你", time: localTime(l.ts), text: l.text }));

  // What the page gets: only approved pictures (the slot stays, url null = the page hides that line).
  function publicEntry(e, data) {
    const { images, ...rest } = e;
    const imgs = Array.isArray(images) ? images : [];
    return {
      ...rest,
      log: data ? logsOf(data, e.id).map((l) => ({ id: l.id, ts: l.ts, who: l.who, text: l.text })) : [],
      images: imgs.map((j) => (j.status === "approved"
        ? { n: j.n, url: IMAGES_URL + "/" + j.file, caption: j.caption || "", credit: j.credit || "", note: j.note || "", source_url: j.source_url || "" }
        : { n: j.n, url: null })),
      image_status: imageStatus(e),
    };
  }
  function entryForWriter(e) {
    return {
      id: e.id, night: e.night, title: e.title, topic: e.topic || "", body: e.body,
      background: e.background || "", note: e.note || "", weather: e.weather || "", place: e.place || "", coords: e.coords || "",
      pushed_at: e.pushed_at || null,
      images: (e.images || []).map((j) => ({ n: j.n, want: j.want, req: j.req || "", status: j.status, round: j.round || 1, caption: j.caption || "", credit: j.credit || "", note: j.note || "", error: j.error || undefined })),
    };
  }

  // ---- picture pipeline ----
  // Be a polite Commons client: one request at a time, ≥400ms apart, back off on 429/503.
  let wmQueue = Promise.resolve(), wmLast = 0;
  function wmSlot() {
    const p = wmQueue.then(async () => {
      const wait = wmLast + 400 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      wmLast = Date.now();
    });
    wmQueue = p.catch(() => {});
    return p;
  }
  async function wmFetch(url, opts, timeoutMs) {
    const backoff = [2000, 5000, 12000];
    for (let k = 0; ; k++) {
      await wmSlot();
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if ((r.status === 429 || r.status === 503) && k < backoff.length) {
        const ra = Number(r.headers.get("retry-after")) * 1000;
        await new Promise((res) => setTimeout(res, Math.min(30000, ra > 0 ? ra : backoff[k])));
        continue;
      }
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url.slice(0, 80));
      return r;
    }
  }
  const wmJson = async (url) => (await wmFetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }, 20000)).json();
  const wmBuf = async (url) => Buffer.from(await (await wmFetch(url, { headers: { "User-Agent": USER_AGENT } }, 30000)).arrayBuffer());

  async function searchQueries(entry, job) {
    const system = "你是给文章找配图的助手。给你文章标题、这个位置想要的画面和要求，输出 3 行适合在 Wikimedia Commons 搜图的英文关键词（Commons 的搜索是所有词 AND 匹配，词越多命中越少）：第 1 行 3 个词（最具体的画面）、第 2 行 2 个词、第 3 行 1 个核心名词。只用常见的英文名词，不要年代、不要形容词堆砌、不要编号、不要解释、不要引号。";
    let u = "标题：" + entry.title + "\n画面：" + job.want + "\n要求：" + (job.req || "无");
    const reasons = job.reasons || [];
    if (reasons.length) u += "\n上一轮找到的被打回了，原因：" + reasons[reasons.length - 1] + "\n这次换个角度找。";
    const text = await o.llm({ purpose: "image_queries", system, messages: [{ role: "user", content: u }] });
    return String(text || "").split("\n").map((l) => l.replace(/^[\s\-\d.)]+/, "").replace(/["'“”]/g, "").trim()).filter((l) => l && l.length < 80).slice(0, 3);
  }
  async function commonsCandidates(queries, seen) {
    // search with all three word sets, interleave the hits (most specific first), look up at most 24 files
    const lists = [];
    for (const q of queries) {
      try {
        const j = await wmJson("https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srnamespace=6&srlimit=10&srsearch=" + encodeURIComponent(q + " filetype:bitmap"));
        lists.push(((j.query && j.query.search) || []).map((s) => s.title).filter((t) => !seen.includes(t)));
      } catch (e) { log("image search failed:", e.message); }
    }
    const titles = [];
    for (let i = 0; i < 10 && titles.length < 24; i++) for (const l of lists) if (l[i] && !titles.includes(l[i]) && titles.length < 24) titles.push(l[i]);
    if (!titles.length) return [];
    const j = await wmJson("https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1280&iiextmetadatafilter=LicenseShortName|Artist|ImageDescription&titles=" + encodeURIComponent(titles.join("|")));
    const out = [];
    for (const p of Object.values((j.query && j.query.pages) || {})) {
      const ii = p.imageinfo && p.imageinfo[0];
      if (!ii || !/^image\/(jpeg|png)$/.test(ii.mime || "")) continue;
      if ((ii.width || 0) < 500 || (ii.height || 0) < 350) continue;
      const ratio = ii.width / ii.height;
      if (ratio < 1.2 || ratio > 2.6) continue; // the page lays pictures out as landscape photographs
      const em = ii.extmetadata || {};
      out.push({
        title: p.title, thumb: ii.thumburl || ii.url, page: ii.descriptionurl, w: ii.width, h: ii.height,
        license: stripHtml(em.LicenseShortName && em.LicenseShortName.value).slice(0, 30),
        author: stripHtml(em.Artist && em.Artist.value).slice(0, 40),
        desc: stripHtml(em.ImageDescription && em.ImageDescription.value).slice(0, 160),
      });
    }
    out.sort((a, b) => titles.indexOf(a.title) - titles.indexOf(b.title));
    return out.slice(0, 8);
  }
  async function pickCandidate(entry, job, cands) {
    const reasons = job.reasons || [];
    const content = [{ type: "text", text:
      "标题：" + entry.title + "\n画面：" + job.want + "\n要求：" + (job.req || "无") + (reasons.length ? "\n上一轮被打回的原因：" + reasons[reasons.length - 1] : "") +
      "\n\n候选：\n" + cands.map((c, i) => (i + 1) + ". " + c.title.replace(/^File:/, "") + " (" + c.w + "×" + c.h + ")" + (c.desc ? " — " + c.desc : "")).join("\n") }];
    for (let i = 0; i < cands.length; i++) {
      content.push({ type: "text", text: "候选 " + (i + 1) });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: cands[i].small.toString("base64") } });
    }
    const text = await o.llm({
      purpose: "image_pick",
      system: "你是文章配图编辑。按「画面」和「要求」从候选图里挑最合适的一张：内容对得上、看得清、放进一篇睡前读的小文章里不突兀（老照片、版画、图解、实物照都可以；带大字水印的、软件截图、纯图标、和画面无关的不要）。都不合适就选 0。只输出一行 JSON：{\"pick\": 编号或0, \"caption\": \"中文图注，≤30 字，说清这张图是什么\", \"why\": \"一句话理由\"}",
      messages: [{ role: "user", content }],
    });
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("挑图的模型没给出 JSON");
    let r;
    try { r = JSON.parse(m[0]); }
    catch (_) { // captions sometimes carry an unescaped quote: fall back to pulling the fields out by hand
      const g = (k) => { const x = m[0].match(new RegExp('"' + k + '"\\s*:\\s*"([\\s\\S]*?)"\\s*[,}]')); return x ? x[1] : ""; };
      const p = m[0].match(/"pick"\s*:\s*(\d+)/);
      if (!p) throw new Error("挑图的模型给的 JSON 解析不了");
      r = { pick: Number(p[1]), caption: g("caption"), why: g("why") };
    }
    return { pick: Number(r.pick) || 0, caption: clean(r.caption, 40), why: clean(r.why, 80) };
  }
  const pipelineReady = () => !!sharp && typeof o.llm === "function";
  // Two processes can share one data directory (the web server and an MCP server per agent
  // session). A claim file per job and round keeps them from searching for the same picture twice.
  const CLAIM_STALE_MS = 10 * 60 * 1000;
  function claimJob(entryId, n, round) {
    const f = path.join(IMAGE_DIR, ".claim-" + entryId + "-" + n + "-r" + round);
    try { fs.writeFileSync(f, String(process.pid), { flag: "wx" }); return f; }
    catch (_) {
      // Held already. Take it over if the holder has died (it crashed, or its client went away
      // mid-search), or if the claim is simply too old to still be a live search.
      try {
        const holder = Number(fs.readFileSync(f, "utf-8"));
        let alive = false;
        if (holder && holder !== process.pid) { try { process.kill(holder, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; } }
        if (!alive || Date.now() - fs.statSync(f).mtimeMs > CLAIM_STALE_MS) { fs.writeFileSync(f, String(process.pid)); return f; }
      } catch (__) {}
      return null;
    }
  }
  async function runJob(entryId, n) {
    const entry = findEntry(load(), entryId);
    const job = entry && (entry.images || []).find((j) => j.n === n);
    if (!job || job.status !== "searching") return;
    if (!pipelineReady()) return; // nothing to search with here: leave the job for a process that has a model
    const round = job.round || 1;
    const claim = claimJob(entryId, n, round);
    if (!claim) return; // another process is on it
    // Everything slow happens on local copies. The entry is re-read and patched only at the very
    // end, with no await in between, so a tool call that lands meanwhile is never undone.
    const finish = (patch) => {
      const e = findEntry(load(), entryId);
      const j = e && (e.images || []).find((x) => x.n === n);
      if (!j || j.status !== "searching" || (j.round || 1) !== round) return false; // dropped or re-queued meanwhile
      patch(j);
      saveEntry(e);
      return true;
    };
    const fail = (msg, extra) => finish((j) => { j.status = "failed"; j.error = String(msg).slice(0, 160); if (extra) extra(j); });
    try {
      const queries = await searchQueries(entry, job);
      if (!queries.length) return fail("没想出搜索词");
      const cands = await commonsCandidates(queries, job.seen || []);
      if (!cands.length) return fail("Commons 上没搜到合适的横图（搜了：" + queries.join(" / ") + "）");
      const kept = [];
      for (const c of cands) {
        try {
          c.buf = await wmBuf(c.thumb);
          c.small = await sharp(c.buf).rotate().flatten({ background: "#fff" }).resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
          kept.push(c);
        } catch (e) { log("candidate thumbnail failed:", c.title, e.message); }
        if (kept.length >= 8) break;
      }
      if (!kept.length) return fail("候选图都下载不下来");
      const pick = await pickCandidate(entry, job, kept);
      const seen = (j) => { j.seen = (j.seen || []).concat(kept.map((c) => c.title)).slice(-40); j.queries = queries; };
      if (!pick.pick || !kept[pick.pick - 1]) return fail("候选都不合适（" + pick.why + "；搜了：" + queries.join(" / ") + "）", seen);
      const c = kept[pick.pick - 1];
      // the round is part of the file name, so a file name is never reused and can be cached forever
      const file = "nf_" + entry.id.replace(/^nf_/, "") + "_" + n + "_r" + round + ".jpg";
      await sharp(c.buf).rotate().flatten({ background: "#fff" }).resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).recomb(SEPIA).linear(0.98, 2.56).jpeg({ quality: 80, progressive: false }).toFile(path.join(IMAGE_DIR, file));
      const done = finish((j) => {
        seen(j);
        j.status = "ready"; j.file = file;
        j.caption = pick.caption || j.want; j.why = pick.why;
        j.credit = "Wikimedia Commons" + (c.license ? " · " + c.license : "") + (c.author ? " · " + c.author : "");
        j.source_url = c.page; j.source_title = c.title; j.license = c.license;
        delete j.error;
      });
      if (done) log("image ready:", entryId, "#" + n, c.title);
    } catch (e) {
      log("image job failed:", e.message);
      fail(e.message);
    } finally {
      try { fs.unlinkSync(claim); } catch (_) {}
    }
  }
  // Jobs of one article run one after another in the background; check_images waits up to 25s for them.
  const imageRuns = new Map();
  function startImageJobs(entryId) {
    const prev = imageRuns.get(entryId) || Promise.resolve();
    const run = prev.then(async () => {
      const e = findEntry(load(), entryId);
      if (!e) return;
      for (const j of e.images || []) if (j.status === "searching") await runJob(entryId, j.n);
      const after = findEntry(load(), entryId);
      if (after && imageStatus(after) === "waiting" && typeof o.onImagesReady === "function") {
        try { o.onImagesReady(entryForWriter(after)); } catch (err) { log("onImagesReady threw:", err.message); }
      }
    }).catch((e) => log("image run failed:", e.message));
    imageRuns.set(entryId, run);
    run.finally(() => { if (imageRuns.get(entryId) === run) imageRuns.delete(entryId); });
    return run;
  }
  const idle = () => Promise.all([...imageRuns.values()]).then(() => {});
  // After a restart: pick up searches that were cut short (the process ended mid-search).
  function resumeImageJobs() {
    let n = 0;
    for (const e of load().entries) if ((e.images || []).some((j) => j.status === "searching")) { startImageJobs(e.id); n++; }
    return n;
  }
  async function notify(body, url) {
    if (typeof o.notify !== "function") return false;
    try { return !!(await o.notify({ title: "夜航船", body, url })); } catch (e) { log("notify failed:", e.message); return false; }
  }
  // Tell the reader only when nothing is left to look at: first time the title, later "N pictures added".
  async function maybePush(entryId) {
    const e = findEntry(load(), entryId);
    if (!e) return false;
    const imgs = e.images || [];
    if (imgs.some((j) => j.status === "searching" || j.status === "ready" || j.status === "failed")) return false;
    const fresh = imgs.filter((j) => j.status === "approved" && !j.pushed);
    if (e.pushed_at && !fresh.length) return false;
    const first = !e.pushed_at;
    const ok = await notify(first ? "《" + e.title + "》" : "《" + e.title + "》补了 " + fresh.length + " 张图", PAGE_URL + (first ? "" : "?night=" + e.night));
    const e2 = findEntry(load(), entryId);
    if (e2) { e2.pushed_at = nowIso(); e2.push_ok = ok; for (const j of e2.images || []) if (j.status === "approved") j.pushed = true; saveEntry(e2); }
    return ok;
  }

  // ---- writing ----
  function writeEntry(input) {
    const title = clean(input.title, 40);
    const body = String(input.body == null ? "" : input.body).replace(/\r\n?/g, "\n").trim();
    const topic = clean(input.topic, 20);
    const wishId = clean(input.wish_id, 40);
    if (!title) return { error: "title 不能空" };
    if (body.length < 80) return { error: "body 太短了（至少 80 字）" };
    // refuse rather than cut: a cut can land inside a picture marker
    if (body.length > BODY_MAX) return { error: "body 太长了（" + body.length + " 字，上限 " + BODY_MAX + "）。正文没存，删短一些再 write。" };
    // Every article picks a wallpaper; without one the page falls back to the default picture.
    if (bgNames().length && !clean(input.background, 60)) return { error: "write 必须带 background（这一期的壁纸），从这些里挑一张和内容最搭的：" + bgNames().join(" / ") + "。正文没存，带上 background 再 write 一次。" };
    const data = load();
    const night = ferryNight();
    const already = data.entries.find((e) => e.night === night);
    if (already) return { error: "今晚已经写过了：《" + already.title + "》（id " + already.id + "）。一天一篇，明晚再写。" };
    const entry = { kind: "entry", id: newId("nf"), ts: nowIso(), night, title, body, topic, wish_id: wishId || null };
    const f = applyFields(entry, input);
    if (f.error) return { error: f.error };
    // No pipeline (no sharp, or no model configured): markers are ignored rather than failing one by one.
    const pipeline = pipelineReady();
    const jobs = pipeline ? syncImageJobs(entry, body) : 0;
    const ignoredMarkers = pipeline ? 0 : parseMarkers(body).length;
    append(entry);
    let wishDone = null;
    if (wishId) {
      const w = data.wishes.find((x) => x.id === wishId);
      if (w && !w.done_at) { append({ ...w, ts: nowIso(), done_at: entry.ts }); wishDone = w.name; }
    }
    return { entry, wishDone, jobs, ignoredMarkers };
  }

  // ---- the tool ----
  const tool = {
    name: "night_ferry",
    get description() {
      return "夜航船——你每晚给" + READER + "写一篇有意思的冷知识或科普，" + P + "在网站上读。一天一篇，300～600 字，讲透一个点，像睡前读的那种；可以是任何领域，但" + P + "在页面上记了「想听的」就优先从那里挑，写的是哪条就带上它的 wish_id（" + P + "那边会划掉）；" + P + "填了长期主题就多往那个方向写。\n" +
        "动作：read 看今晚写没写、" + P + "想听的、长期主题、最近的标题（别重复）；read 带 id 读某一期全文。write 存今晚这篇（title + body + background 三样必填，可带 topic / note / weather / place / coords）。background = 这一期的壁纸，每篇都要挑一张和内容最搭的。\n" +
        "配图：正文里单独一行写「【图：想要什么画面 | 要求】」= 这里放一张图（要求可省，比如 老照片 / 版画 / 图解；一律横图），系统会去 Wikimedia Commons 找、压好、等你过目；每篇最多 " + MAX_IMAGES + " 张。写完过一会儿用 check_images 看（找好的图会直接给你看，带图注和出处），approve 通过（可带 image_note = 你对这张图想说的一句话，" + P + "点图会看到；系统写的图注不准或不好就带 caption 换成你自己写的）、reject 带 reason 打回重找（最多 " + MAX_ROUNDS + " 轮，drop=true 就是这张不要了）。有图标记的那篇要全部过目完才会推给" + P + "。已经通过的图也可以再 approve 一次，只为改图注或留言。\n" +
        "航海日志：每一期文末有一块留言，" + P + "会在那里写读后感，你也可以写。read 带 id 会连那一期的日志一起给你（" + P + "的新留言读了才算读过）；log {id, text} 在那一期的日志里写一句（回" + P + "，或自己想补一句，≤" + LOG_MAX + " 字），写完会推给" + P + "。";
    },
    get input_schema() {
      const names = bgNames();
      return {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "write", "log", "check_images", "approve", "reject"], description: "read 看夜航船（带 id 读一期全文和航海日志）；write 写今晚这篇；log 在某一期的航海日志里留言；check_images 看配图；approve / reject 过目。" },
          id: { type: "string", description: "log / check_images / approve / reject 必填，read 可选：哪一期的 id（read 的 recent 和 write 的返回里有）。" },
          text: { type: "string", description: "log 必填：留言内容（≤" + LOG_MAX + " 字）。" },
          title: { type: "string", description: "write 必填：标题，一句话。" },
          body: { type: "string", description: "write 必填：正文，300～600 字，段落之间空一行；要配图的地方单独一行「【图：画面 | 要求】」。" },
          topic: { type: "string", description: "write 可选：一两个词的分类，比如 天文 / 语言 / 身体。" },
          wish_id: { type: "string", description: "write 可选：写的是「想听的」里哪一条，填那条的 wish_id。" },
          background: { type: "string", ...(names.length ? { enum: names } : {}), description: "write 必填：本期壁纸，挑和这篇内容最搭的一张。" },
          note: { type: "string", description: "write 可选：文末落锚之后你想对" + P + "说的一句话（≤80 字）。" },
          weather: { type: "string", description: "write 可选：写这篇时的天气，几个字。" },
          place: { type: "string", description: "write 可选：这篇故事发生的地方，几个字（写人造雪就填 札幌，写卢浮宫就填 巴黎）；这篇没有具体的地方再填你们所在的地方。" },
          coords: { type: "string", description: "write 可选：place 那个地方的坐标，比如 43°04′N 141°21′E；拿不准就不填。" },
          n: { type: "integer", description: "approve / reject 必填：第几张图（check_images 返回里的 n）。" },
          image_note: { type: "string", description: "approve 可选：这张图的留言，" + P + "点图会看到（≤120 字）。" },
          caption: { type: "string", description: "approve 可选：把这张图的图注换成你写的（≤60 字，图下面那行小字）；不带就用系统写的那句。" },
          reason: { type: "string", description: "reject 必填（drop 时可省）：哪里不对、想换成什么样，系统按这个重找。" },
          drop: { type: "boolean", description: "reject 可选：true = 这张不要了，不再找。" },
        },
        required: ["action"],
      };
    },
  };

  // Returns { result, images }: `images` are pictures for the writer to look at
  // ([{media_type, data(base64)}], only from check_images).
  async function execute(input) {
    input = input || {};
    const action = String(input.action || "").trim();
    const wrap = (result, images) => ({ result, images: images || [] });

    if (action === "read") {
      const data = load();
      const night = ferryNight();
      if (input.id) {
        const e = findEntry(data, input.id);
        if (!e) return wrap({ ok: false, action, error: "没有这期：" + input.id });
        const entryLog = logForWriter(data, e.id);
        if (logUnread(data, e.id).length) logMarkRead(e.id); // reading the article is what marks its notes as read
        return wrap({ ok: true, action, entry: { ...entryForWriter(e), log: entryLog }, backgrounds: bgNames(), note: "entry.log 是这一期文末的航海日志（" + READER + "和你的留言）。想在这里回" + P + "或补一句：night_ferry 的 log，带 id 和 text（≤" + LOG_MAX + " 字），写完会推给" + P + "。" });
      }
      const tonight = data.entries.find((e) => e.night === night) || null;
      const waiting = data.entries.filter((e) => imageStatus(e) === "waiting").map((e) => ({ id: e.id, title: e.title, ready: e.images.filter((j) => j.status === "ready").length, failed: e.images.filter((j) => j.status === "failed").length }));
      return wrap({
        ok: true, action, tonight: night,
        written_tonight: tonight ? { id: tonight.id, title: tonight.title, topic: tonight.topic, image_status: imageStatus(tonight) } : null,
        theme: data.theme || "",
        wishes: data.wishes.filter((w) => !w.done_at).map((w) => ({ wish_id: w.id, name: w.name, added: w.ts.slice(0, 10) })),
        recent: data.entries.slice(0, 15).map((e) => ({ id: e.id, night: e.night, title: e.title, topic: e.topic || "" })),
        backgrounds: bgNames(),
        images_waiting: waiting,
        log_unread: data.entries.map((e) => ({ id: e.id, title: e.title, count: logUnread(data, e.id).length })).filter((x) => x.count > 0),
        note: "一天一篇，300～600 字。写用 write：title + body + background（壁纸必选，从 backgrounds 里挑和内容最搭的一张；可带 topic / note / weather / place / coords；写的是想听的那条就带 wish_id，" + P + "那边会划掉）。正文里单独一行「【图：画面 | 要求】」= 这里放一张图（最多 " + MAX_IMAGES + " 张），系统去找、你过目。log_unread 是" + P + "在文末航海日志里新写的留言（哪一期几条）：read 带那期的 id 看内容，log {id, text} 在那一期回" + P + "。",
      });
    }

    if (action === "write") {
      const r = writeEntry(input);
      if (r.error) return wrap({ ok: false, action, error: r.error });
      if (r.jobs) {
        startImageJobs(r.entry.id);
        return wrap({ ok: true, action, id: r.entry.id, night: r.entry.night, title: r.entry.title, wish_done: r.wishDone, pushed: false, images_pending: r.jobs, note: "已存进夜航船，" + r.jobs + " 张配图在找（每张十几秒），过一会儿用 check_images 看；全部过目完才会推给" + P + "。" });
      }
      const pushed = await notify("《" + r.entry.title + "》", PAGE_URL);
      r.entry.pushed_at = nowIso();
      r.entry.push_ok = pushed;
      saveEntry(r.entry);
      return wrap({ ok: true, action, id: r.entry.id, night: r.entry.night, title: r.entry.title, wish_done: r.wishDone, pushed, note: "已存进夜航船" + (pushed ? "，标题已推到" + P + "手机" : "") + "。" + (r.ignoredMarkers ? "这里没开配图管线，正文里的 " + r.ignoredMarkers + " 处图标记不会显示，也不用过目。" : "") });
    }

    if (action === "log") {
      const e = findEntry(load(), input.id);
      if (!e) return wrap({ ok: false, action, error: "log 要带 id（哪一期）" + (input.id ? "，没有这期：" + input.id : "") });
      const text = clean(input.text, LOG_MAX);
      if (!text) return wrap({ ok: false, action, error: "log 要带 text（留言内容）" });
      append({ kind: "log", id: newId("nfl"), ts: nowIso(), entry_id: e.id, who: "writer", text });
      const pushed = await notify("《" + e.title + "》的航海日志里多了一句", PAGE_URL + "?night=" + e.night);
      return wrap({ ok: true, action, id: e.id, title: e.title, pushed, note: "写进《" + e.title + "》的航海日志了" + (pushed ? "，已推给" + P : "") + "。" });
    }

    if (action === "check_images") {
      let e = findEntry(load(), input.id);
      if (!e) return wrap({ ok: false, action, error: "check_images 要带 id" + (input.id ? "，没有这期：" + input.id : "") });
      const run = imageRuns.get(e.id);
      if (run) { let timer; await Promise.race([run, new Promise((r) => { timer = setTimeout(r, 25000); })]); clearTimeout(timer); }
      e = findEntry(load(), e.id);
      const imgs = e.images || [];
      const ready = imgs.filter((j) => j.status === "ready");
      const result = {
        ok: true, action, id: e.id, title: e.title,
        images: imgs.map((j) => ({ n: j.n, want: j.want, req: j.req || "", status: j.status, round: j.round || 1, caption: j.caption || "", credit: j.credit || "", source: j.source_title ? String(j.source_title).replace(/^File:/, "") : "", why: j.why || "", note: j.note || "", error: j.error || undefined })),
        note: !imgs.length ? "这期没有配图标记。"
          : ready.length ? "待过目的 " + ready.length + " 张图按 n 的顺序附在后面（n = " + ready.map((j) => j.n).join("、") + "）。approve {id, n, image_note?, caption?} 通过（caption = 把图注换成你写的）；reject {id, n, reason} 打回重找（drop=true 就是这张不要了）。"
          : imgs.some((j) => j.status === "searching") ? "还在找，过一会儿再 check_images。"
          : imgs.some((j) => j.status === "failed") ? "有没找到的（看 error），reject 带 reason 换个说法重找，或 drop 掉。"
          : "没有待过目的图。",
      };
      const blocks = [];
      for (const j of ready) {
        try {
          const buf = await sharp(path.join(IMAGE_DIR, j.file)).resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
          blocks.push({ media_type: "image/jpeg", data: buf.toString("base64") });
        } catch (err) { log("could not read image for check:", err.message); }
      }
      return wrap(result, blocks);
    }

    if (action === "approve" || action === "reject") {
      const e = findEntry(load(), input.id);
      if (!e) return wrap({ ok: false, action, error: action + " 要带 id" + (input.id ? "，没有这期：" + input.id : "") });
      const n = Number(input.n);
      const j = (e.images || []).find((x) => x.n === n);
      if (!j) return wrap({ ok: false, action, error: "没有第 " + input.n + " 张（这期有 " + (e.images || []).length + " 张配图位）" });
      if (action === "approve") {
        if (j.status !== "ready" && j.status !== "approved") return wrap({ ok: false, action, error: "第 " + n + " 张现在是 " + j.status + "，只有找好了（ready）的能通过" });
        j.status = "approved";
        if (input.image_note != null) j.note = clean(input.image_note, 120);
        if (input.caption != null) { // the writer's caption replaces the pipeline's; the original is kept
          const cap = clean(input.caption, 60);
          if (cap && cap !== j.caption) { if (j.caption_auto == null) j.caption_auto = j.caption || ""; j.caption = cap; }
        }
        j.approved_at = nowIso();
        saveEntry(e);
      } else {
        if (!["ready", "failed", "approved", "searching"].includes(j.status)) return wrap({ ok: false, action, error: "第 " + n + " 张现在是 " + j.status + "，不能打回" });
        if (j.status === "searching" && input.drop !== true) return wrap({ ok: false, action, error: "第 " + n + " 张还在找，等它找完再打回；一直没动静的话可以 drop=true 不要这张" });
        if (input.drop !== true && !pipelineReady()) return wrap({ ok: false, action, error: "这里没开配图管线，没法重找；不想要这张就 drop=true" });
        const reason = clean(input.reason, 160);
        if (input.drop !== true && !reason) return wrap({ ok: false, action, error: "reject 要带 reason（哪里不对、想要什么样），或 drop=true 不要这张" });
        j.reasons = (j.reasons || []).concat(reason || "不要了");
        if (input.drop === true) { j.status = "dropped"; }
        else {
          j.round = (j.round || 1) + 1;
          if (j.round > MAX_ROUNDS) { j.status = "dropped"; j.error = "找了 " + MAX_ROUNDS + " 轮没找到合适的，放弃"; }
          else { if (j.file) { try { fs.unlinkSync(path.join(IMAGE_DIR, path.basename(j.file))); } catch (_) {} } j.status = "searching"; for (const k of ["error", "pushed", "file", "caption", "caption_auto", "credit", "note", "why", "source_url", "source_title", "license", "approved_at"]) delete j[k]; } // the next picture starts clean
        }
        saveEntry(e);
        if (j.status === "searching") startImageJobs(e.id);
      }
      const pushed = await maybePush(e.id);
      const e2 = findEntry(load(), e.id);
      const left = (e2.images || []).filter((x) => x.status === "ready" || x.status === "failed" || x.status === "searching").length;
      return wrap({
        ok: true, action, id: e.id, title: e.title, n, status: j.status, round: j.round || 1, pushed, remaining: left,
        ...(action === "approve" ? { caption: j.caption || "" } : {}),
        note: action === "approve"
          ? (pushed ? "通过了，全部过目完，已推给" + P + "。" : left ? "通过了，还有 " + left + " 张没过目。" : "通过了。")
          : (j.status === "dropped" ? "这张不要了。" : "打回了，第 " + j.round + " 轮重找（每张十几秒），过一会儿 check_images。") + (pushed ? " 全部过目完，已推给" + P + "。" : ""),
      });
    }
    return wrap({ ok: false, error: "action 要是 read / write / log / check_images / approve / reject" });
  }

  // tool_result content: the JSON as text, then any pictures as image blocks.
  function toolResultContent(out) {
    const content = [{ type: "text", text: JSON.stringify(out.result) }];
    for (const b of out.images || []) content.push({ type: "image", source: { type: "base64", media_type: b.media_type, data: b.data } });
    return content;
  }

  // ---- notes for the writer's next prompt (empty string = nothing to say) ----
  // Put these into whatever periodically wakes your agent. They read state only.
  function wakeNote() {
    try {
      const data = load();
      const night = ferryNight();
      const parts = [];
      if (!data.entries.some((e) => e.night === night)) {
        const open = data.wishes.filter((w) => !w.done_at).map((w) => w.name);
        parts.push(
          "今天的夜航船还没写（一天一篇，什么时候写都行）。" +
          (open.length ? P + "想听的：" + open.slice(0, 6).join("、") + "。" : P + "这几天没有特别点题。") +
          (data.theme ? "长期主题：" + data.theme + "。" : "") +
          "一天一篇，300～600 字，讲透一个有意思的点；写好用 night_ferry 的 write 存进去（想听的那条配上 wish_id），不用再在这里复述正文。"
        );
      }
      for (const e of data.entries) {
        const n = logUnread(data, e.id).length;
        if (n) parts.push("《" + e.title + "》（id " + e.id + "）的航海日志里" + P + "新写了 " + n + " 条。想看用 night_ferry 的 read 带这个 id（读了才算读过），想回" + P + "用 log。");
      }
      return parts.length ? "[夜航船] " + parts.join(" ") : "";
    } catch (_) { return ""; }
  }
  function imagesNotice() {
    try {
      const parts = [];
      for (const e of load().entries.filter((x) => imageStatus(x) === "waiting").slice(0, 3)) {
        const r = e.images.filter((j) => j.status === "ready").length, f = e.images.filter((j) => j.status === "failed").length;
        parts.push("《" + e.title + "》（id " + e.id + "）的配图" + (r ? "找好了 " + r + " 张" : "") + (r && f ? "，" : "") + (f ? f + " 张没找到" : "") + "，这轮就用 night_ferry 的 check_images 看一眼再 approve / reject（没找到的可以带 reason 换个说法重找，或 drop 掉）。全部过目完才会推给" + P + "。");
      }
      return parts.length ? "[夜航船配图]\n" + parts.join("\n") : "";
    } catch (_) { return ""; }
  }

  // ---- HTTP: what the reader page uses ----
  function router() {
    const express = require("express");
    const r = express.Router();
    const json = express.json({ limit: "8kb" });
    // newest first; before=<night> pages back
    r.get("/", (req, res) => {
      const data = load();
      const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 20));
      const before = typeof req.query.before === "string" ? req.query.before : "";
      const pool = before ? data.entries.filter((e) => e.night < before) : data.entries;
      res.json({
        tonight: ferryNight(),
        theme: data.theme,
        wishes: data.wishes,
        entries: pool.slice(0, limit).map((e) => publicEntry(e, data)),
        has_more: pool.length > limit,
        total: data.entries.length,
        backgrounds: bgPublic(),
      });
    });
    r.post("/wishes", json, (req, res) => {
      const name = clean((req.body || {}).name, 40);
      if (!name) return res.status(400).json({ ok: false, error: "不能空" });
      if (load().wishes.filter((w) => !w.done_at).length >= WISH_OPEN_MAX) return res.status(400).json({ ok: false, error: "想听的已经记了 " + WISH_OPEN_MAX + " 条，先删几条" });
      const entry = { kind: "wish", id: newId("nfw"), ts: nowIso(), name, done_at: null };
      append(entry);
      res.json({ ok: true, entry });
    });
    r.delete("/wishes/:id", (req, res) => {
      if (!load().wishes.some((x) => x.id === req.params.id)) return res.status(404).json({ ok: false, error: "没有这条" });
      append({ id: req.params.id, deleted: true, ts: nowIso() });
      res.json({ ok: true });
    });
    r.post("/log", json, (req, res) => {
      const b = req.body || {};
      const e = findEntry(load(), String(b.entry_id || ""));
      if (!e) return res.status(404).json({ ok: false, error: "没有这期" });
      const text = clean(b.text, LOG_MAX);
      if (!text) return res.status(400).json({ ok: false, error: "不能空" });
      if (logsOf(load(), e.id).length >= LOG_PER_ENTRY_MAX) return res.status(400).json({ ok: false, error: "这一页的日志写满了" });
      const line = { kind: "log", id: newId("nfl"), ts: nowIso(), entry_id: e.id, who: "reader", text };
      append(line);
      res.json({ ok: true, log: { id: line.id, ts: line.ts, who: line.who, text: line.text } });
    });
    // the reader can remove their own notes; the writer's stay
    r.delete("/log/:id", (req, res) => {
      const l = load().logs.find((x) => x.id === req.params.id);
      if (!l) return res.status(404).json({ ok: false, error: "没有这条" });
      if (l.who !== "reader") return res.status(403).json({ ok: false, error: "不是你写的，不能删" });
      append({ id: l.id, deleted: true, ts: nowIso() });
      res.json({ ok: true });
    });
    r.post("/theme", json, (req, res) => {
      const text = clean((req.body || {}).text, 60);
      if (text !== load().theme) append({ kind: "theme", id: "theme", ts: nowIso(), text });
      res.json({ ok: true, theme: text });
    });
    r.use("/images", express.static(IMAGE_DIR, { maxAge: "7d", immutable: true, dotfiles: "ignore" }));
    // malformed JSON and the like: a short answer, not a stack trace
    r.use((err, req, res, next) => { res.status(err && err.status >= 400 && err.status < 500 ? err.status : 500).json({ ok: false, error: "请求格式不对" }); });
    return r;
  }

  return { tool, execute, toolResultContent, wakeNote, imagesNotice, resumeImageJobs, idle, router, load, ferryNight, backgrounds: bgPublic, paths: { file: FILE, images: IMAGE_DIR } };
}

module.exports = { createNightFerry };
