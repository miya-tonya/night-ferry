// Night Ferry: demo mode. Answers the reader's API calls from the bundled sample data
// (demo/demo-data.js → window.NF_DEMO) so the page works with no server at all —
// opened from disk, on a static host, or with ?demo=1. Notes and wishes you add live in
// memory and are gone on reload. With a real server behind the page this file does nothing.
(function () {
  const D = window.NF_DEMO;
  if (!D) return;
  // ?demo=1 sticks for the rest of the tab session, so links between the cover and the reader stay in demo mode
  let sticky = false;
  try { if (/[?&]demo=1/.test(location.search)) sessionStorage.setItem("nf_demo", "1"); sticky = sessionStorage.getItem("nf_demo") === "1"; } catch (_) {}
  const on = location.protocol === "file:" || sticky || /\.github\.io$/.test(location.hostname);
  if (!on) return;
  const BACKGROUNDS = D.backgrounds || []; // copied from assets/backgrounds/backgrounds.json when the demo data is built
  const state = { theme: D.theme || "", wishes: (D.wishes || []).slice(), logs: (D.logs || []).slice() };
  const entries = (D.entries || []).slice().sort((a, b) => (a.night > b.night ? -1 : 1));
  let seq = 0;
  const id = (p) => p + "_local" + ++seq;
  const pub = (e) => ({
    ...e,
    images: (e.images || []).map((j) => (j.file ? { n: j.n, url: "demo/images/" + j.file, caption: j.caption, credit: j.credit, note: j.note, source_url: j.source_url } : { n: j.n, url: null })),
    log: state.logs.filter((l) => l.entry_id === e.id).sort((a, b) => (a.ts < b.ts ? -1 : 1)),
    image_status: "done",
  });
  const reply = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });

  function handle(method, url, body) {
    const u = new URL(url, location.href);
    const rest = u.pathname.replace(/^.*\/api\/night-ferry/, "");
    if (method === "GET" && (rest === "" || rest === "/")) {
      const before = u.searchParams.get("before") || "";
      const pool = before ? entries.filter((e) => e.night < before) : entries;
      const limit = Math.min(60, Number(u.searchParams.get("limit")) || 20);
      return reply({ tonight: entries.length ? entries[0].night : "", theme: state.theme, wishes: state.wishes, entries: pool.slice(0, limit).map(pub), has_more: pool.length > limit, total: entries.length, backgrounds: BACKGROUNDS });
    }
    if (method === "POST" && rest === "/wishes") {
      const name = String((body || {}).name || "").trim().slice(0, 40);
      if (!name) return reply({ ok: false, error: "不能空" }, 400);
      const entry = { kind: "wish", id: id("nfw"), ts: new Date().toISOString(), name, done_at: null };
      state.wishes.unshift(entry);
      return reply({ ok: true, entry });
    }
    if (method === "DELETE" && rest.indexOf("/wishes/") === 0) {
      state.wishes = state.wishes.filter((w) => w.id !== decodeURIComponent(rest.slice(8)));
      return reply({ ok: true });
    }
    if (method === "POST" && rest === "/log") {
      const text = String((body || {}).text || "").trim().slice(0, 300);
      if (!text) return reply({ ok: false, error: "不能空" }, 400);
      const log = { id: id("nfl"), ts: new Date().toISOString(), entry_id: String(body.entry_id || ""), who: "reader", text };
      state.logs.push(log);
      return reply({ ok: true, log: { id: log.id, ts: log.ts, who: log.who, text: log.text } });
    }
    if (method === "DELETE" && rest.indexOf("/log/") === 0) {
      const lid = decodeURIComponent(rest.slice(5)), l = state.logs.find((x) => x.id === lid);
      if (!l) return reply({ ok: false, error: "没有这条" }, 404);
      if (l.who !== "reader") return reply({ ok: false, error: "不是你写的，不能删" }, 403);
      state.logs = state.logs.filter((x) => x.id !== lid);
      return reply({ ok: true });
    }
    if (method === "POST" && rest === "/theme") {
      state.theme = String((body || {}).text || "").trim().slice(0, 60);
      return reply({ ok: true, theme: state.theme });
    }
    return reply({ ok: false, error: "not in the demo" }, 404);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    if (!url || !/(^|\/)api\/night-ferry(\/|\?|$)/.test(url)) return realFetch(input, init);
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
    return Promise.resolve(handle(((init && init.method) || "GET").toUpperCase(), url, body));
  };
  window.NF_DEMO_ACTIVE = true;
})();
