// Night Ferry: entrance animation. A patch of water seen from above: a small boat rows from the top-left corner to the bottom-right,
// a V-shaped wake opens behind it, and the article is revealed inside the wake until it covers the whole screen.
// How: a half-resolution 2D wave equation (the classic water-ripple scheme). The boat is a Gaussian source that keeps moving faster than
//   the wave speed, which gives a natural V wake (half-angle asin(wave speed / boat speed)). Each frame samples the painting refracted by
//   the surface slope, brightens light-facing slopes and adds foam on steep ones. The article layer is masked with a fan (conic-gradient)
//   whose apex trails the boat, soft on both sides, so the water blends in at its edges. A light drizzle falls in a band around the wake
//   so the water near the ripples keeps moving. The simulation is time-stepped (slow devices catch up with extra steps).
// Public API: window.nfVoyage.run({ canvas, img (decoded image of the whole painting), deck (article layer; its mask-image is written),
//   W, H, onDone, V (boat speed, optional), lag (optional), host (parent for the boat image, optional), boatZ (optional) })  ->  { cancel() }
//   Also exposes window.nfVoyage.{ PW, PH, BOAT_SRC }.
// Needs: assets/boat.png.
(function () {
  const PW = 1289, PH = 1674, BOAT_SRC = "assets/boat.png";
  function run(o) {
    const cv = o.canvas, deck = o.deck, W = o.W, H = o.H, img = o.img;
    const S = 2, w = Math.ceil(W / S), h = Math.ceil(H / S);
    cv.width = w; cv.height = h; cv.style.width = W + "px"; cv.style.height = H + "px";
    const ctx = cv.getContext("2d", { alpha: false });
    const sc = Math.max(w / (img.naturalWidth || PW), h / (img.naturalHeight || PH)), dw = (img.naturalWidth || PW) * sc, dh = (img.naturalHeight || PH) * sc;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    const src = ctx.getImageData(0, 0, w, h).data;
    const out = ctx.createImageData(w, h), od = out.data;
    let cur = new Float32Array(w * h), prev = new Float32Array(w * h);
    // heading: from outside the top-left corner to outside the bottom-right one (the diagonal)
    const V = o.V || 3.0, ALPHA = Math.asin(1 / V), TAN = Math.tan(ALPHA);
    const th = Math.atan2(h, w), dxu = Math.cos(th), dyu = Math.sin(th), nxu = -dyu, nyu = dxu;   // unit heading vector / normal
    const DAMP = 0.994, IMPULSE = 7, REFR = 2.2, SHADE = 0.85, STEP_MS = 1000 / 60, RAIN = 5, RAIN_AMP = 1.3, RAIN_W = 0.45;
    const LAG = o.lag == null ? 24 : o.lag, FADE = 5, FAN = 0.9; // fan half-angle = wake half-angle x FAN; LAG = how many cells the fan apex trails the stern; FADE = soft edge on each side of the fan (degrees)
    let px = -0.08 * w, py = -0.03 * h; // start: just outside the top-left corner; the course is the diagonal shifted down a little
    // fan angles (conic-gradient: 0deg = up, clockwise): the fan opens behind the boat
    const backDeg = (Math.atan2(-dxu, dyu) * 180 / Math.PI + 360) % 360, A = ALPHA * FAN * 180 / Math.PI;
    const corners = [[0, 0], [W, 0], [0, H], [W, H]];
    let last = null, acc = 0, raf = 0, dead = false, lampT = 0, lampN = 0;
    const BOAT_AXIS = 47.97 * Math.PI / 180;
    // The boat is its own <img> layer above the article (z 102), placed every frame from position / heading / sway. In the image the boat axis points down-right at 47.97deg with its centroid at (132.5, 179); the axis is drawn 44 cells long (88 css px, the hull itself about 48).
    const BK = 44 / 294, BW = 240 * BK * S, BH = 308 * BK * S, BCX = 132.5 * BK * S, BCY = 179 * BK * S;
    const boatEl = new Image(); boatEl.src = BOAT_SRC; boatEl.draggable = false;
    boatEl.style.cssText = "position:fixed;left:0;top:0;width:" + BW + "px;height:" + BH + "px;max-width:none;border:0;border-radius:0;background:none;box-shadow:none;padding:0;margin:0;pointer-events:none;z-index:" + (o.boatZ || 102) + ";transform-origin:" + BCX + "px " + BCY + "px;will-change:transform;opacity:0";
    (o.host || document.body).appendChild(boatEl);
    function placeBoat() {
      lampT += 1;
      const sway = 2.2 * Math.sin(lampT * 0.055) + 0.8 * Math.sin(lampT * 0.13);      // roll (degrees)
      const drift = 1.2 * Math.sin(lampT * 0.041), bob = 0.8 * Math.sin(lampT * 0.09);   // lateral drift / bob (css px)
      const x = px * S + drift * nxu * S - bob * dyu, y = py * S + drift * nyu * S + bob * dxu;
      const on = px > -40 && px < w + 40 && py > -40 && py < h + 40;
      boatEl.style.opacity = on ? "1" : "0";
      boatEl.style.transform = "translate(" + (x - BCX).toFixed(2) + "px," + (y - BCY).toFixed(2) + "px) rotate(" + ((th - BOAT_AXIS) * 180 / Math.PI + sway).toFixed(2) + "deg)";
    }
    function drop(bx, by, amp, rad) {
      const ix = Math.round(bx), iy = Math.round(by), R = rad || 5, s2 = R * R * 0.36;
      for (let yy = -R; yy <= R; yy++) for (let xx = -R; xx <= R; xx++) {
        const cx = ix + xx, cy = iy + yy;
        if (cx < 1 || cy < 1 || cx >= w - 1 || cy >= h - 1) continue;
        cur[cy * w + cx] -= amp * Math.exp(-(xx * xx + yy * yy) / s2);
      }
    }
    function step() {
      // press the water down on both sides of the stern (the hull parting it), and more lightly at the bow
      drop(px - 3 * dxu - 2.5 * nxu, py - 3 * dyu - 2.5 * nyu, IMPULSE);
      drop(px - 3 * dxu + 2.5 * nxu, py - 3 * dyu + 2.5 * nyu, IMPULSE);
      drop(px + 4 * dxu, py + 4 * dyu, IMPULSE * 0.6);
      // drizzle: falls in a band on both sides of the track behind the boat (RAIN_W x screen width wide, as long as the distance travelled), so the water around the ripples moves as well
      for (let k = 0; k < RAIN; k++) { const back = Math.random() * Math.min(w * 0.9, Math.hypot(px - (-0.08 * w), py - (-0.03 * h))), u = (Math.random() + Math.random() + Math.random()) / 3 * 2 - 1, lat = u * RAIN_W * w; drop(px - back * dxu + lat * nxu, py - back * dyu + lat * nyu, RAIN_AMP * (1 - Math.abs(u) * 0.7), 3); } // the mean of three randoms is roughly bell-shaped: dense near the track, sparse toward the edges, and the outer drops are lighter
      for (let yy = 1; yy < h - 1; yy++) {
        let i = yy * w + 1;
        for (let xx = 1; xx < w - 1; xx++, i++) prev[i] = ((cur[i - 1] + cur[i + 1] + cur[i - w] + cur[i + w]) * 0.5 - prev[i]) * DAMP;
      }
      const t = prev; prev = cur; cur = t;
    }
    function render() {
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const i = yy * w + xx;
          let dx = 0, dy = 0;
          if (xx > 0 && xx < w - 1 && yy > 0 && yy < h - 1) { dx = cur[i - 1] - cur[i + 1]; dy = cur[i - w] - cur[i + w]; }
          let sx = xx + dx * REFR, sy = yy + dy * REFR;
          if (sx < 0) sx = 0; else if (sx > w - 1) sx = w - 1;
          if (sy < 0) sy = 0; else if (sy > h - 1) sy = h - 1;
          const si = ((sy | 0) * w + (sx | 0)) * 4, oi = i * 4;
          let r = src[si], g = src[si + 1], b = src[si + 2];
          let sh = (dx - dy) * SHADE;
          if (sh > 0) { const foam = sh > 16 ? (sh - 16) * 1.4 : 0; sh += foam; r += sh; g += sh; b += sh * 0.96; }
          else { r += sh * 0.35; g += sh * 0.35; b += sh * 0.3; }
          od[oi] = r; od[oi + 1] = g; od[oi + 2] = b; od[oi + 3] = 255;
        }
      }
      ctx.putImageData(out, 0, 0);
    }
    // article = a fan centred on the apex and opening behind the boat, soft on both sides (conic-gradient mask); apex = LAG cells behind the stern
    function fan() {
      const ax = (px - LAG * dxu) * S, ay = (py - LAG * dyu) * S;
      const from = backDeg - A - FADE;
      const m = "conic-gradient(from " + from.toFixed(2) + "deg at " + ax.toFixed(1) + "px " + ay.toFixed(1) + "px, transparent 0deg, #000 " + FADE + "deg, #000 " + (FADE + 2 * A).toFixed(2) + "deg, transparent " + (2 * FADE + 2 * A).toFixed(2) + "deg, transparent 360deg)";
      deck.style.webkitMaskImage = m; deck.style.maskImage = m;
      // covered once all four corners are inside the fan (past the soft edge too)
      let all = true;
      for (const [cx, cy] of corners) {
        const vx = cx - ax, vy = cy - ay, len = Math.hypot(vx, vy);
        if (len < 1) continue;
        const cosang = (-(vx * dxu) - (vy * dyu)) / len; // angle to the "behind the boat" direction
        if (cosang < Math.cos(ALPHA * FAN - FADE * Math.PI / 180 * 0.999)) { all = false; break; }
      }
      return all;
    }
    function finish() { if (dead) return; dead = true; cancelAnimationFrame(raf); boatEl.remove(); deck.style.webkitMaskImage = ""; deck.style.maskImage = ""; if (o.onDone) o.onDone(); }
    function frame(now) {
      if (dead) return;
      if (last === null) last = now;
      acc += Math.min(200, now - last); last = now;
      let n = 0; while (acc >= STEP_MS && n < 12) { acc -= STEP_MS; n++; px += V * dxu; py += V * dyu; step(); }
      render(); placeBoat();
      if (fan()) { finish(); return; }
      raf = requestAnimationFrame(frame);
    }
    deck.style.clipPath = ""; // the article layer may have been hidden with clip-path before; the mask takes over here
    fan();
    raf = requestAnimationFrame(() => { raf = requestAnimationFrame(frame); });
    return { cancel() { dead = true; cancelAnimationFrame(raf); boatEl.remove(); } };
  }
  window.nfVoyage = { run, PW, PH, BOAT_SRC };
})();
