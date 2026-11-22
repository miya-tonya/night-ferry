// Night Ferry: standalone page script. The page is simply the reader shell (nf-reader.js) mounted on <body>.
// When <html> carries a data-enter attribute, the entrance animation (nf-voyage.js: boat and ripples) runs on this page first and
// the shell's buttons appear when it finishes.
// Public API: none. Needs: nf-reader.js + nf-article.js; optionally nf-voyage.js and nf-chart.js; a <canvas id="voyage" hidden>
// in the page; assets/moonsea.jpg; the --screen-h custom property on <html> is read when present.
(function () {
  const html = document.documentElement;
  const entering = html.hasAttribute("data-enter");
  const rd = window.nfReader.mount({ host: document.body, first: null, z: 100, chrome: !entering, hideDeck: entering, backHref: "index.html" });
  if (!entering) return;
  let ch = null; // the chart overlay shown during the entrance
  const done = () => { rd.showChrome(); html.removeAttribute("data-enter"); document.getElementById("voyage").setAttribute("hidden", ""); if (ch) { ch.remove(); ch = null; } };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !window.nfVoyage) { done(); return; }
  const img = new Image();
  img.src = "assets/moonsea.jpg";
  (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(() => {
    if (!img.naturalWidth) { done(); return; }
    const sh = parseFloat(getComputedStyle(html).getPropertyValue("--screen-h")) || 0;
    const cv = document.getElementById("voyage"); cv.removeAttribute("hidden");
    if (window.nfChart) { ch = window.nfChart.build(innerWidth, Math.max(innerHeight, sh)); ch.style.zIndex = "2"; ch.style.opacity = "1"; document.body.append(ch); } // during the entrance run the chart mesh is visible from the start
    // The entrance reads pixels back from the painting; a browser may refuse that (a page opened from disk counts as
    // cross-origin in Chromium). Whatever goes wrong, the reader must still open.
    try { window.nfVoyage.run({ canvas: cv, img, deck: rd.deck, W: innerWidth, H: Math.max(innerHeight, sh), onDone: done }); }
    catch (_) { done(); }
  });
})();
