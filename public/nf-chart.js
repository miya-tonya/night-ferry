// Night Ferry: sea-chart line mesh. Rhumb lines in the manner of 14th-16th century Mediterranean portolan charts: a few compass roses
// each send thin lines out in 32 directions, layer over layer, like a pale gold web lying on the sea.
// No image assets: drawn as SVG at runtime. One large rose near each corner plus a small one at the left and right edges;
// the 8 principal winds are thicker and brighter, the 8 half-winds medium, the 16 quarter-winds thin and faint.
// Public API: window.nfChart.build(W, H) -> <svg> (fixed, full size, pointer-events none, opacity 0; the caller fades it in).
// Needs: nothing.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const GOLD = "#e9d8a6", GOLD2 = "#d9c27c";
  function el(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function rose(g, cx, cy, R, len, big) {
    // 32 rhumb lines: 0/90/180/270 brightest, then 45deg, then 22.5deg, 11.25deg faintest
    for (let i = 0; i < 32; i++) {
      const a = (i * Math.PI) / 16, x2 = cx + Math.cos(a) * len, y2 = cy + Math.sin(a) * len;
      const main = i % 8 === 0, half = i % 4 === 0, quarter = i % 2 === 0;
      const op = main ? 0.42 : half ? 0.3 : quarter ? 0.2 : 0.13, wd = main ? 0.9 : half ? 0.7 : 0.55;
      g.appendChild(el("line", { x1: cx, y1: cy, x2, y2, stroke: main ? GOLD : GOLD2, "stroke-width": wd, "stroke-opacity": op }));
    }
    // the rose itself: two concentric circles + a 16-point star (long and short points alternating)
    g.appendChild(el("circle", { cx, cy, r: R, fill: "none", stroke: GOLD, "stroke-width": 0.9, "stroke-opacity": 0.5 }));
    g.appendChild(el("circle", { cx, cy, r: R * 0.62, fill: "none", stroke: GOLD2, "stroke-width": 0.6, "stroke-opacity": 0.4 }));
    g.appendChild(el("circle", { cx, cy, r: R * 0.1, fill: GOLD, "fill-opacity": 0.5 }));
    let d = "";
    for (let i = 0; i < 32; i++) {
      const a = (i * Math.PI) / 16 - Math.PI / 2, r = i % 2 === 0 ? (i % 4 === 0 ? R * 0.92 : R * 0.62) : R * 0.3;
      d += (i ? "L" : "M") + (cx + Math.cos(a) * r).toFixed(1) + " " + (cy + Math.sin(a) * r).toFixed(1);
    }
    g.appendChild(el("path", { d: d + "Z", fill: GOLD, "fill-opacity": big ? 0.12 : 0.08, stroke: GOLD, "stroke-width": 0.7, "stroke-opacity": 0.55 }));
    // north marker (stands in for a fleur-de-lis: a small diamond)
    g.appendChild(el("path", { d: "M" + cx + " " + (cy - R * 1.08) + " l" + R * 0.08 + " " + R * 0.16 + " l-" + R * 0.08 + " " + R * 0.1 + " l-" + R * 0.08 + " -" + R * 0.1 + "Z", fill: GOLD, "fill-opacity": 0.6 }));
  }
  function build(W, H) {
    const svg = el("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, "aria-hidden": "true" });
    svg.style.cssText = "position:fixed;left:0;top:0;width:" + W + "px;height:" + H + "px;pointer-events:none;opacity:0;overflow:hidden";
    const g = el("g", { "stroke-linecap": "round" });
    const len = Math.hypot(W, H) * 1.05, Rb = Math.min(W, H) * 0.11, Rs = Math.min(W, H) * 0.065;
    // four corners (the roses sit near the screen edges; their lines cover the whole screen)
    rose(g, W * 0.06, H * 0.08, Rb, len, true);
    rose(g, W * 0.94, H * 0.07, Rb, len, true);
    rose(g, W * 0.07, H * 0.93, Rb, len, true);
    rose(g, W * 0.93, H * 0.92, Rb, len, true);
    // a small one at each side edge adds another layer of lines
    rose(g, W * 0.02, H * 0.47, Rs, len, false);
    rose(g, W * 0.98, H * 0.55, Rs, len, false);
    svg.appendChild(g);
    return svg;
  }
  window.nfChart = { build };
})();
