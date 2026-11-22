// Night Ferry: article renderer. Turns one entry into the HTML of a reader page
// (log header, title, body with figures, anchor footer, ship's log, prev / next nav).
// Public API: window.nfArticle = { esc, dateParts, fmtDate, bgUrl, bgThumbUrl, presetOf, toneOf, renderBody, renderFigure,
//   logListHTML, pageHTML(entry, tonight, ctx), patch(page, ctx), emptyHTML(), ropeStart(anchorEl, opt), setBackgrounds(list) }
// Entry fields (empty ones are simply not shown): id / title / body / topic / night ("YYYY-MM-DD") / bg (background image URL) |
//   background (preset name) / weather / place / coords / note / images[{n,url,caption,credit,note}] / log[{id,ts,who,text}]
// Figure markers in the body: a whole line wrapped in lenticular or square brackets that starts with the figure keyword and a colon
//   (see the regex in renderBody), i.e. [<keyword>: description | requirement], marks the slot of the n-th image;
//   a marker whose image is missing renders nothing.
// Needs: nf-article.css, assets/anchor.png, assets/rope.png, assets/backgrounds/*.webp. Used by nf-reader.js.
(function () {
  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  let DEFAULT_BG = "assets/backgrounds/moonsea.webp", DEFAULT_THUMB = "assets/backgrounds/moonsea-t2.webp"; // used when an entry has no wallpaper of its own; replaced by the list entry marked default (see setBackgrounds)
  // Anchor at the end of the article: a line-art anchor image (438x543, measured down from the top of the rope knot) plus a rope
  //   strip texture (71x610; its bottom edge meets the top of the knot). The rope is drawn on a canvas by pasting short slices of
  //   the texture along a curve (ropeStart): lowered from above, then slack and following the anchor ring once the anchor has landed.
  //   Until the texture has loaded, the stroked paths inside the svg stand in for it.
  const ANK_W = 104, ANK_H = 543 * 104 / 438, ANK_Y = 216 - 543 * 104 / 438, ANK_X = 100 - 222 * 104 / 438; // the anchor tip sits 8 units below the sand line (y≈208); horizontally the rope's centre line lands on x=100
  const ROPE_END = { x: 100, y: ANK_Y + 0.5 }; // the bottom edge of the rope texture meets the top of the knot (in the anchor group's own coordinates)
  const ROPE_W = 71 * 104 / 438, ROPE_TEX_SRC = "assets/rope.png"; // texture width scaled like the anchor so the line weights match
  const ROPE_TEX = new Image(); ROPE_TEX.decoding = "async"; ROPE_TEX.src = ROPE_TEX_SRC; // starts downloading at script load so it is there by the time the reader reaches the end
  const ANCHOR = '<canvas class="nf-rope-cv" width="400" height="520" aria-hidden="true"></canvas>' +
    '<svg viewBox="0 0 200 260" aria-hidden="true">' +
    '<ellipse class="nf-shadow" cx="100" cy="209" rx="40" ry="5" fill="#4a3620" opacity="0"/>' +
    '<g class="nf-rope-g" fill="none" stroke-linecap="round">' +
      '<path class="r0" d="" stroke="#3a2914" stroke-width="10.4" opacity="0.6"/>' +
      '<path class="r1" d="" stroke="#9a7949" stroke-width="8.6"/>' +
      '<path class="r2" d="" data-dx="-2.2" stroke="#d2b886" stroke-width="3.4" stroke-dasharray="3.4 4.4" opacity="0.95"/>' +
      '<path class="r3" d="" data-dx="2.2" stroke="#4a3118" stroke-width="2.4" stroke-dasharray="3.4 4.4" stroke-dashoffset="3.9" opacity="0.8"/>' +
    '</g>' +
    '<g class="nf-ank"><image href="assets/anchor.png" x="' + ANK_X.toFixed(2) + '" y="' + ANK_Y.toFixed(2) + '" width="' + ANK_W + '" height="' + ANK_H.toFixed(2) + '"/></g>' +
    '<defs><linearGradient id="nfSand" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#e8dcc3" stop-opacity="0"/><stop offset="0.25" stop-color="#e8dcc3"/><stop offset="0.75" stop-color="#e8dcc3"/><stop offset="1" stop-color="#e8dcc3" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="M18 209C50 199 75 204 100 205.5C125 207 150 199 182 209L182 260L18 260Z" fill="url(#nfSand)"/>' +
    '<path d="M18 209.5C50 199.5 75 204.5 100 206C125 207.5 150 199.5 182 209.5" stroke="#6f5a40" stroke-width="1.15" fill="none" stroke-linecap="round" opacity="0.75"/>' +
    '<g class="nf-puffs" fill="#8d7656" opacity="0"><circle cx="88" cy="203" r="1.6"/><circle cx="112" cy="202" r="1.3"/><circle cx="80" cy="206" r="1.1"/><circle cx="120" cy="205" r="1.5"/><circle cx="100" cy="199" r="1.2"/></g>' +
    "</svg>";
  // Rope: while the anchor falls the rope is straight (taut, being lowered). After landing it goes slack: the upper part hangs vertically, the last stretch bends into a slight S to reach the knot, the end follows the anchor ring (as the anchor tilts, the ring moves), and the upper part sways with decay.
  // Each frame reads the anchor group's CSS transform matrix (transform-origin 100,208 is applied by hand) and maps the knot-top point through it to get the rope end; the texture is pasted from the end upward (the end is always the texture's bottom, so the pattern travels with the anchor while it falls).
  function ropeStart(anchorEl, opt) {
    const g = anchorEl.querySelector(".nf-rope-g"), ank = anchorEl.querySelector(".nf-ank"), cv = anchorEl.querySelector(".nf-rope-cv");
    if (!g || !ank) return;
    const paths = g.querySelectorAll("path");
    const ox = 100, oy = 208, T0 = performance.now();
    const LAND = (opt && opt.land) || 1200, DUR = (opt && opt.total) || 2400; // landing time / total duration (ms), kept in sync with the nfAnk keyframes in the css
    const staticEnd = opt && opt.reduced;
    // canvas: 200x260 units, scaled up by dpr; the texture is tiled three times vertically on an offscreen canvas so any slice can be taken without crossing an edge
    let ctx = null, tall = null, scale = ROPE_W / 71, texH = 0, dpr = Math.min(3, window.devicePixelRatio || 1);
    function texReady() {
      if (tall) return true;
      if (!cv || !ROPE_TEX.complete || !ROPE_TEX.naturalWidth) return false;
      try {
        texH = ROPE_TEX.naturalHeight; scale = ROPE_W / ROPE_TEX.naturalWidth;
        tall = document.createElement("canvas"); tall.width = ROPE_TEX.naturalWidth; tall.height = texH * 3;
        const tc = tall.getContext("2d"); for (let k = 0; k < 3; k++) tc.drawImage(ROPE_TEX, 0, k * texH);
        cv.width = Math.round(200 * dpr); cv.height = Math.round(260 * dpr); ctx = cv.getContext("2d");
        g.style.display = "none"; // texture is ready: hide the fallback strokes in the svg
        return true;
      } catch (_) { tall = null; return false; }
    }
    function endPoint() {
      let m = null;
      try { const t = getComputedStyle(ank).transform; const mm = t && t.match(/matrix\(([^)]+)\)/); if (mm) m = mm[1].split(",").map(Number); } catch (_) {}
      if (!m) return { x: ROPE_END.x, y: ROPE_END.y };
      const px = ROPE_END.x - ox, py = ROPE_END.y - oy; // translate to the origin, apply the matrix, translate back
      return { x: m[0] * px + m[2] * py + m[4] + ox, y: m[1] * px + m[3] * py + m[5] + oy };
    }
    function curve(e, s, w) { // returns the four points of a cubic Bezier
      const top = { x: 100, y: -40 };
      return [top, { x: 100 + 9 * s * w, y: e.y - 78 }, { x: e.x + 5 * s, y: e.y - 30 }, e];
    }
    function drawSvg(e, s, w) { // fallback: stroked rope while the texture has not loaded
      const [p0, c1, c2, p3] = curve(e, s, w);
      paths.forEach((p) => { const dx = parseFloat(p.getAttribute("data-dx") || "0"); p.setAttribute("d", "M" + (p0.x + dx) + " " + p0.y + "C" + (c1.x + dx).toFixed(1) + " " + c1.y.toFixed(1) + " " + (c2.x + dx).toFixed(1) + " " + c2.y.toFixed(1) + " " + (p3.x + dx).toFixed(1) + " " + p3.y.toFixed(1)); });
    }
    function drawTex(e, s, w) {
      const [p0, c1, c2, p3] = curve(e, s, w);
      const N = 64, pts = [], len = [0];
      for (let i = 0; i <= N; i++) { const t = i / N, u = 1 - t; pts.push({ x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y }); if (i) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)); }
      const total = len[N];
      const at = (d) => { // point at distance d from the start (d may be < 0: extends upward)
        if (d <= 0) { const dir = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y }, l = Math.hypot(dir.x, dir.y) || 1; return { x: pts[0].x + dir.x / l * d, y: pts[0].y + dir.y / l * d }; }
        let i = 1; while (i < N && len[i] < d) i++; const f = (d - len[i - 1]) / ((len[i] - len[i - 1]) || 1); return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f };
      };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, 200, 260);
      const SEG = 2.4, segSrc = SEG / scale;
      for (let d = 0; d < total + 60; d += SEG) { // paste slice by slice from the knot upward; go 60 units further so the rope runs off the canvas (the curve tops out at -40)
        const a = at(total - d), b = at(total - d - SEG); if (a.y < -12 && b.y < -12) break;
        const ang = Math.atan2(a.y - b.y, a.x - b.x) - Math.PI / 2;
        const srcY = 2 * texH - ((d + SEG) / scale) % texH;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(ang);
        ctx.drawImage(tall, 0, srcY, tall.width, segSrc + 0.5, -ROPE_W / 2, -0.1, ROPE_W, SEG + 0.25); // the line art is semi-transparent: keep the overlap between neighbouring slices small so the seams do not darken
        ctx.restore();
      }
    }
    function draw(e, s, w) { if (texReady()) drawTex(e, s, w); else drawSvg(e, s, w); }
    if (staticEnd) { const a = -7.5 * Math.PI / 180, px = ROPE_END.x - ox, py = ROPE_END.y - oy; draw({ x: Math.cos(a) * px - Math.sin(a) * py + ox, y: Math.sin(a) * px + Math.cos(a) * py + oy + 4 }, 1, 0); return; }
    draw({ x: 100, y: ROPE_END.y - 270 }, 0, 0);
    let raf = 0;
    function tick(now) {
      const t = now - T0;
      let s = 0, w = 0;
      if (t > LAND) { const u = Math.min(1, (t - LAND) / 1000); s = 1 - Math.pow(1 - u, 3); w = Math.sin(u * 10) * (1 - u); } // going slack; the upper part sways a little
      draw(endPoint(), s, w);
      if (t < DUR + 300) raf = requestAnimationFrame(tick); else draw(endPoint(), 1, 0);
    }
    raf = requestAnimationFrame(tick);
    return { stop() { cancelAnimationFrame(raf); } };
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function dateParts(night) {
    const [y, m, d] = String(night || "").split("-").map(Number);
    const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return { y, m, d, wd };
  }
  function fmtDate(night) {
    const p = dateParts(night);
    return p.y + "." + String(p.m).padStart(2, "0") + "." + String(p.d).padStart(2, "0") + " 周" + p.wd;
  }
  // Wallpapers are data, not code: the list comes from the server (the `backgrounds` field of GET api/night-ferry,
  //   built from assets/backgrounds/backgrounds.json) and is handed over with setBackgrounds([{name, url, thumb, default}]).
  //   entry.background holds one of the names. Each image is an [upright][flipped] block that tiles vertically.
  let BG = {}; // name -> { url, thumb }
  function setBackgrounds(list) {
    BG = {};
    for (const b of Array.isArray(list) ? list : []) {
      if (!b || !b.name || !b.url) continue;
      BG[b.name] = { url: String(b.url), thumb: b.thumb ? String(b.thumb) : null };
      if (b.default) { DEFAULT_BG = BG[b.name].url; DEFAULT_THUMB = BG[b.name].thumb || DEFAULT_THUMB; }
    }
  }
  function presetOf(e) { // name of the wallpaper this entry picked, or null (unknown names count as none)
    return e && e.background && BG[e.background] ? String(e.background) : null;
  }
  function bgThumbUrl(e) { // strip behind overview rows: the wallpaper's thumb (a band centred 30% down the picture); an explicit e.bg is used as is
    if (e && e.bg) return String(e.bg);
    const p = presetOf(e);
    return p ? BG[p].thumb || BG[p].url : DEFAULT_THUMB;
  }
  function bgUrl(e) {
    if (e && e.bg) return String(e.bg);
    const p = presetOf(e);
    return p ? BG[p].url : DEFAULT_BG;
  }
  // Body: blank lines separate paragraphs; a figure-marker line is the slot of the n-th image (entry.images[{n,url,caption,credit,note}]); nothing is rendered when that image is missing
  function renderBody(e) {
    const imgs = Array.isArray(e.images) ? e.images : [];
    let n = 0;
    return String(e.body || "").split(/\n{2,}/).map((raw) => {
      const out = [];
      let buf = [];
      const flush = () => { if (buf.length) { out.push("<p>" + buf.map((l) => esc(l.trim())).join("<br>") + "</p>"); buf = []; } };
      for (const line of raw.split("\n")) {
        const m = line.trim().match(/^[【\[]图[:：]\s*(.+?)\s*[】\]]$/);
        if (!m) { if (line.trim()) buf.push(line); continue; }
        n++;
        const img = imgs.find((x) => x.n === n) || imgs[n - 1];
        flush();
        if (img && img.url) out.push(renderFigure(img, m[1].split("|")[0].trim()));
      }
      flush();
      return out.join("");
    }).join("");
  }
  function renderFigure(img, want) {
    const note = img.note ? String(img.note).trim() : "";
    const cap = img.caption ? String(img.caption).trim() : want;
    const credit = img.credit ? String(img.credit).trim() : "";
    // the credit links back to the picture's source page (attribution); only plain http(s) links are made clickable
    const src = img.source_url && /^https?:\/\//i.test(String(img.source_url)) ? String(img.source_url) : "";
    const creditHTML = credit ? '<span class="nf-credit">' + (src ? '<a href="' + esc(src) + '" target="_blank" rel="noopener noreferrer">' + esc(credit) + "</a>" : esc(credit)) + "</span>" : "";
    return '<figure class="nf-fig' + (note ? " has-note" : "") + '">' +
      '<span class="nf-photo"><img src="' + esc(img.url) + '" alt="' + esc(cap) + '" loading="lazy" decoding="async">' +
      '<i class="nf-corner tl"></i><i class="nf-corner tr"></i><i class="nf-corner bl"></i><i class="nf-corner br"></i>' +
      '<button type="button" class="nf-zoom" aria-label="放大查看"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
      (note ? '<span class="nf-dot" aria-hidden="true"></span>' : "") + "</span>" +
      (cap || credit ? "<figcaption>" + esc(cap) + creditHTML + "</figcaption>" : "") +
      (note ? '<div class="nf-cloud"><div class="nf-body"><div class="nf-puff' + (note.length > 60 ? " nf-long" : "") + '">' + esc(note) + '<span class="nf-who">— 他看完这张图说</span></div></div><i class="nf-b1"></i><i class="nf-b2"></i></div>' : "") +
      "</figure>";
  }
  // ctx: { no (log number, empty when unknown), older, newer (neighbouring entries, may be null), notice (one-line hint, may be empty) }
  function logHTML(e, tonight, ctx) {
    ctx = ctx || {};
    const l3 = [];
    if (e.place) l3.push('<span class="nf-place">' + esc(e.place) + "</span>");
    if (e.coords) l3.push("<span>" + esc(e.coords) + "</span>");
    return '<header class="nf-log">' +
      '<div class="nf-log-l1">Night Ferry · Log No.<span class="nf-logno">' + (ctx.no ? esc(ctx.no) : "") + "</span></div>" +
      '<div class="nf-log-l2"><span class="nf-date">' + esc(fmtDate(e.night)) + "</span>" +
      (e.topic ? "<span>航段：" + esc(e.topic) + "</span>" : "") +
      (e.weather ? "<span>天气：" + esc(e.weather) + "</span>" : "") +
      (e.night === tonight ? '<span class="nf-tonight">今晚</span>' : "") + "</div>" +
      (l3.length ? '<div class="nf-log-l3">' + l3.join("") + "</div>" : "") +
      '<div class="nf-notice"' + (ctx.notice ? "" : " hidden") + ">" + esc(ctx.notice || "") + "</div>" +
      "</header>";
  }
  function navHTML(ctx) {
    ctx = ctx || {};
    const o = ctx.older, w = ctx.newer;
    return '<nav class="nf-nav">' +
      '<button type="button" class="next"' + (w ? "" : " disabled") + "><b>← 下一站</b><span>" + (w ? esc(w.title) : "") + "</span></button>" +
      '<button type="button" class="prev"' + (o ? "" : " disabled") + "><span>" + (o ? esc(o.title) : "") + "</span><b>上一站 →</b></button></nav>";
  }
  // Ship's log: comments at the end of each article. entry.log = [{id, ts, who, text}] in chronological order; who is one of the keys of LOG_WHO.
  // Placed after the closing note and before the prev / next nav. The list has its own function so that adding / deleting redraws only the list (the input is untouched and the on-screen keyboard stays up).
  const LOG_WHO = { reader: "我", writer: "他" }; // display labels for the two authors (the page is the reader's, so the reader is "me")
  function logTime(ts) { // timestamps are stored in UTC and shown in the viewer's local time
    const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
    return isNaN(d) ? "" : p(d.getMonth() + 1) + "." + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function logListHTML(e) {
    const logs = Array.isArray(e.log) ? e.log : [];
    if (!logs.length) return '<li class="nf-sl-empty">这一页还没有人写字</li>';
    return logs.map((l) => {
      const mine = l.who !== "writer";
      return '<li class="nf-sl-row ' + (mine ? "who-reader" : "who-writer") + '" data-lid="' + esc(l.id) + '">' +
        '<div class="nf-sl-meta"><span class="nf-sl-who">' + esc(LOG_WHO[l.who] || l.who) + '</span><span class="nf-sl-time">' + logTime(l.ts) + "</span>" +
        (mine ? '<button type="button" class="nf-sl-rm" aria-label="删掉这条">×</button>' : "") + "</div>" +
        '<p class="nf-sl-text">' + esc(l.text).replace(/\n/g, "<br>") + "</p></li>";
    }).join("");
  }
  function shiplogHTML(e) {
    if (!e || !e.id) return "";
    return '<section class="nf-shiplog" data-id="' + esc(e.id) + '"><h2><span>Ship’s Log</span>航海日志</h2>' +
      '<ol class="nf-sl-list">' + logListHTML(e) + "</ol>" +
      '<form class="nf-sl-form" autocomplete="off"><textarea class="nf-sl-in" rows="1" maxlength="300" placeholder="在日志里写一行…"></textarea><button type="submit" aria-label="写上">记</button></form></section>';
  }
  function pageHTML(e, tonight, ctx) {
    return logHTML(e, tonight, ctx) +
      "<h1>" + esc(e.title) + "</h1>" +
      '<div class="nf-body">' + renderBody(e) + "</div>" +
      '<footer class="nf-end"><div class="nf-anchor">' + ANCHOR + '</div><div class="nf-moor">本期靠岸</div>' +
      (e.note ? '<p class="nf-note">' + esc(e.note) + "</p>" : "") + shiplogHTML(e) + navHTML(ctx) + "</footer>";
  }
  // The first frame may know only one entry (handed over by the launching page); log number, neighbours and notice arrive with the data. Patch just those spots instead of re-rendering the body (a re-render flickers and jumps back to the top).
  function patch(page, ctx) {
    ctx = ctx || {};
    const no = page.querySelector(".nf-logno"); if (no) no.textContent = ctx.no ? String(ctx.no) : "";
    const nt = page.querySelector(".nf-notice"); if (nt) { nt.textContent = ctx.notice || ""; nt.hidden = !ctx.notice; }
    const nav = page.querySelector(".nf-nav"); if (nav) nav.outerHTML = navHTML(ctx);
  }
  function emptyHTML() {
    return '<header class="nf-log"><div class="nf-log-l1">Night Ferry · Log No.<span class="nf-logno">0</span></div></header><h1>船还没开过</h1><div class="nf-body"><p>第一篇还没有写。</p></div>';
  }
    // Background tone -> three sea colour stops (each background keeps its own hue instead of everything being forced to blue): the image is downscaled to 16x24 and averaged in top / middle / bottom bands
  const TONE_CACHE = {};
  function rgb2hsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; if (mx === mn) return [0, 0, l]; const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [h * 60, s, l]; }
  // seg = [h,s,l] of every pixel in one band -> one hsl() string: hue = circular mean of the coloured pixels (s>=.12) weighted by s squared, saturation = their weighted mean s (reduced, clamped), lightness = mean of all pixels, slightly reduced and clamped to 42%..66%
  function tone(seg, dl, smax) {
    let sx = 0, sy = 0, sw = 0, ssum = 0, lsum = 0;
    for (const [h, s, l] of seg) { lsum += l; if (s >= 0.12) { const w = s * s, a = h * Math.PI / 180; sx += Math.cos(a) * w; sy += Math.sin(a) * w; sw += w; ssum += s * w; } }
    const l = Math.min(0.66, Math.max(0.42, (lsum / seg.length) * 0.85 + dl));
    if (!sw) return "hsl(30 8% " + Math.round(l * 100) + "%)";
    let h = Math.atan2(sy, sx) * 180 / Math.PI; if (h < 0) h += 360;
    const s = Math.min(smax, Math.max(0.18, (ssum / sw) * 0.8));
    return "hsl(" + h.toFixed(0) + " " + Math.round(s * 100) + "% " + Math.round(l * 100) + "%)";
  }
  function toneOf(url, cb) {
    if (!url) { cb(null); return; }
    if (TONE_CACHE[url]) { cb(TONE_CACHE[url]); return; }
    const im = new Image(); im.decoding = "async";
    im.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = 16; c.height = 24; const x = c.getContext("2d"); x.drawImage(im, 0, 0, im.naturalWidth, im.naturalHeight / 2, 0, 0, 16, 24); // upper half of the tiling block = the upright image
        const d = x.getImageData(0, 0, 16, 24).data, seg = [[], [], []];
        for (let y = 0; y < 24; y++) for (let xx = 0; xx < 16; xx++) { const i = (y * 16 + xx) * 4; if (d[i + 3] < 128) continue; seg[y < 8 ? 0 : y < 16 ? 1 : 2].push(rgb2hsl(d[i], d[i + 1], d[i + 2])); } // transparent pixels (the fade baked into the bottom of the image) are skipped
        for (const s of seg) if (!s.length) s.push([30, 0.1, 0.5]);
        const t = { s0: tone(seg[2], 0.03, 0.5), s1: tone(seg[2], -0.03, 0.46), s2: tone(seg[2], -0.1, 0.42), glow: tone(seg[0], 0.12, 0.55), ar: im.naturalHeight / im.naturalWidth }; // the wallpaper is shown in full before it blends into the sea, so all three sea stops come from the image's bottom band (darker further down); ar = height / width ratio for the css
        TONE_CACHE[url] = t; cb(t);
      } catch (_) { cb(null); }
    };
    im.onerror = () => cb(null);
    im.src = url;
  }
  window.nfArticle = { esc, dateParts, fmtDate, bgUrl, bgThumbUrl, presetOf, toneOf, renderBody, renderFigure, logListHTML, pageHTML, patch, emptyHTML, ropeStart, setBackgrounds };
})();
