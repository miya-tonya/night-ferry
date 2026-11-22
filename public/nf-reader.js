// Night Ferry: reader shell. One entry per page (a sheet of paper on the sea); swipe / drag left and right through past entries;
// per-entry background, two top buttons, a month overview, a wish list + long-running theme, note clouds on figures,
// the ship's log (comments) and the anchor drop at the end of each article.
// Can be mounted on its own page or opened in place on top of another page (no navigation, so nothing new has to load).
// Public API: const r = window.nfReader.mount({ host, first: {entry, tonight} | null, z, chrome: bool, hideDeck: bool,
//     backHref: string | null, onBack, night })  ->  { root, deck, showChrome(), destroy() }
//   host = parent element (default document.body); first = an entry to paint on the first frame without waiting for the network;
//   z = z-index of the shell; chrome = show the top buttons right away; hideDeck = start with the article layer masked out
//   (for the entrance animation; call showChrome() afterwards); backHref = render the back button as a link, otherwise onBack()
//   is called; night = "YYYY-MM-DD" of the entry to open (falls back to ?night= in the URL).
// Needs: nf-article.js (window.nfArticle), nf-reader.css, nf-article.css, and the api/night-ferry endpoints.
(function () {
  const A = () => window.nfArticle;
  const esc = (s) => A().esc(s);
  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || ("请求失败 " + r.status));
    return j;
  }
  const HTML = (backHref) =>
    (backHref ? '<a href="' + backHref + '" class="nfr-orb back" aria-label="返回">' : '<button type="button" class="nfr-orb back" aria-label="返回">') +
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' + (backHref ? "</a>" : "</button>") +
    '<button type="button" class="nfr-orb list" aria-label="一览"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
    '<main class="nf-deck" lang="zh-Hans"><div class="nf-deck-scroll"><div class="nf-inner"><div class="nf-hero none" aria-hidden="true"></div><div class="nf-hero-b none" aria-hidden="true"></div><article class="nf-page"></article></div></div></main>' +
    '<section class="nfr-ov" hidden><header class="nfr-ov-head"><button type="button" class="nfr-ov-arrow prev" aria-label="上个月"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2L4 8l7 6z" fill="currentColor"/></svg></button><div class="nfr-ov-month"></div><button type="button" class="nfr-ov-arrow next" aria-label="下个月"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2l7 6-7 6z" fill="currentColor"/></svg></button><button type="button" class="nfr-ov-close" aria-label="关闭">×</button></header>' +
    '<div class="nfr-ov-scroll"><div class="nfr-ov-list"></div>' +
    '<section class="nfr-wish"><h2>想听的</h2><form class="nfr-add" autocomplete="off"><input type="text" class="wish-in" maxlength="40" placeholder="想听什么就记上" enterkeyhint="done" /><button type="submit" aria-label="记上">＋</button></form>' +
    '<ul class="nfr-wish-list"></ul><div class="nfr-empty wish-empty" hidden>没有特别点题，他自由发挥</div>' +
    '<div class="nfr-theme"><label>这段时间多讲</label><input type="text" class="theme-in" maxlength="60" placeholder="比如：天文、日本历史…" enterkeyhint="done" /></div></section></div></section>';

  function mount(o) {
    o = o || {};
    const root = document.createElement("div");
    root.className = "nfr" + (o.chrome ? " nfr-chrome" : "");
    if (o.z != null) root.style.zIndex = String(o.z);
    root.innerHTML = HTML(o.backHref);
    const q = (s) => root.querySelector(s);
    const deck = q(".nf-deck"), scroll = q(".nf-deck-scroll"), hero = q(".nf-hero"), heroB = q(".nf-hero-b"), page = q(".nf-page");
    const ov = q(".nfr-ov"), ovMonth = q(".nfr-ov-month"), ovPrev = q(".nfr-ov-arrow.prev"), ovNext = q(".nfr-ov-arrow.next"), ovList = q(".nfr-ov-list");
    const wishForm = q(".nfr-add"), wishIn = q(".wish-in"), wishList = q(".nfr-wish-list"), wishEmpty = q(".wish-empty"), themeIn = q(".theme-in");
    if (o.hideDeck) { deck.style.webkitMaskImage = deck.style.maskImage = "linear-gradient(transparent, transparent)"; deck.classList.add("nf-voyaging"); }
    const state = { tonight: null, theme: "", wishes: [], entries: [], index: 0, ovMonth: null, preset: null, loaded: false, dead: false };
    (o.host || document.body).appendChild(root);

    /* ---------- article ---------- */
    function ctx(i) {
      if (i == null) i = state.index;
      return {
        no: state.loaded ? state.entries.length - i : 0,
        older: state.entries[i + 1] || null, newer: state.entries[i - 1] || null,
        notice: "", // no notice line at present
      };
    }
    // The anchor animation is triggered from the real scroll position, not from an IntersectionObserver (which fired prematurely, at the top of the page, on iOS Safari in testing; cause not investigated).
    let endPending = null;
    function watchEnd() {
      endPending = page.querySelector(".nf-end") || null;
      checkEnd();
    }
    function checkEnd() {
      const end = endPending; if (!end) return;
      // Drop as soon as everything above the ship's log is on screen: the anchor's own block, the "moored" line and the
      // closing note. That is the moment the reader can see the whole scene; waiting for the log (or the very bottom) is too late.
      // Reaching the very bottom still counts, as a fallback (2px tolerance: the touchstart handler below backs off 1px there).
      let reached = scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 2;
      if (!reached) { const last = end.querySelector(".nf-note") || end.querySelector(".nf-moor"); if (last) reached = last.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom; }
      if (!reached) return;
      endPending = null;
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      end.classList.add("on");
      if (A().ropeStart) { const an = end.querySelector(".nf-anchor"); if (an) A().ropeStart(an, { reduced }); }
    }
    scroll.addEventListener("scroll", checkEnd, { passive: true });
    state.arCache = {}; // url -> height / width ratio (already decoded), available at once when turning or dragging
    function decodeBg(url, cb) {
      if (!url) return;
      if (state.arCache[url]) { if (cb) cb(state.arCache[url]); return; }
      const im = new Image(); im.decoding = "async"; im.src = url;
      const done = () => { if (!im.naturalWidth) return; state.arCache[url] = im.naturalHeight / im.naturalWidth; (state.imgKeep = state.imgKeep || {})[url] = im; if (cb) cb(state.arCache[url]); };
      (im.decode ? im.decode() : new Promise((res, rej) => { im.onload = res; im.onerror = rej; })).then(done, () => { im.onload = done; });
    }
    function applyHero(url, ar) {
      state.picH = deck.clientWidth * ar / 2;
      for (const el of [hero, heroB, scroll]) { el.style.setProperty("--nf-hero-ar", String(ar)); el.style.setProperty("--nf-hero-img", "url('" + url.replace(/'/g, "%27") + "')"); }
      hero.classList.remove("none"); heroB.classList.remove("none"); scroll.classList.add("nf-wall");
      state.heroReady = true; heroFade(); wallPhase();
    }
    function setHero(e) {
      const url = e ? A().bgUrl(e) : "";
      state.heroUrl = url;
      if (!url) { state.heroReady = false; hero.classList.add("none"); heroB.classList.add("none"); scroll.classList.remove("nf-wall"); heroFade(); for (const el of [hero, heroB, scroll]) { el.style.removeProperty("--nf-hero-img"); el.style.removeProperty("--nf-hero-ar"); } return; }
      // keep the old wallpaper until the new one has decoded, then swap (at once if already decoded)
      decodeBg(url, (ar) => { if (state.dead || state.heroUrl !== url) return; applyHero(url, ar); });
      const apply = (t) => { if (state.dead || state.heroUrl !== url) return; const v = ["--sea-0", "--sea-1", "--sea-2", "--sea-glow"], k = ["s0", "s1", "s2", "glow"]; for (let i = 0; i < 4; i++) { if (t && t[k[i]]) deck.style.setProperty(v[i], t[k[i]]); else deck.style.removeProperty(v[i]); } };
      if (A().toneOf) A().toneOf(url, apply); else apply(null);
    }
    // container wallpaper phase = minus the max scroll offset, so at the bottom it lines up with the wallpaper in the content (bottom overscroll shows wallpaper); recomputed when the content height changes (page turn / images loading)
    function wallPhase() { const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight); scroll.style.setProperty("--nf-wall-y", (-max) + "px"); }
    if ("ResizeObserver" in window) { const ro = new ResizeObserver(() => wallPhase()); ro.observe(q(".nf-inner")); }
    window.addEventListener("resize", wallPhase);
    function heroFade() { const o = state.heroReady ? 1 : 0; hero.style.opacity = String(o); heroB.style.opacity = String(o); } // the wallpaper tiles all the way down; it does not fade on scroll

    function renderPage(dir) {
      const e = state.entries[state.index];
      if (!e) { page.className = "nf-page empty"; page.innerHTML = A().emptyHTML(); setHero(null); return; }
      page.className = "nf-page" + (dir === "older" ? " in-left" : dir === "newer" ? " in-right" : "");
      page.innerHTML = A().pageHTML(e, state.tonight, ctx());
      setHero(e);
      scroll.scrollTop = 0; // a freshly rendered page always starts at the top, and this must come before watchEnd (the anchor check reads the real scroll position)
      watchEnd();
      for (const n of [state.entries[state.index + 1], state.entries[state.index - 1]]) if (n) decodeBg(A().bgUrl(n)); // pre-decode the neighbours' wallpapers so a drag has them at once
    }
    function go(i, dir) {
      if (i < 0 || i >= state.entries.length || i === state.index) return;
      state.index = i; closeClouds(); renderPage(dir);
      try { history.replaceState(history.state, "", location.pathname + (i === 0 ? "" : "?night=" + state.entries[i].night)); } catch (_) {}
    }
    // The cloud is a drawing with a fixed text area (about the middle 62% of its height). A long note needs more room than that,
    // so measure the text once the cloud is displayed and, if it does not fit, make the cloud taller by just enough
    // (the drawing stretches a little; long notes also use a smaller type size, see .nf-long, so the stretch stays small).
    function fitCloud(cloud) {
      const body = cloud.querySelector(".nf-body"), puff = cloud.querySelector(".nf-puff");
      if (!body || !puff) return;
      body.style.height = ""; body.style.paddingTop = ""; body.style.aspectRatio = "";
      const natural = body.clientWidth * 1014 / 1536, need = puff.scrollHeight / 0.62;
      if (need > natural) { const h = Math.ceil(need); body.style.aspectRatio = "auto"; body.style.height = h + "px"; body.style.paddingTop = (h * 0.225).toFixed(1) + "px"; }
    }
    /* ---------- picture viewer ---------- */
    // The zoom button on a photo opens it full-screen: pinch to zoom and drag with two fingers, drag with one when zoomed in, double-tap toggles 1x / 2.5x, the wheel zooms on a desktop.
    // Saving: on touch devices through the system share sheet (navigator.share with a file — it offers 'Save Image'), because <a download> silently does nothing in an iOS home-screen app; a plain download elsewhere.
    // share() must run in the tap itself (awaiting the network first loses the user gesture), so the image is fetched into a blob as soon as the viewer opens. The system long-press menu on the image is left alone as a second way.
    let viewer = null;
    function closeViewer() { if (!viewer) return; const v = viewer; viewer = null; v.el.remove(); }
    function openViewer(fig) {
      const im = fig.querySelector(".nf-photo img"); if (!im) return;
      closeClouds(); closeViewer();
      const el = document.createElement("div");
      el.className = "nfr-view";
      el.innerHTML = '<div class="nfr-view-stage"><img alt="" draggable="false"></div>' +
        '<button type="button" class="nfr-view-btn save" aria-label="保存图片"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
        '<button type="button" class="nfr-view-btn close" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' +
        '<div class="nfr-view-cap"></div><div class="nfr-view-hint" hidden></div>';
      const stage = el.querySelector(".nfr-view-stage"), img = stage.querySelector("img"), hint = el.querySelector(".nfr-view-hint");
      const url = im.currentSrc || im.src;
      img.src = url; img.alt = im.alt || "";
      const cap = fig.querySelector("figcaption");
      if (cap) el.querySelector(".nfr-view-cap").innerHTML = cap.innerHTML; // our own rendered markup, already escaped
      root.appendChild(el);
      const v = viewer = { el, s: 1, x: 0, y: 0, blob: null };
      fetch(url).then((r) => (r.ok ? r.blob() : null)).then((b) => { v.blob = b; }).catch(() => {});
      const MAX = 5, pts = new Map();
      let g = null, tap = null, lastTap = 0;
      const centre = () => { const r = stage.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height }; };
      function apply() {
        const c = centre(), bx = Math.max(0, (img.offsetWidth * v.s - c.w) / 2), by = Math.max(0, (img.offsetHeight * v.s - c.h) / 2); // pan no further than the image overflows the screen
        v.x = Math.min(bx, Math.max(-bx, v.x)); v.y = Math.min(by, Math.max(-by, v.y));
        img.style.transform = "translate(" + v.x.toFixed(1) + "px," + v.y.toFixed(1) + "px) scale(" + v.s.toFixed(3) + ")";
        el.classList.toggle("zoomed", v.s > 1.01);
      }
      // zoom about a screen point: the spot of the image under it stays put
      function zoomAt(px, py, s, fromS, fromX, fromY) {
        const c = centre(), mx = px - c.cx, my = py - c.cy;
        v.s = Math.min(MAX, Math.max(1, s));
        v.x = mx - (mx - fromX) * (v.s / fromS); v.y = my - (my - fromY) * (v.s / fromS);
        apply();
      }
      function begin() {
        const a = [...pts.values()];
        if (a.length >= 2) g = { two: true, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, mx: (a[0].x + a[1].x) / 2, my: (a[0].y + a[1].y) / 2, s: v.s, x: v.x, y: v.y };
        else if (a.length === 1) g = { two: false, px: a[0].x, py: a[0].y, x: v.x, y: v.y };
        else g = null;
      }
      stage.addEventListener("pointerdown", (e) => {
        if (e.isPrimary) pts.clear(); // a first finger means no other is down: forget any pointer whose "up" never arrived
        try { stage.setPointerCapture(e.pointerId); } catch (_) {}
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        tap = pts.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), onImg: e.target === img } : null;
        begin();
      });
      stage.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId) || !g) return;
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const a = [...pts.values()];
        if (g.two && a.length >= 2) {
          const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, mx = (a[0].x + a[1].x) / 2, my = (a[0].y + a[1].y) / 2;
          // scale about the midpoint the gesture started at, then follow the midpoint as the fingers move
          zoomAt(g.mx, g.my, g.s * d / g.d, g.s, g.x, g.y);
          v.x += mx - g.mx; v.y += my - g.my; apply();
        } else if (!g.two && a.length === 1) {
          if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) tap = null;
          if (v.s > 1.01) { v.x = g.x + (e.clientX - g.px); v.y = g.y + (e.clientY - g.py); apply(); }
        }
      });
      const up = (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.delete(e.pointerId);
        if (tap && pts.size === 0 && performance.now() - tap.t < 300) {
          const now = performance.now();
          if (now - lastTap < 320) { lastTap = 0; if (v.s > 1.01) { v.s = 1; v.x = v.y = 0; apply(); } else zoomAt(tap.x, tap.y, 2.5, 1, 0, 0); } // double-tap
          else { lastTap = now; if (!tap.onImg && v.s <= 1.01) { const t = lastTap; setTimeout(() => { if (viewer === v && lastTap === t) closeViewer(); }, 330); } } // a tap on the empty area closes (after making sure it is not the first half of a double-tap)
        }
        tap = null;
        begin();
      };
      stage.addEventListener("pointerup", up);
      stage.addEventListener("pointercancel", up);
      stage.addEventListener("lostpointercapture", up);
      stage.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, v.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), v.s, v.x, v.y); }, { passive: false });
      el.querySelector(".close").addEventListener("click", closeViewer);
      el.querySelector(".save").addEventListener("click", () => {
        const name = (url.split("?")[0].split("/").pop() || "night-ferry.jpg");
        const say = (t) => { hint.textContent = t; hint.hidden = false; setTimeout(() => { hint.hidden = true; }, 2600); };
        const download = () => { const a = document.createElement("a"); a.href = v.blob ? URL.createObjectURL(v.blob) : url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); if (v.blob) setTimeout(() => URL.revokeObjectURL(a.href), 30000); };
        if (matchMedia("(pointer: coarse)").matches) {
          try {
            if (v.blob && navigator.canShare) {
              const file = new File([v.blob], name, { type: v.blob.type || "image/jpeg" });
              if (navigator.canShare({ files: [file] })) { navigator.share({ files: [file] }).catch((err) => { if (!err || err.name !== "AbortError") say("没存成，长按图片试试"); }); return; }
            }
          } catch (_) {}
          say("长按图片可以保存"); // this device cannot share files (or the blob is not there yet): point at the other way rather than trigger a download that does nothing
          return;
        }
        download();
      });
    }
    function closeClouds() { root.querySelectorAll(".nf-cloud.on").forEach((c) => { c.classList.remove("on"); c.classList.add("off"); setTimeout(() => c.classList.remove("off"), 750); }); } // disappears in reverse order (cloud -> medium dot -> small dot, css .off), then the class is dropped to return to the hidden state
    // Ship's log: add an entry / delete one of your own. Only the list is redrawn (input and scroll position untouched); the change is stored on that entry's log in state.entries, so it is still there after paging away and back.
    function logEntry(sec) { const id = sec && sec.dataset.id; return state.entries.find((x) => x.id === id) || null; }
    function logRedraw(sec, en) { const list = sec.querySelector(".nf-sl-list"); if (list && A().logListHTML) list.innerHTML = A().logListHTML(en); wallPhase(); }
    function logGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(140, ta.scrollHeight) + "px"; }
    page.addEventListener("input", (e) => { if (e.target.classList && e.target.classList.contains("nf-sl-in")) logGrow(e.target); });
    page.addEventListener("submit", async (e) => {
      const form = e.target.closest && e.target.closest(".nf-sl-form"); if (!form) return;
      e.preventDefault();
      const sec = form.closest(".nf-shiplog"), en = logEntry(sec), ta = form.querySelector(".nf-sl-in"), text = ta.value.trim();
      if (!en || !text || form.classList.contains("busy")) return;
      form.classList.add("busy");
      try {
        const j = await api("POST", "api/night-ferry/log", { entry_id: en.id, text });
        en.log = (Array.isArray(en.log) ? en.log : []).concat(j.log);
        ta.value = ""; logGrow(ta);
        if (sec.isConnected) logRedraw(sec, en);
      } catch (err) { alert(err.message); }
      form.classList.remove("busy");
    });
    page.addEventListener("click", async (e) => {
      const rm = e.target.closest(".nf-sl-rm"); if (!rm) return;
      const row = rm.closest(".nf-sl-row"), sec = rm.closest(".nf-shiplog"), en = logEntry(sec);
      if (!row || !en) return;
      if (!row.classList.contains("arm")) { row.classList.add("arm"); setTimeout(() => row.classList.remove("arm"), 2500); return; } // first tap arms the row (turns red); a second tap within 2.5s deletes
      try {
        await api("DELETE", "api/night-ferry/log/" + encodeURIComponent(row.dataset.lid));
        en.log = (en.log || []).filter((l) => l.id !== row.dataset.lid);
        if (sec.isConnected) logRedraw(sec, en);
      } catch (err) { alert(err.message); }
    });
    page.addEventListener("click", (e) => {
      if (e.target.closest(".nf-shiplog")) return;
      const nav = e.target.closest(".nf-nav button");
      if (nav) { if (nav.classList.contains("prev")) go(state.index + 1, "older"); else go(state.index - 1, "newer"); return; }
      const zoom = e.target.closest(".nf-zoom");
      if (zoom) { const zf = zoom.closest(".nf-fig"); if (zf) openViewer(zf); return; }
      const fig = e.target.closest(".nf-fig.has-note");
      if (!fig) { if (!e.target.closest(".nf-cloud")) closeClouds(); return; }
      const cloud = fig.querySelector(".nf-cloud");
      if (!cloud || e.target.closest(".nf-cloud") || !e.target.closest(".nf-photo")) return;
      const on = cloud.classList.contains("on"); closeClouds(); if (!on) { cloud.classList.add("on"); fitCloud(cloud); }
    });
    // Drag to turn pages: the first 10px decide the direction (vertical is left to scrolling; touches starting within 24px of the left edge are ignored and left to the system back gesture).
    //      Horizontal: the neighbour is rendered temporarily as .nf-peer over the visible window and moves with the current page under the finger; on release, position (past half) or fling velocity decides between going to the neighbour and springing back.
    const inner = q(".nf-inner");
    let x0 = 0, y0 = 0, t0 = 0, lock = null, drag = null; // lock: null undecided / "h" / "v" / "x"
    function peerBuild(i) {
      const e = state.entries[i]; if (!e) return null;
      const p = document.createElement("div"); p.className = "nf-inner nf-peer";
      p.style.top = scroll.scrollTop + "px"; p.style.height = scroll.clientHeight + "px";
      p.innerHTML = '<article class="nf-page"></article>';
      p.querySelector(".nf-page").innerHTML = A().pageHTML(e, state.tonight, ctx(i));
      const url = A().bgUrl(e);
      const put = () => { p.style.setProperty("--nf-hero-img", "url('" + url.replace(/'/g, "%27") + "')"); };
      if (state.arCache[url]) put(); else decodeBg(url, () => { if (p.isConnected) put(); });
      scroll.appendChild(p);
      return p;
    }
    function dragTo(dx) {
      const W = deck.clientWidth, dir = dx < 0 ? 1 : -1, target = state.index + dir; // drag left -> the previous night (index+1)
      if (!drag || drag.target !== target) {
        if (drag && drag.peer) drag.peer.remove();
        drag = { target, peer: null, W };
        if (target >= 0 && target < state.entries.length) drag.peer = peerBuild(target);
      }
      drag.dir = dir;
      if (!drag.peer) { drag.dx = 0; return; } // no neighbour (newest / oldest entry): do not move at all
      inner.style.transition = ""; inner.style.transform = "translateX(" + dx + "px)";
      drag.peer.style.transition = ""; drag.peer.style.transform = "translateX(" + (dx + dir * W) + "px)";
      drag.dx = dx;
    }
    // After release, sliding into place / springing back is a 300ms animation followed by cleanup (switch page, clear transforms, remove the peer layer). If that cleanup lived only in a timer, a second quick swipe landing within those 300ms would later have its transform cleared and its peer layer removed by the timer, freezing the view.
    //      So the cleanup is kept in settle; a new gesture calls settleNow() to finish it immediately (skipping the animation) and starts from a clean state.
    let settle = null, ghosts = []; // ghosts: nodes that are hidden rather than removed during a gesture (once the node under a finger is removed, that touch's later events no longer bubble to deck)
    function ghostOf(el) { el.style.display = "none"; ghosts.push(el); }
    function clearGhosts() { for (const g of ghosts) g.remove(); ghosts = []; }
    function settleNow() { if (!settle) return; const s = settle; settle = null; clearTimeout(s.timer); s.fin(true); }
    function dragEnd(vx) {
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.peer) { inner.style.transition = ""; inner.style.transform = ""; return; } // no neighbour: nothing moved
      const W = d.W, commit = Math.abs(d.dx) > W / 2 || (Math.abs(vx) > 0.35 && Math.sign(vx) === -d.dir);
      const ease = "transform 0.28s cubic-bezier(0.2, 0.7, 0.3, 1)";
      inner.style.transition = ease; d.peer.style.transition = ease;
      let fin;
      if (commit) {
        inner.style.transform = "translateX(" + (-d.dir * W) + "px)"; d.peer.style.transform = "translateX(0)";
        fin = (early) => {
          const url = A().bgUrl(state.entries[d.target]); if (state.arCache[url]) { state.heroUrl = url; applyHero(url, state.arCache[url]); } // swap the wallpaper synchronously first so nothing flashes
          if (early) { const g = document.createElement("div"); g.style.display = "none"; while (page.firstChild) g.appendChild(page.firstChild); deck.appendChild(g); ghosts.push(g); } // move the old article nodes aside, hidden (a finger may be resting on them), so innerHTML does not destroy them
          state.index = d.target; closeClouds(); renderPage(null); // renderPage resets the scroll position (reset first, then check the anchor)
          inner.style.transition = ""; inner.style.transform = "";
          if (early) ghostOf(d.peer); // a new gesture is already waiting: get out of the way now (hide; removed on touchend)
          else { // the current page is already switched (scrollTop 0); the peer layer stays on top for another 200ms and is removed once the wallpaper underneath has painted, so nothing flashes
            d.peer.style.top = "0px"; d.peer.style.zIndex = "3";
            settle = { fin: () => ghostOf(d.peer), timer: setTimeout(() => { settle = null; d.peer.remove(); }, 200) };
          }
          try { history.replaceState(history.state, "", location.pathname + (d.target === 0 ? "" : "?night=" + state.entries[d.target].night)); } catch (_) {}
        };
      } else {
        inner.style.transform = "translateX(0)"; d.peer.style.transform = "translateX(" + (d.dir * W) + "px)";
        fin = (early) => { inner.style.transition = ""; inner.style.transform = ""; if (early) ghostOf(d.peer); else d.peer.remove(); };
      }
      settle = { fin, timer: setTimeout(() => { settle = null; fin(false); }, 300) };
    }
    // Bottom rubber-banding: the finger-held drag past the bottom is blocked. If the touch starts at the bottom, back off 1px first (iOS only rubber-bands when at the boundary), and preventDefault the whole gesture while at the bottom and dragging up. The bounce at the end of momentum scrolling is a system deceleration animation and cannot be blocked.
    let atBottom = false, holdB = false;
    const nearBottom = () => scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 1;
    scroll.addEventListener("touchstart", (e) => { holdB = false; atBottom = nearBottom(); if (atBottom && scroll.scrollTop > 0) scroll.scrollTop -= 1; }, { passive: true });
    scroll.addEventListener("touchmove", (e) => { if (!atBottom || !e.cancelable) return; const dy = e.touches[0].clientY - y0; if (holdB || dy < 0) { holdB = true; e.preventDefault(); } }, { passive: false });
    scroll.addEventListener("touchend", () => { atBottom = false; holdB = false; }, { passive: true });
    let lastX = 0, lastT = 0, vx = 0;
    deck.addEventListener("touchstart", (e) => { settleNow(); if (e.touches.length !== 1 || drag) { lock = "x"; return; } x0 = lastX = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = lastT = Date.now(); vx = 0; lock = x0 < 24 ? "x" : null; }, { passive: true });
    deck.addEventListener("touchmove", (e) => {
      if (lock === "x" || lock === "v") return;
      const t = e.touches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (lock === null) { if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; lock = Math.abs(dx) > Math.abs(dy) * 1.3 ? "h" : "v"; if (lock === "v") return; }
      if (e.cancelable) e.preventDefault();
      const now = Date.now(); if (now > lastT) { vx = (t.clientX - lastX) / (now - lastT); lastX = t.clientX; lastT = now; }
      dragTo(dx);
    }, { passive: false });
    deck.addEventListener("touchend", () => { const was = lock; lock = "x"; if (was === "h") dragEnd(Date.now() - lastT > 80 ? 0 : vx); clearGhosts(); }, { passive: true });
    deck.addEventListener("touchcancel", () => { lock = "x"; dragEnd(0); clearGhosts(); }, { passive: true });
    const onKey = (e) => { if (viewer) { if (e.key === "Escape") closeViewer(); return; } if (!ov.hidden) return; if (e.target && /^(TEXTAREA|INPUT)$/.test(e.target.tagName || "")) return; if (e.key === "ArrowLeft") go(state.index + 1, "older"); if (e.key === "ArrowRight") go(state.index - 1, "newer"); };
    document.addEventListener("keydown", onKey);

    /* ---------- data: paint the handed-over entry on the first frame (no network wait), then page back from the newest to the oldest ---------- */
    if (o.first && o.first.entry) { state.tonight = o.first.tonight || null; state.entries = [o.first.entry]; state.index = 0; state.preset = o.first.entry.id; renderPage(null); }
    async function load() {
      const j = await api("GET", "api/night-ferry?limit=60");
      if (j.backgrounds) A().setBackgrounds(j.backgrounds); // before anything is drawn from this response
      if (state.dead) return;
      state.tonight = j.tonight; state.theme = j.theme || ""; state.wishes = j.wishes || []; state.entries = j.entries || [];
      let more = j.has_more, guard = 0;
      while (more && guard++ < 40 && state.entries.length) {
        const last = state.entries[state.entries.length - 1];
        const k = await api("GET", "api/night-ferry?limit=60&before=" + encodeURIComponent(last.night));
        if (state.dead) return;
        state.entries = state.entries.concat(k.entries || []); more = k.has_more && (k.entries || []).length > 0;
      }
      state.loaded = true;
      const want = (o.night) || new URLSearchParams(location.search).get("night");
      const i = want ? state.entries.findIndex((e) => e.night === want) : -1;
      state.index = i >= 0 ? i : 0;
      const e0 = state.entries[state.index];
      if (state.preset && e0 && e0.id === state.preset) { // the entry painted on the first frame is not re-rendered (that would flicker and jump to the top); only log number / neighbours / notice are patched
        A().patch(page, ctx());
        const sec = page.querySelector(".nf-shiplog"); // the handed-over entry may have been fetched a while ago: refresh its log list from the fresh data (harmless while someone is typing, the input is untouched)
        if (sec && sec.dataset.id === e0.id) logRedraw(sec, e0);
      }
      else renderPage(null);
      state.preset = null;
      renderWishes();
      if (document.activeElement !== themeIn) themeIn.value = state.theme;
    }
    load().catch((err) => { if (!state.entries.length) { page.className = "nf-page empty"; page.innerHTML = '<div class="nf-body"><p>' + esc(err.message) + "</p></div>"; } });

    /* ---------- overview ---------- */
    const monthKey = (n) => n.slice(0, 7);
    function months() { const s = []; for (const e of state.entries) { const k = monthKey(e.night); if (!s.includes(k)) s.push(k); } return s; }
    function renderOverview() {
      const ms = months(), k = state.ovMonth, [y, m] = k.split("-").map(Number), idx = ms.indexOf(k);
      ovMonth.textContent = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]; ovMonth.textContent = y + " " + ovMonth.textContent; // English month name (script font set in the css), year first
      ovPrev.classList.toggle("off", !(idx >= 0 ? idx + 1 < ms.length : ms.some((mm) => mm < k)));
      ovNext.classList.toggle("off", !(idx >= 0 ? idx - 1 >= 0 : ms.some((mm) => mm > k)));
      const rows = state.entries.map((e, i) => ({ e, i })).filter((x) => monthKey(x.e.night) === k), cur = state.entries[state.index];
      const key = k + "|" + state.entries.length + "|" + (state.entries[0] ? state.entries[0].id : "");
      state.ovCache = state.ovCache || {};
      if (state.ovCache[key]) { // already built: only update the current-row outline
        if (ovList.firstChild !== state.ovCache[key]) { ovList.innerHTML = ""; ovList.appendChild(state.ovCache[key]); }
        ovList.querySelectorAll(".nfr-ov-row").forEach((row) => row.classList.toggle("now", !!cur && state.entries[Number(row.dataset.i)] && state.entries[Number(row.dataset.i)].id === cur.id));
        return;
      }
      const frag = document.createElement("div"); frag.className = "nfr-ov-month-list";
      frag.innerHTML = rows.length ? rows.map(({ e, i }) => {
        const p = A().dateParts(e.night), bg = (e.bg || (A().presetOf && A().presetOf(e))) ? (A().bgThumbUrl ? A().bgThumbUrl(e) : A().bgUrl(e)) : "", pos = (A().bgThumbUrl && !e.bg) ? "center center" : "center 30%"; // row background = this entry's background (explicit, or the preset picked for it); none -> no image
        return '<button type="button" class="nfr-ov-row' + (cur && cur.id === e.id ? " now" : "") + (bg ? "" : " plain") + '" data-i="' + i + '">' +
          (bg ? '<span class="bg" style="background:url(\'' + esc(String(bg).replace(/'/g, "%27")) + '\') ' + pos + ' / 100% auto no-repeat"></span>' : "") + // explicit backgrounds are positioned at 30% so the crop stays inside the upright half of the tiling block and off the mirror seam
          '<span class="d"><b>' + p.d + "</b><span>周" + p.wd + "</span></span><span class=\"t\">" + esc(e.title) + (e.topic ? "<small>" + esc(e.topic) + "</small>" : "") + "</span></button>";
      }).join("") : '<div class="nfr-ov-empty">这个月船没开过</div>';
      state.ovCache[key] = frag; ovList.innerHTML = ""; ovList.appendChild(frag);
    }
    function stepMonth(dir) { const ms = months(), k = state.ovMonth, c = dir < 0 ? ms.filter((mm) => mm < k) : ms.filter((mm) => mm > k).reverse(); if (!c.length) return; state.ovMonth = c[0]; renderOverview(); }
    q(".nfr-orb.list").addEventListener("click", () => { const cur = state.entries[state.index]; state.ovMonth = cur ? monthKey(cur.night) : (state.tonight || new Date().toISOString()).slice(0, 7); renderOverview(); ov.hidden = false; });
    q(".nfr-ov-close").addEventListener("click", () => { ov.hidden = true; });
    ovPrev.addEventListener("click", () => stepMonth(-1)); ovNext.addEventListener("click", () => stepMonth(1));
    ovList.addEventListener("click", (e) => { const row = e.target.closest(".nfr-ov-row"); if (!row) return; const i = Number(row.dataset.i); ov.hidden = true; go(i, i > state.index ? "older" : "newer"); });
    const back = q(".nfr-orb.back");
    if (!o.backHref) back.addEventListener("click", () => { if (o.onBack) o.onBack(); });

    /* ---------- wish list / long-running theme ---------- */
    function renderWishes() {
      wishList.innerHTML = state.wishes.map((w) => '<li data-id="' + esc(w.id) + '" class="' + (w.done_at ? "done" : "") + '"><span class="name">' + esc(w.name) + '</span><span class="m">' + (w.done_at ? "讲过了" : esc(w.ts.slice(5, 10).replace("-", "/"))) + '</span><button type="button" class="rm" aria-label="删掉">×</button></li>').join("");
      wishEmpty.hidden = state.wishes.length > 0;
    }
    wishForm.addEventListener("submit", async (e) => {
      e.preventDefault(); const name = wishIn.value.trim(); if (!name) return;
      try { const j = await api("POST", "api/night-ferry/wishes", { name }); wishIn.value = ""; if (j.entry) state.wishes.push(j.entry); renderWishes(); } catch (err) { alert(err.message); }
    });
    wishList.addEventListener("click", async (e) => {
      const btn = e.target.closest(".rm"); if (!btn) return;
      try { const id = btn.closest("li").dataset.id; await api("DELETE", "api/night-ferry/wishes/" + encodeURIComponent(id)); state.wishes = state.wishes.filter((w) => w.id !== id); renderWishes(); } catch (err) { alert(err.message); }
    });
    let themeTimer = null;
    async function saveTheme() { clearTimeout(themeTimer); const text = themeIn.value.trim(); if (text === state.theme) return; try { const j = await api("POST", "api/night-ferry/theme", { text }); state.theme = j.theme; } catch (err) { alert(err.message); } }
    themeIn.addEventListener("input", () => { clearTimeout(themeTimer); themeTimer = setTimeout(saveTheme, 600); });
    themeIn.addEventListener("change", saveTheme);

    return {
      root, deck,
      showChrome() { root.classList.add("nfr-chrome"); deck.style.webkitMaskImage = deck.style.maskImage = ""; deck.classList.remove("nf-voyaging"); },
      destroy() { state.dead = true; document.removeEventListener("keydown", onKey); root.remove(); },
    };
  }
  window.nfReader = { mount };
})();
