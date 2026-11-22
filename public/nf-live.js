// Night Ferry: "living painting". Aivazovsky's moonlit seascape (public domain) animated in WebGL: the sea heaves with noise and the
// bright water along the moon path glitters, the clouds drift as a two-layer cross-faded flow (the area around the moon is pinned),
// the ship rocks about its waterline and bobs (a local warp, no cut-out), and the moon slowly pulses.
// Textures: assets/live-tex.jpg (the painting stretched to a power-of-two 1024x2048 so it can be mipmapped; without mipmaps a view
//   scaled down about 5x shimmers) and assets/live-mask.png (R = sea, G = clouds, B = ship).
// Public API: const live = window.nfLive.create({ canvas, dpr, params, tex, mask })  ->
//   { canvas, ok, ready (Promise), loaded(), params, time(), setSize(cssW, cssH, dpr), setView({x,y,w,h}), view(),
//     setSlopes(bytes, w, h, {scale, edge, refr, grid, shade}), clearWater(), setFan(f), clearFan(),
//     setChart(src), setChartAlpha(a), clearChart(), set(params), render(nowMs), start(), stop(), running(), destroy(), glError() }
//  - append the canvas wherever it belongs and style it from outside; setSize only changes the pixel size (its third argument can cap dpr)
//  - setView: the uv rectangle of the painting that the canvas shows (x,y origin, w,h span; default 0,0,1,1 = the whole painting);
//    it may exceed the painting, in which case the edge pixels are repeated
//  - setSlopes: a screen-space slope field from an external ripple simulation (format at api.setSlopes below); refraction, light-facing
//    highlights and foam all happen in the shader, so the canvas is never read back to the CPU
//  - setFan: a fan-shaped region drawn with alpha 0 so that content underneath the canvas shows through (parameters at api.setFan below)
//  - render(now) draws one frame synchronously; all instances share one time origin, so switching between canvases is seamless
// Also exposes window.nfLive.{ DEF, TEX, MASK, PW, PH }. Needs: assets/live-tex.jpg, assets/live-mask.png.
(function () {
  if (window.nfLive) return;
  const TEX = 'assets/live-tex.jpg', MASK = 'assets/live-mask.png';
  const PW = 1289, PH = 1674;
  const DEF = { cloudSpeed: 0.138, cloudPeriod: 7.5, cloudDirX: -1, cloudDirY: 0.08, seaAmp: 0.022, sparkle: 0.75, shipDeg: 2.1, shipPeriod: 4, moonPulse: 0.07, waveBoost: 1.8, waveX: 0.19, waveY: 0.72 };
  const VS = 'attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*0.5+0.5,0.5-p.y*0.5);gl_Position=vec4(p,0.0,1.0);}';
  const FS = [
    'precision highp float;varying vec2 v;uniform sampler2D uTex,uMask,uWater,uChart;uniform float uT,uCloudSpeed,uCloudPeriod,uSeaAmp,uSparkle,uShipDeg,uShipPeriod,uMoonPulse,uAspect,uWaterOn,uShade,uWaveBoost,uSScale,uRefrPx,uFanOn,uFanAd,uFanFade,uTipOn,uTipR,uChord,uChartOn,uChartA;uniform vec2 uCloudDir,uViewOff,uViewScale,uRefr,uWaveC,uCss,uFanApex,uFanBack,uTipC;',
    'float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}',
    'float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);float a=hash(i),b=hash(i+vec2(1.0,0.0)),c=hash(i+vec2(0.0,1.0)),d=hash(i+vec2(1.0,1.0));return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}',
    'void main(){',
    ' vec2 q=uViewOff+v*uViewScale;', // q = the painting uv for this pixel (may leave 0..1; the textures clamp to the edge)
    // water (entrance ripples): screen-space slope field -> refraction offset (in painting uv) + highlights on light-facing slopes / foam
    ' float wdx=0.0,wdy=0.0;',
    ' if(uWaterOn>0.5){vec4 s=texture2D(uWater,v);float ux=(s.r-0.50196)*2.0079,uy=(s.a-0.50196)*2.0079;wdx=ux*abs(ux)*uSScale;wdy=uy*abs(uy)*uSScale;q+=vec2(wdx,wdy)*uRefr;}', // slopes come in the texture (r = dx, a = dy; 128 = 0), precomputed on the CPU with square-root companding; decoded as u*|u| * scale
    ' vec2 uv=q;vec4 m=texture2D(uMask,q);float sea=m.r,sky=m.g,ship=m.b;',
    // ship: rotate by th about the waterline pivot (weight = mask B, feathered to 0 so the nearby waves move gently too) + bob up and down
    ' vec2 piv=vec2(0.6788,0.6690);',
    ' float th=radians(uShipDeg)*(sin(6.2832*uT/uShipPeriod)+0.35*sin(6.2832*uT/(uShipPeriod*0.37)+1.0));',
    ' float bob=0.0018*sin(6.2832*uT/uShipPeriod+0.8);',
    ' if(ship>0.001){vec2 d=uv-piv;d.x*=uAspect;float a=-th*ship,c=cos(a),s=sin(a);d=vec2(c*d.x-s*d.y,s*d.x+c*d.y);d.x/=uAspect;uv=piv+d+vec2(0.0,bob*ship);}',
    // sea: two layers of low-frequency noise displacement (tiny just below the horizon -> largest in the mid-distance swell band (.70~.77) -> 1/4 at the shore), plus a fine glitter field
    ' vec2 duv=vec2(0.0);float glint=0.0;',
    ' if(sea>0.001){',
    '  float persp=(0.15+0.85*smoothstep(0.648,0.70,q.y))*(1.0-0.75*smoothstep(0.77,0.95,q.y));',
    '  float bw=length((q-uWaveC)/vec2(0.19,0.045));persp*=1.0+uWaveBoost*(1.0-smoothstep(0.5,1.4,bw));', // extra heave for the row of large breakers at lower left
    '  float n1=vn(vec2(q.x*5.0+uT*0.04,q.y*22.0-uT*0.16));',
    '  float n2=vn(vec2(q.x*13.0-uT*0.07,q.y*55.0-uT*0.38));',
    '  duv=vec2((n2-0.5)*0.2,(n1-0.5)+0.4*(n2-0.5))*uSeaAmp*persp*sea;',
    '  float g1=vn(vec2(q.x*60.0+uT*0.35,q.y*140.0-uT*1.1));',
    '  float g2=vn(vec2(q.x*35.0-uT*0.25,q.y*90.0+uT*0.7));',
    '  glint=pow(g1*g2,1.6)*2.2-0.35;',
    ' }',
    // clouds: two copies of the painting each drift half a period along the flow field, cross-faded with triangular weights (plotagraph style); flow = direction x speed x mask G (0 near the moon / ship / horizon)
    ' vec2 flow=uCloudDir*uCloudSpeed*sky;',
    ' float p1=fract(uT/uCloudPeriod),p2=fract(p1+0.5);float w1=1.0-abs(2.0*p1-1.0),w2=1.0-w1;',
    ' vec2 uv1=uv-flow*(p1-0.5)+duv,uv2=uv-flow*(p2-0.5)+duv;',
    ' vec3 c=texture2D(uTex,uv1).rgb*w1+texture2D(uTex,uv2).rgb*w2;',
    // glitter: only water that is already bright in the painting (moon path, wave crests, wet-sand reflections) follows the glitter field
    ' float L=dot(c,vec3(0.299,0.587,0.114));float bright=smoothstep(0.30,0.80,L);',
    ' c*=1.0+uSparkle*sea*bright*glint;',
    // moon pulse
    ' float dm=distance(vec2(q.x*uAspect,q.y),vec2(0.4461*uAspect,0.2658));float mw=1.0-smoothstep(0.0,0.09,dm);',
    ' c*=1.0+uMoonPulse*mw*sin(uT*0.55);',
    // water shading (same numbers as the CPU version in nf-voyage.js: light-facing slopes (dx-dy>0) are brightened, foam is added above 16; shaded slopes are darkened a little)
    ' if(uWaterOn>0.5){float sh=(wdx-wdy)*uShade;if(sh>0.0){float foam=sh>16.0?(sh-16.0)*1.4:0.0;sh+=foam;c+=vec3(sh,sh,sh*0.96)/255.0;}else{c+=vec3(sh*0.35,sh*0.35,sh*0.3)/255.0;}}',
    // sea chart: a bitmap texture overlaid in screen coordinates (not refracted by the water); uChartA = fade-in progress
    ' if(uChartOn>0.5){vec4 ch=texture2D(uChart,v);c=mix(c,ch.rgb,ch.a*uChartA);}',
    // article fan: inside a fan centred on the apex and opening behind the boat, alpha = 0 (the content underneath shows through), with a linear soft edge of uFanFade on each side; rounded apex = cut off everything ahead of a chord (toward the boat), then add back a small circle tangent to both arms
    ' float a=1.0;',
    ' if(uFanOn>0.5){vec2 P=v*uCss+vec2(wdx,wdy)*uRefrPx;vec2 d=P-uFanApex;float len=max(length(d),0.001);float ang=acos(clamp(dot(d,uFanBack)/len,-1.0,1.0));float m=1.0-clamp((ang-uFanAd)/uFanFade,0.0,1.0);',
    '  if(uTipOn>0.5){m*=clamp(dot(d,uFanBack)-uChord+0.5,0.0,1.0);float disc=1.0-smoothstep(uTipR-2.0,uTipR+2.0,distance(P,uTipC));m=max(m,disc);}',
    '  a=1.0-m;}',
    ' gl_FragColor=vec4(c*a,a);}'
  ].join('\n');
  const T0 = performance.now();
  const loadImg = (src) => (src && src.naturalWidth) ? Promise.resolve(src) : new Promise((ok, no) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => ok(im); im.onerror = no; im.src = typeof src === 'string' ? src : TEX; });
  function create(o) {
    o = o || {};
    const cv = o.canvas || document.createElement('canvas');
    const dprCap = o.dpr || 2;
    const params = Object.assign({}, DEF, o.params || {});
    const gl = cv.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power', premultipliedAlpha: true }); // the canvas has alpha (the fan lets the content underneath show through); fragment output is premultiplied
    const api = { canvas: cv, params, ok: !!gl, time: () => (performance.now() - T0) / 1000, loaded: () => false };
    if (!gl) { api.ready = Promise.reject(new Error('no webgl')); api.ready.catch(() => {}); api.setSize = api.setView = api.setSlopes = api.clearWater = api.setFan = api.clearFan = api.setChart = api.setChartAlpha = api.clearChart = api.start = api.stop = api.render = api.set = api.destroy = () => {}; api.glError = () => -1; return api; }
    const sh = (t, s) => { const h = gl.createShader(t); gl.shaderSource(h, s); gl.compileShader(h); if (!gl.getShaderParameter(h, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(h)); return h; };
    const pg = gl.createProgram(); gl.attachShader(pg, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pg, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pg);
    if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pg));
    gl.useProgram(pg);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pg, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = {}; ['uTex', 'uMask', 'uWater', 'uChart', 'uT', 'uCloudSpeed', 'uCloudPeriod', 'uSeaAmp', 'uSparkle', 'uShipDeg', 'uShipPeriod', 'uMoonPulse', 'uAspect', 'uWaterOn', 'uShade', 'uWaveBoost', 'uSScale', 'uRefrPx', 'uFanOn', 'uFanAd', 'uFanFade', 'uTipOn', 'uTipR', 'uChord', 'uChartOn', 'uChartA', 'uCloudDir', 'uWaveC', 'uViewOff', 'uViewScale', 'uRefr', 'uCss', 'uFanApex', 'uFanBack', 'uTipC'].forEach(n => { U[n] = gl.getUniformLocation(pg, n); });
    gl.uniform1i(U.uTex, 0); gl.uniform1i(U.uMask, 1); gl.uniform1i(U.uWater, 2); gl.uniform1i(U.uChart, 3); gl.uniform1f(U.uAspect, PW / PH);
    gl.uniform1f(U.uSScale, 1); gl.uniform1f(U.uRefrPx, 0); gl.uniform1f(U.uFanOn, 0); gl.uniform1f(U.uTipOn, 0); gl.uniform1f(U.uChartOn, 0); gl.uniform1f(U.uChartA, 0); gl.uniform2f(U.uCss, 1, 1);
    api.glError = () => { try { return gl.getError(); } catch (_) { return -2; } };
    gl.uniform2f(U.uViewOff, 0, 0); gl.uniform2f(U.uViewScale, 1, 1); gl.uniform1f(U.uWaterOn, 0); gl.uniform1f(U.uShade, 0.85); gl.uniform2f(U.uRefr, 0, 0);
    const mkTex = (unit, img, mip) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); if (mip) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); return t; };
    let loaded = false, raf = 0, dead = false, waterTex = null, waterW = 0, waterH = 0, chartTex = null, view = { x: 0, y: 0, w: 1, h: 1 };
    api.loaded = () => loaded;
    api.ready = Promise.all([loadImg(o.tex || TEX), loadImg(o.mask || MASK)]).then(([ti, mi]) => { if (dead) return; mkTex(0, ti, true); mkTex(1, mi, false); loaded = true; return api; });
    api.setSize = (w, h, dpr) => { const d = Math.min(dpr || dprCap, window.devicePixelRatio || 1); const pw = Math.max(1, Math.round(w * d)), ph = Math.max(1, Math.round(h * d)); if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; } gl.viewport(0, 0, pw, ph); };
    api.setView = (r) => { view = Object.assign({ x: 0, y: 0, w: 1, h: 1 }, r || {}); gl.uniform2f(U.uViewOff, view.x, view.y); gl.uniform2f(U.uViewScale, view.w, view.h); };
    api.view = () => view;
    // Slope field: bytes = Uint8Array of length w*h*2, one [dx, dy] byte pair per cell (128 = 0; square-root companded: byte = 128 + 127*sign(d)*sqrt(|d|/scale), with opt.scale the largest representable slope, so small slopes keep precision and large ones still fit). refr = refraction (css px per unit slope, times opt.grid cells -> css px), converted to painting uv: css px / (on-screen size of the painting = canvas css size / view.w|h). opt.edge = how far the fan edge is displaced by the water (css px per unit slope).
    api.setSlopes = (bytes, w, h, opt) => {
      if (!loaded || dead) return;
      opt = opt || {};
      gl.activeTexture(gl.TEXTURE2);
      if (!waterTex) { waterTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, waterTex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); } else gl.bindTexture(gl.TEXTURE_2D, waterTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (w !== waterW || h !== waterH) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, w, h, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, bytes); waterW = w; waterH = h; }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, bytes);
      gl.uniform1f(U.uSScale, opt.scale || 1); gl.uniform1f(U.uRefrPx, opt.edge == null ? 0 : opt.edge);
      const cssW = parseFloat(cv.style.width) || cv.width, cssH = parseFloat(cv.style.height) || cv.height;
      const pxPerUnit = (opt.refr == null ? 2.2 : opt.refr) * (opt.grid || 1); // css px of displacement per unit of slope
      gl.uniform1f(U.uWaterOn, 1); gl.uniform1f(U.uShade, opt.shade == null ? 0.85 : opt.shade); 
      gl.uniform2f(U.uRefr, pxPerUnit / (cssW / view.w), pxPerUnit / (cssH / view.h));
    };
    api.clearWater = () => { gl.uniform1f(U.uWaterOn, 0); gl.uniform1f(U.uRefrPx, 0); };
    // Article fan: everything in css px, origin at the canvas top-left; f = { ax, ay (apex), bx, by (unit vector pointing behind the boat), ad (half-angle, degrees), fade (soft edge, degrees), tip: { x, y, r, chord } | null (rounded apex: circle centre / radius / distance of the chord from the apex along the backward direction) }
    api.setFan = (f) => {
      const cssW = parseFloat(cv.style.width) || cv.width, cssH = parseFloat(cv.style.height) || cv.height;
      gl.uniform2f(U.uCss, cssW, cssH); gl.uniform1f(U.uFanOn, 1);
      gl.uniform2f(U.uFanApex, f.ax, f.ay); gl.uniform2f(U.uFanBack, f.bx, f.by); gl.uniform1f(U.uFanAd, f.ad * Math.PI / 180); gl.uniform1f(U.uFanFade, Math.max(0.01, f.fade) * Math.PI / 180);
      if (f.tip) { gl.uniform1f(U.uTipOn, 1); gl.uniform2f(U.uTipC, f.tip.x, f.tip.y); gl.uniform1f(U.uTipR, f.tip.r); gl.uniform1f(U.uChord, f.tip.chord); } else gl.uniform1f(U.uTipOn, 0);
    };
    api.clearFan = () => { gl.uniform1f(U.uFanOn, 0); gl.uniform1f(U.uTipOn, 0); };
    // Sea chart: upload a bitmap (a screen-sized canvas with alpha, e.g. a rasterised nf-chart.js mesh) as a texture overlaid in screen coordinates; its alpha is driven by setChartAlpha (fade-in)
    api.setChart = (src) => {
      if (dead || !src || !src.width) return;
      gl.activeTexture(gl.TEXTURE3);
      if (!chartTex) { chartTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, chartTex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); } else gl.bindTexture(gl.TEXTURE_2D, chartTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.uniform1f(U.uChartOn, 1);
    };
    api.setChartAlpha = (a) => { gl.uniform1f(U.uChartA, Math.max(0, Math.min(1, +a || 0))); };
    api.clearChart = () => { gl.uniform1f(U.uChartOn, 0); gl.uniform1f(U.uChartA, 0); };
    api.set = (p) => { Object.assign(params, p || {}); };
    api.render = (now) => {
      if (!loaded || dead) return false;
      const t = ((now == null ? performance.now() : now) - T0) / 1000;
      gl.uniform1f(U.uT, t); gl.uniform1f(U.uCloudSpeed, params.cloudSpeed); gl.uniform1f(U.uCloudPeriod, params.cloudPeriod); gl.uniform1f(U.uSeaAmp, params.seaAmp); gl.uniform1f(U.uSparkle, params.sparkle); gl.uniform1f(U.uShipDeg, params.shipDeg); gl.uniform1f(U.uShipPeriod, params.shipPeriod); gl.uniform1f(U.uMoonPulse, params.moonPulse); gl.uniform1f(U.uWaveBoost, params.waveBoost == null ? 0 : params.waveBoost); gl.uniform2f(U.uWaveC, params.waveX == null ? 0.19 : params.waveX, params.waveY == null ? 0.72 : params.waveY);
      const dx = params.cloudDirX, dy = params.cloudDirY, dl = Math.hypot(dx, dy) || 1; gl.uniform2f(U.uCloudDir, dx / dl, dy / dl);
      gl.drawArrays(gl.TRIANGLES, 0, 3); return true;
    };
    const tick = (now) => { raf = 0; if (dead) return; api.render(now); raf = requestAnimationFrame(tick); };
    api.start = () => { if (!raf && !dead) raf = requestAnimationFrame(tick); };
    api.stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
    api.running = () => !!raf;
    api.destroy = () => { api.stop(); dead = true; try { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (_) {} };
    return api;
  }
  window.nfLive = { create, DEF, TEX, MASK, PW, PH };
})();
