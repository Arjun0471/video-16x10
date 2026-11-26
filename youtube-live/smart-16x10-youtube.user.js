// ==UserScript==
// @name         Smart 16:10 for YouTube
// @version      2.13.0
// @description  Smart 16:9 -> 16:10 for YouTube: learns facecams/HUD and draws them at true size as separate layers; the content underneath is cropped (squeeze only as a small last resort). Alt+Z toggles, Alt+Shift+Z debug.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://www.youtube-nocookie.com/embed/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
// Smart 16:10 for YouTube — live content-aware pixel removal.
//
// When the player is taller than the video (e.g. a 16:9 video fullscreen on a
// 16:10 display), the video would be letterboxed. Instead, this script removes
// ~10% of the frame's width *where it matters least*: every frame is analysed
// for detail and motion, low-importance columns (sky, walls, flat backgrounds)
// are squeezed, and important columns (people, faces, text, action) keep their
// true proportions. The result is drawn with WebGL, fills the whole player, and
// nothing is cropped away.
//
// The squeeze map is smoothed over space and time so nothing wobbles, and it
// snaps on shot cuts so each shot gets its own layout.
//
// Keys:  Alt+Z        toggle on/off
//        Alt+Shift+Z  debug readout + squeeze map
(() => {
  'use strict';
  if (window.__smart1610) return;

  const VERSION = '2.13.0';
  const CFG = {
    aw: 160,           // analysis columns
    cropAccept: 0.2,    // crop unless it would cut > 20% of the frame's important content
    maxSqueezeShare: 0.3, // ...in which case at most 30% of the removal (3 of 10%) is even squeeze
    hudMinShare: 0.02,  // HUD on an edge = >= 2% of the outer band learned as overlay
    hudHoldMs: 10000,   // keep the HUD crop+squeeze mode this long after last seen
    textBand: 0.12,     // chat/text detection looks at the outer 12% of each side
    textBandW: 160, textBandH: 360, // ...read at this resolution (~1.5 source px per px at 1080p)
    textBright: 150,    // glyph stroke brightness
    textContrast: 70,   // ...and how much darker its shadow/outline must be
    textMinRuns: 3,     // a text row has at least this many separate strokes
    textEdgeStart: 0.12, // ...starting within this share of the strip from the frame edge (chat hugs the edge)
    textRowsOn: 6,      // this many text rows (about one line) = chat present
    textRowsKnown: 3,   // ...or this many where chat has been seen before
    textMemRate: 0.01,  // how quickly the remembered chat location adapts
    textReleaseMs: 1500, // protection drops this long after the text is gone (bridges message bursts)
    textTau: 0.3,       // s, easing of the crop when chat appears / disappears
    camTau: 0.4,        // s, smoothing of the camera-motion score
    camWindowMs: 300,   // compare against the frame this far back
    settleMs: 1000,     // new shot: layout settles fast while it is classified
    settleTau: 0.15,    // s, easing during that settle period
    camOn: 0.35,        // share of changing pixels that means "camera moving"
    camOff: 0.2,        // ...and drops back to "still" below this
    camHoldMs: 3000,    // ...but only after no motion for this long
    ovCell: 4,          // overlay grid cell (analysis px)
    ovWindowMs: 1000,   // stillness = unchanged vs this long ago
    learnMinChange: 0.25, // learn only from moments where >= 25% of the frame changes
    learnStill: 10,     // pixel counts as still if it moved < 10 luma levels (stream compression noise)
    learnGrad: 8,       // ...and has visible structure (edge strength >= 8)
    learnRatio: 0.7,    // overlay = still in >= 70% of moving moments (long-term memory)...
    learnRatioFast: 0.75, // ...or >= 75% in the short-term memory (new layouts, ~8 s)
    learnRatioWeak: 0.45, // weaker evidence that may extend (not start) an overlay region...
    weakReach: 6,       // ...but only this many px (learn grid) beyond strong evidence
    learnMinFrames: 20, // need this many moving moments before trusting the map
    learnHalfLife: 20,  // s of motion: long-term memory (layout switches fade out)
    learnHalfLifeFast: 4, // s of motion: short-term memory (a new facecam is picked up quickly)
    learnSaveCap: 300,  // cap stored evidence so a changed layout is relearned
    learnVideos: 8,     // remember this many videos' maps
    ovMinCells: 3,      // ignore specks smaller than this many cells
    ovMaxRects: 8,      // overlay layers drawn at true size
    ovMinPix: 40,       // ignore learned specks smaller than this (learn-grid px)
    ovMaxArea: 0.18,    // ...and anything covering more than 18% of the frame
    ovMinArea: 0.03,    // layers only for substantial overlays (facecams, panels)
    ovEdgeStill: 0.35,  // each stretch of an overlay's inner edges must be still >= 35% of the time
    ovOutsideStill: 0.65, // ...while just outside them it must be still <= 65% of the time (moving content)
    ovEdgeBand: 0.1,    // only overlays reaching into the outer 10% at either side get a layer
    ovMatchNcc: 0.6,    // an overlay is on screen if its pattern correlates >= 0.6 with its template
    ovMatchDiff: 25,    // ...and its pixels are within 25 levels of it (median)
    ovMatchFrames: 5,   // ...for this many checks in a row (every other frame)
    ovSearch: 8,        // if it stops matching, look this far (learn-grid px) for it
    ovConfirmMs: 1000,  // a new overlay must persist this long before it is drawn
    ovNewAfterCut: 30,  // after a cut, wait for this many moving moments before creating overlays
    ovRelearnMoments: 90, // an overlay that went off may be relearned after this much motion
    ovStaticShare: 0.35, // if more of the frame than this looks still, it's a static shot
    ovGapCells: 3,      // bridge gaps / reach the edge within this many cells
    kMin: 0.7,          // residual warp: never squeeze a column more than ~1.4x
    uniformMix: 0.3,    // blend residual warp toward uniform (limits bending)
    spatialSigma: 10,   // columns, keeps any squeeze broad and gradual
    profileTau: 1.2,    // s, smoothing of importance over time
    mapTau: 1.0,        // s, how quickly the layout follows changes mid-shot
    asymCost: 0.04,     // a fully one-sided trim must save >= 4% of importance
    deadCols: 3,        // layout ignores trim changes smaller than ~2% of width
    deadK: 0.08,        // ...and warp changes smaller than this
    cutDist: 0.55,      // colour-histogram L1 distance that counts as a cut
    maxFill: 1.5,       // do nothing if more than 33% would have to go
    mapN: 512,          // samples in the output -> source lookup
  };
  const store = {
    get(k, d) { try { return localStorage.getItem('smart1610.' + k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('smart1610.' + k, v); } catch { /* ignore */ } },
  };
  let enabled = store.get('enabled', '1') === '1';
  let debug = false;

  const style = document.createElement('style');
  style.textContent = `
    .smart1610-gl { position: absolute; left: 0; top: 0; width: 100%; height: 100%;
      pointer-events: none; display: none; background: #000; }
    .smart1610-gl.show { display: block; }
    .smart1610-toast, .smart1610-debug {
      position: absolute; z-index: 9999; pointer-events: none; color: #fff;
      background: rgba(0,0,0,.7); border-radius: 6px; padding: 6px 12px;
    }
    .smart1610-toast { top: 16px; left: 50%; transform: translateX(-50%);
      font: 500 14px/1.3 Roboto, Arial, sans-serif; opacity: 0; transition: opacity .25s; }
    .smart1610-toast.show { opacity: 1; }
    .smart1610-debug { left: 12px; top: 12px; font: 12px/1.4 monospace; white-space: pre; }
    .smart1610-debug canvas { display: block; margin-top: 4px; width: 320px; height: 48px; }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ------------------------------------------------------------------ state
  let video = null, player = null, container = null, glCanvas = null, gl = null, prog = null;
  let vidTex = null, mapTex = null, U = {}, anaProg = null, anaSlots = {};
  let anaW = 0, anaH = 0, learnW = 320, learnH = 180, learnTick = 0, learnAcc = 0, lastOv = null, texW = 0, texH = 0, haveFrame = false;
  let toastEl = null, toastTimer = 0, dbgEl = null, dbgCanvas = null, dbgMini = null, frameHandle = 0;
  let prevY = null, prevHist = null, acc = null, prior = null, lastT = 0;
  let k = null, lay = null, held = null, warpMin = 1, camScore = 0.5, camMoving = true, camRef = [], shotT = 0, lastMoveT = 0,
      ovRef = [], ovPix = null, ovInf = 0, ovPixF = null, ovInfF = 0, ovStill = null, ovRects = [], ovMask = null, ovActive = [], lastCutT = -1e9, ovMoments = 0, ovDims = [0, 0], hudUntil = 0, ovMomentsAtCut = 0, textMem = {}, textLastY = {}, textProt = { L: false, R: false, flipT: -1e9 }, ovKey = null, ovSaveT = 0, ovCells = 0, ovInfo = null, protNow = null, snap = true, cuts = 0, fill = 1, ok = true, active = false;
  const map = new Float32Array(CFG.mapN);

  window.__smart1610 = {
    get state() {
      return { enabled, active, fill, cuts, ok, camMoving, camScore, ovCells, ovInf, ovInfo, text: { L: textProt.L, R: textProt.R, rowsL: textProt.rowsL, rowsR: textProt.rowsR }, hud: performance.now() < hudUntil, rects: ovRects.map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, present: r.present, confirmed: performance.now() - r.born >= CFG.ovConfirmMs })), prot: protNow ? Array.from(protNow) : null, maxSqueeze: 1 / warpMin, trimL: lay ? lay.L / CFG.aw : 0, trimR: lay ? lay.R / CFG.aw : 0,
               k: k ? Array.from(k) : null };
    },
    CFG,
    // learned-overlay ratio per analysis pixel (for diagnostics)
    lut() { return Array.from(map); },
    textBand(side) { const Y = textLastY[side]; return Y ? { w: CFG.textBandW, h: CFG.textBandH, y: Array.from(Y, (v) => Math.round(v)) } : null; },
    lastY() { return prevY ? { aw: CFG.aw, y: Array.from(prevY, (v) => Math.round(v)) } : null; },
    learnedMap() { return ovPix && ovInf ? { aw: ovDims[0], ratio: Array.from(ovPix, (v) => Math.round(100 * v / ovInf)) } : null; },
  };

  // ----------------------------------------------------------------- WebGL
  const VS = `#version 300 es
    in vec2 p; out vec2 uv;
    void main() { uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0, 1); }`;
  // Display shader: output x -> source x through the lookup, then a filter
  // matched to the local scale: Catmull-Rom bicubic when enlarging (sharp,
  // no bilinear mush) and an anti-aliased area filter when shrinking (no
  // jaggies/shimmer when a 4K stream plays on a smaller screen).
  const FS = `#version 300 es
    precision highp float;
    uniform sampler2D vid; uniform highp sampler2D lut; uniform int n; uniform vec2 texSize;
    uniform vec4 rects[8]; uniform float shifts[8]; uniform int nR; uniform float keep;
    in vec2 uv; out vec4 o;
    vec4 catmullRom(vec2 p) {
      vec2 sp = p * texSize, t1 = floor(sp - .5) + .5, f = sp - t1;
      vec2 w0 = f * (-.5 + f * (1. - .5 * f)), w1 = 1. + f * f * (-2.5 + 1.5 * f);
      vec2 w2 = f * (.5 + f * (2. - 1.5 * f)), w3 = f * f * (-.5 + .5 * f);
      vec2 w12 = w1 + w2;
      vec2 a = (t1 - 1.) / texSize, b = (t1 + w2 / w12) / texSize, c = (t1 + 2.) / texSize;
      vec4 r = texture(vid, vec2(a.x, a.y)) * w0.x * w0.y + texture(vid, vec2(b.x, a.y)) * w12.x * w0.y
             + texture(vid, vec2(c.x, a.y)) * w3.x * w0.y + texture(vid, vec2(a.x, b.y)) * w0.x * w12.y
             + texture(vid, vec2(b.x, b.y)) * w12.x * w12.y + texture(vid, vec2(c.x, b.y)) * w3.x * w12.y
             + texture(vid, vec2(a.x, c.y)) * w0.x * w3.y + texture(vid, vec2(b.x, c.y)) * w12.x * w3.y
             + texture(vid, vec2(c.x, c.y)) * w3.x * w3.y;
      return clamp(r, 0., 1.);
    }
    vec4 sampleAt(vec2 s, vec2 fp) {
      if (max(fp.x, fp.y) <= 1.0) return catmullRom(s);
      vec2 st = max(fp, vec2(1.)) / (3. * texSize);
      vec4 acc = vec4(0);
      for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) acc += texture(vid, s + vec2(x, y) * st);
      return acc / 9.;
    }
    void main() {
      float f = uv.x * float(n - 1);
      int i = int(floor(f));
      float a = texelFetch(lut, ivec2(i, 0), 0).r;
      float b = texelFetch(lut, ivec2(min(i + 1, n - 1), 0), 0).r;
      vec2 sg = vec2(mix(a, b, f - float(i)), uv.y);              // game layer
      float p = uv.x * keep;                                      // output x in source units
      vec2 fpG = vec2(abs(dFdx(sg.x)), abs(dFdy(sg.y))) * texSize;
      vec2 fpR = vec2(abs(dFdx(p)), abs(dFdy(uv.y))) * texSize;
      // The game layer must not show overlay pixels (they are drawn separately
      // at their new position): step out to the nearest game pixel beside them.
      for (int r = 0; r < 8; r++) {
        if (r >= nR) break;
        vec4 R = rects[r];
        if (sg.x >= R.x && sg.x < R.z && sg.y >= R.y && sg.y < R.w) {
          sg.x = (sg.x - R.x < R.z - sg.x) ? R.x - 1.5 / texSize.x : R.z + 1.5 / texSize.x;
          break;
        }
      }
      o = sampleAt(sg, fpG);
      // Overlay layers: drawn at true size, shifted to stay anchored to their edge;
      // inner borders fade into the game over a few pixels (frame-edge sides don't).
      for (int r = 0; r < 8; r++) {
        if (r >= nR) break;
        vec4 R = rects[r];
        float sx = p + shifts[r];
        if (sx >= R.x && sx < R.z && uv.y >= R.y && uv.y < R.w) {
          float bx = 0.011, by = 0.018, al = 1.;
          if (R.x > 0.001) al = min(al, (sx - R.x) / bx);
          if (R.z < 0.999) al = min(al, (R.z - sx) / bx);
          if (R.y > 0.001) al = min(al, (uv.y - R.y) / by);
          if (R.w < 0.999) al = min(al, (R.w - uv.y) / by);
          o = mix(o, sampleAt(vec2(sx, uv.y), fpR), clamp(al, 0., 1.));
          break;
        }
      }
    }`;
  // Analysis shader: box-filters the frame down to ~160 px wide on the GPU, so
  // only a few KB are read back per frame instead of a full 4K frame.
  const FS_ANA = `#version 300 es
    precision highp float;
    uniform sampler2D vid; uniform vec2 texSize; uniform vec2 outSize; uniform vec4 sub;
    out vec4 o;
    void main() {
      vec2 span = sub.zw - sub.xy;
      vec2 fp = span / outSize, base = sub.xy + (gl_FragCoord.xy - .5) / outSize * span;
      vec4 acc = vec4(0);
      for (int y = 0; y < 8; y++)
        for (int x = 0; x < 8; x++) acc += texture(vid, base + (vec2(x, y) + .5) / 8. * fp);
      o = acc / 64.;
    }`;

  function initGL() {
    gl = glCanvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) return false;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const link = (fs) => {
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(pr, 0, 'p');
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      return pr;
    };
    prog = link(FS);
    anaProg = link(FS_ANA);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (const [pr, names] of [[prog, ['vid', 'lut', 'n', 'texSize', 'rects[0]', 'shifts[0]', 'nR', 'keep']], [anaProg, ['vid', 'texSize', 'outSize', 'sub']]]) {
      U[pr === prog ? 'r' : 'a'] = Object.fromEntries(names.map((nm) => [nm, gl.getUniformLocation(pr, nm)]));
    }
    anaSlots = {};

    vidTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, vidTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    mapTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mapTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, CFG.mapN, 1, 0, gl.RED, gl.FLOAT, map);

    gl.useProgram(prog);
    gl.uniform1i(U.r.vid, 0);
    gl.uniform1i(U.r.lut, 1);
    gl.uniform1i(U.r.n, CFG.mapN);
    gl.useProgram(anaProg);
    gl.uniform1i(U.a.vid, 0);
    haveFrame = false;
    return true;
  }

  // Copy the current video frame to the GPU texture (once per new frame).
  function upload() {
    if (!gl || video.readyState < 2 || !video.videoWidth) return false;
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, vidTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (e) {
      fail('16:10: this video cannot be processed');
      return false;
    }
    texW = video.videoWidth; texH = video.videoHeight;
    haveFrame = true;
    return true;
  }

  // Downscale the uploaded frame on the GPU and read back the small result.
  // Two sizes: 'main' (160 px wide) for layout analysis, 'learn' (320 px) for
  // overlay learning, which needs finer detail (HUD text, button icons).
  function readAnalysis(aw, ah, name = 'main', sub = [0, 0, 1, 1]) {
    let sl = anaSlots[name];
    if (!sl) sl = anaSlots[name] = { tex: gl.createTexture(), fbo: gl.createFramebuffer(), w: 0, h: 0, buf: null };
    if (sl.w !== aw || sl.h !== ah) {
      sl.w = aw; sl.h = ah;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, sl.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, aw, ah, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sl.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sl.tex, 0);
      sl.buf = new Uint8Array(aw * ah * 4);
    }
    if (name === 'main') { anaW = aw; anaH = ah; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, sl.fbo);
    gl.viewport(0, 0, aw, ah);
    gl.useProgram(anaProg);
    gl.uniform2f(U.a.texSize, texW, texH);
    gl.uniform2f(U.a.outSize, aw, ah);
    gl.uniform4f(U.a.sub, sub[0], sub[1], sub[2], sub[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, aw, ah, gl.RGBA, gl.UNSIGNED_BYTE, sl.buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return sl.buf;
  }

  function render() {
    if (!gl || !active || !haveFrame) return;
    const dpr = window.devicePixelRatio || 1;
    const max = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const w = Math.min(max[0], Math.round(player.clientWidth * dpr));
    const h = Math.min(max[1], Math.round(player.clientHeight * dpr));
    if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.uniform2f(U.r.texSize, texW, texH);
    // Overlay layers (analysis px -> normalised), drawn at true size.
    const keep = 1 / fill, rv = new Float32Array(32), sv = new Float32Array(8);
    const list = (ovActive || []).slice(0, 8);
    // Where the game layer puts source column c (in source-width units).
    const outPos = (c) => {
      if (!k) return c * keep;
      let acc = 0;
      const ci = Math.min(k.length, Math.max(0, c * k.length)), whole = Math.floor(ci);
      for (let q = 0; q < whole; q++) acc += k[q];
      if (whole < k.length) acc += k[whole] * (ci - whole);
      return acc / k.length;
    };
    list.forEach((r, q) => {
      const x0 = r.x0 / learnW, x1 = r.x1 / learnW;
      rv.set([x0, r.y0 / learnH, x1, r.y1 / learnH], q * 4);
      // keep its distance to the nearer side edge
      sv[q] = (x0 + x1) / 2 < 0.5 ? 0 : 1 - keep;
    });
    gl.uniform4fv(U.r['rects[0]'], rv);
    gl.uniform1fv(U.r['shifts[0]'], sv);
    gl.uniform1i(U.r.nR, list.length);
    gl.uniform1f(U.r.keep, keep);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mapTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CFG.mapN, 1, gl.RED, gl.FLOAT, map);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, vidTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function fail(msg) {
    ok = false;
    toast(msg);
    setActive(false);
  }

  // --------------------------------------------------------------- attach
  function attach() {
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v || v === video) return;
    if (video && frameHandle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
    video = v;
    player = v.closest('.html5-video-player') || v.parentElement.parentElement || v.parentElement;
    if (getComputedStyle(player).position === 'static') player.style.position = 'relative';

    glCanvas?.remove();
    glCanvas = document.createElement('canvas');
    glCanvas.className = 'smart1610-gl';
    // Directly after the video's container: above the video, below the controls.
    container = v.closest('.html5-video-container') || v;
    container.parentNode.insertBefore(glCanvas, container.nextSibling);
    restack();
    ok = true;
    try { if (!initGL()) fail('16:10: WebGL2 not available'); } catch (e) { fail('16:10: WebGL error'); }

    toastEl?.remove();
    toastEl = document.createElement('div');
    toastEl.className = 'smart1610-toast';
    player.appendChild(toastEl);

    prevY = prevHist = acc = null; snap = true;
    video.addEventListener('loadeddata', () => { prevY = prevHist = acc = null; snap = true; });
    scheduleFrame();
  }

  // YouTube gives the video container a z-index, which would paint the raw
  // video over our canvas. Sit exactly one layer above it, which keeps us
  // below captions, overlays and controls.
  function restack() {
    if (!glCanvas || !container) return;
    let z = 0;
    for (const el of [container, video]) {
      const v = parseInt(getComputedStyle(el).zIndex, 10);
      if (!Number.isNaN(v)) z = Math.max(z, v);
    }
    const want = String(z + 1);
    if (glCanvas.style.zIndex !== want) glCanvas.style.zIndex = want;
  }

  function scheduleFrame() {
    if (!video || !video.requestVideoFrameCallback) return;
    const v = video;
    frameHandle = v.requestVideoFrameCallback(() => {
      if (v !== video) return;
      tick(true);
      scheduleFrame();
    });
  }

  // Each new video frame: analyse, update the squeeze map, draw.
  // Also re-checked on animation frames so resizes/pauses still render.
  let lastSize = '';
  function tick(newFrame) {
    if (!video || !player || !video.isConnected) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const pw = player.clientWidth, ph = player.clientHeight;
    fill = vw && vh && pw && ph ? (vw / vh) / (pw / ph) : 1;
    setActive(enabled && ok && fill > 1.01 && fill <= CFG.maxFill);
    if (!active) return;
    if (newFrame && upload()) analyze();
    if (!k) return;
    const size = pw + 'x' + ph;
    if (newFrame || size !== lastSize) { lastSize = size; render(); }
  }

  function setActive(on) {
    if (on === active) return;
    active = on;
    glCanvas?.classList.toggle('show', on);
    if (on) { snap = true; prevHist = null; }
  }

  // -------------------------------------------------------------- analysis
  function analyze() {
    if (video.readyState < 2 || !video.videoWidth) return;
    const aw = CFG.aw, ah = Math.max(8, Math.round(aw * video.videoHeight / video.videoWidth));
    if (!prior || prior.length !== aw || anaH !== ah) {
      prevY = prevHist = acc = null;
      prior = new Float32Array(aw);
      let s = 0;
      for (let x = 0; x < aw; x++) { prior[x] = Math.exp(-0.5 * ((x - aw / 2) / (aw * 0.3)) ** 2); s += prior[x]; }
      for (let x = 0; x < aw; x++) prior[x] /= s;
    }
    const data = readAnalysis(aw, ah);

    const n = aw * ah, Y = new Float32Array(n), hist = new Float32Array(64);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = data[j], g = data[j + 1], b = data[j + 2];
      Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)]++;
    }
    for (let q = 0; q < 64; q++) hist[q] /= n;
    let cut = !prevHist;
    if (prevHist) {
      let d = 0;
      for (let q = 0; q < 64; q++) d += Math.abs(hist[q] - prevHist[q]);
      cut = d > CFG.cutDist;
    }

    // Column importance: local detail (gradients) + motion + a mild centre prior.
    const edge = new Float32Array(aw), motion = new Float32Array(aw);
    const mask = ovMask && ovMask.length === n ? ovMask : null;
    const CS = CFG.ovCell, GW = Math.ceil(aw / CS), GH = Math.ceil(ah / CS);
    const cellE = new Float32Array(GW * GH);
    for (let y = 0; y < ah - 1; y++) {
      const row = y * aw, crow = ((y / CS) | 0) * GW;
      for (let x = 0; x < aw - 1; x++) {
        const i = row + x;
        const g = Math.abs(Y[i + 1] - Y[i]) + Math.abs(Y[i + aw] - Y[i]);
        if (!mask || !mask[i]) edge[x] += g;
        cellE[crow + ((x / CS) | 0)] += g;
      }
    }
    edge[aw - 1] = edge[aw - 2];
    if (prevY && !cut) {
      for (let y = 0; y < ah; y++) {
        const row = y * aw;
        for (let x = 0; x < aw; x++) {
          const d = Math.abs(Y[row + x] - prevY[row + x]);
          if (d > 18 && (!mask || !mask[row + x])) motion[x] += d;
        }
      }
    }
    // Camera motion is judged against a frame ~0.3 s back, so slow pans that
    // move < 1 px per frame at analysis resolution are still caught.
    const now = performance.now();
    if (cut || snap) camRef = [];
    camRef.push({ t: now, Y });
    while (camRef.length > 1 && now - camRef[1].t >= CFG.camWindowMs) camRef.shift();
    let movingFrac = null;
    if (now - camRef[0].t >= CFG.camWindowMs * 0.5) {
      const R0 = camRef[0].Y;
      let c = 0;
      for (let i = 0; i < n; i++) if (Math.abs(Y[i] - R0[i]) > 18) c++;
      movingFrac = c / n;
      // A pan/tilt shows up as a clear global shift of the column/row means,
      // even on smooth content where few pixels change much.
      if (globalShift(colMeans(Y, aw, ah), colMeans(R0, aw, ah)) ||
          globalShift(rowMeans(Y, aw, ah), rowMeans(R0, aw, ah))) movingFrac = 1;
    }
    let se = 0, sm = 0;
    for (let x = 0; x < aw; x++) { se += edge[x]; sm += motion[x]; }
    const prof = new Float32Array(aw);
    for (let x = 0; x < aw; x++) {
      prof[x] = (se ? 0.5 * edge[x] / se : 0) + (sm ? 0.5 * motion[x] / sm : 0) + 0.1 * prior[x];
    }

    const dt = lastT ? Math.min(1, (now - lastT) / 1000) : 0.04;
    lastT = now;
    if (!acc || cut || snap) acc = prof;
    else {
      const a = 1 - Math.exp(-dt / CFG.profileTau);
      for (let x = 0; x < aw; x++) acc[x] += (prof[x] - acc[x]) * a;
    }
    learnAcc += dt;
    if ((++learnTick & 1) === 0 || !lastOv) {
      const LW = aw * 2, LH = ah * 2, d2 = readAnalysis(LW, LH, 'learn'), n2 = LW * LH;
      const Y2 = new Float32Array(n2);
      for (let q = 0, j = 0; q < n2; q++, j += 4) Y2[q] = 0.299 * d2[j] + 0.587 * d2[j + 1] + 0.114 * d2[j + 2];
      lastOv = learnOverlays(Y2, LW, LH, now, learnAcc);
      learnAcc = 0; learnW = LW; learnH = LH;
    }
    if ((learnTick & 3) === 0) detectTextBands(now);
    // Overlay results are on the 320 px grid; the planner works on 160 columns.
    const sc = aw / learnW;
    const ov = { rects: lastOv.rects, hud: lastOv.hud, fixed: new Uint8Array(aw),
                 limL: Math.floor(lastOv.limL * sc), limR: Math.floor(lastOv.limR * sc) };
    for (let x = 0; x < aw; x++) ov.fixed[x] = lastOv.fixed[Math.min(learnW - 1, Math.floor(x / sc))];
    ovMask = new Uint8Array(n);
    for (const r of ov.rects) {
      const x0 = Math.floor(r.x0 * sc), x1 = Math.ceil(r.x1 * sc), y0 = Math.floor(r.y0 * sc), y1 = Math.ceil(r.y1 * sc);
      for (let y = y0; y < Math.min(ah, y1); y++) ovMask.fill(1, y * aw + x0, y * aw + Math.min(aw, x1));
    }
    protNow = ov.fixed; ovInfo = { limL: ov.limL, limR: ov.limR }; ovActive = ov.rects;
    // Camera motion: when most of the frame changes between frames, the camera
    // is moving (pan, walk). Any uneven warp would then make things change
    // width as they slide across the screen, so only trim + even squeeze.
    // New shots start as "moving" (safe) until proven still.
    if (cut || snap || prevY === null) { camScore = 0.5; camMoving = true; lastMoveT = now - CFG.camHoldMs; }
    else if (movingFrac !== null) {
      const a = 1 - Math.exp(-dt / CFG.camTau);
      camScore += (movingFrac - camScore) * a;
      // Sticky: after any motion, stay in "moving" for camHoldMs so the layout
      // doesn't flip back and forth (breathing) when motion comes and goes.
      if (camScore > CFG.camOn) { camMoving = true; lastMoveT = now; }
      else if (camMoving && camScore < CFG.camOff && now - lastMoveT > CFG.camHoldMs) camMoving = false;
    }
    prevY = Y; prevHist = hist;
    if (cut) { cuts++; lastCutT = now; ovMomentsAtCut = ovMoments; }

    // Chat/text on a side: crop the other side instead (eases over ~0.3 s).
    const ovPlan = Object.assign({}, ov, {
      limL: textProt.L && !textProt.R ? 0 : ov.limL,
      limR: textProt.R && !textProt.L ? 0 : ov.limR,
    });
    const fresh = planLayout(acc, 1 / fill, camMoving, ovPlan);
    if (!lay || lay.kw.length !== aw || cut || snap) {
      lay = fresh;
      held = { L: fresh.L, R: fresh.R, kw: fresh.kw.slice() };
      shotT = now;
    } else {
      // Dead band: only adopt a new layout when it differs substantially, so
      // constant camera motion (games, handheld) never makes the frame swim.
      let dk = 0;
      for (let x = 0; x < aw; x++) dk = Math.max(dk, Math.abs(fresh.kw[x] - held.kw[x]));
      if (Math.abs(fresh.L - held.L) > CFG.deadCols || Math.abs(fresh.R - held.R) > CFG.deadCols ||
          Math.abs(fresh.L + fresh.R - held.L - held.R) > 1 ||        // crop amount changed (e.g. HUD mode)
          dk > CFG.deadK) held = fresh;
      // Settle quickly while a new shot is still being classified (first
      // ~second); after that, changes ease in slowly.
      const tau = now - shotT < CFG.settleMs ? CFG.settleTau : now - textProt.flipT < 1000 ? CFG.textTau : CFG.mapTau;
      const a = 1 - Math.exp(-dt / tau);
      lay.L += (held.L - lay.L) * a;
      lay.R += (held.R - lay.R) * a;
      for (let x = 0; x < aw; x++) lay.kw[x] += (held.kw[x] - lay.kw[x]) * a;
    }
    // A crop into an overlay that can't be drawn ends immediately - unless the
    // limits block both sides, in which case the planner ignored them (no squeeze).
    const room = ov.limL + ov.limR >= (1 - 1 / fill) * aw * (1 - CFG.maxSqueezeShare);
    if (room && lay.L > ov.limL) { lay.L = ov.limL; held.L = Math.min(held.L, ov.limL); }
    if (room && lay.R > ov.limR) { lay.R = ov.limR; held.R = Math.min(held.R, ov.limR); }
    snap = false;
    k = combine(lay, 1 / fill);
    buildLookup(k, 1 / fill, lay);
    if (debug) drawDebug();
  }

  // ------------------------------------------------- learned overlay map
  // Overlays (facecam frames and labels, HUD buttons, task lists, logos) stay
  // pixel-identical for most of a video while everything around them changes.
  // For every analysis pixel we count how often it stays still (and has
  // visible structure) during moments when the rest of the frame is moving.
  // Pixels that are still in >= 85% of those moments are overlay. Evidence
  // builds up over the whole video (fading slowly so a changed layout is
  // relearned) and is remembered per video, so a 2-second banner can't
  // out-vote a facecam that has been there for ten minutes.
  function learnOverlays(Y, aw, ah, now, dt) {
    const n = aw * ah, CS = CFG.ovCell, GW = Math.ceil(aw / CS), GH = Math.ceil(ah / CS);
    ensureMemory(aw, ah);
    const res = { fixed: new Uint8Array(aw), limL: aw, limR: aw, rects: [], hud: now < hudUntil };
    ovRef.push({ t: now, Y });
    while (ovRef.length > 1 && now - ovRef[1].t >= CFG.ovWindowMs) ovRef.shift();
    const R0 = ovRef[0].Y;
    if (now - ovRef[0].t >= CFG.ovWindowMs * 0.5 && R0.length === n) {
      let changed = 0;
      for (let i = 0; i < n; i++) if (Math.abs(Y[i] - R0[i]) > 6) changed++;
      if (changed / n >= CFG.learnMinChange) {
        const dec = Math.pow(0.5, dt / CFG.learnHalfLife);
        const decF = Math.pow(0.5, dt / CFG.learnHalfLifeFast);
        ovInf = ovInf * dec + 1;
        ovInfF = ovInfF * decF + 1;
        ovMoments++;
        for (let y = 0; y < ah - 1; y++) {
          const row = y * aw;
          for (let x = 0; x < aw - 1; x++) {
            const i = row + x;
            const g = Math.abs(Y[i + 1] - Y[i]) + Math.abs(Y[i + aw] - Y[i]);
            const gr = Math.abs(R0[i + 1] - R0[i]) + Math.abs(R0[i + aw] - R0[i]);
            const ev = Math.abs(Y[i] - R0[i]) < CFG.learnStill && (g >= CFG.learnGrad || gr >= CFG.learnGrad);
            ovPix[i] = ovPix[i] * dec + (ev ? 1 : 0);
            ovPixF[i] = ovPixF[i] * decF + (ev ? 1 : 0);
            ovStill[i] = ovStill[i] * dec + (Math.abs(Y[i] - R0[i]) < CFG.learnStill ? 1 : 0);   // plain stillness
          }
        }
      }
    }
    if (now - ovSaveT > 5000) { ovSaveT = now; saveMemory(); }
    if (ovInf < CFG.learnMinFrames) { ovCells = 0; ovRects = []; return res; }

    // Learned pixels -> cells -> connected groups -> column spans.
    const cnt = new Uint16Array(GW * GH), thr = CFG.learnRatio * ovInf;
    const thrF = ovInfF >= CFG.learnMinFrames ? CFG.learnRatioFast * ovInfF : Infinity;
    for (let y = 0; y < ah; y++) {
      const row = y * aw, crow = ((y / CS) | 0) * GW;
      for (let x = 0; x < aw; x++) {
        const i = row + x;
        if (ovPix[i] >= thr || ovPixF[i] >= thrF) cnt[crow + ((x / CS) | 0)]++;
      }
    }
    const flag = new Uint8Array(GW * GH);
    let nCells = 0;
    for (let c = 0; c < flag.length; c++) if (cnt[c] >= 2) { flag[c] = 1; nCells++; }
    ovCells = nCells;
    const isL = (q) => ovPix[q] >= thr || ovPixF[q] >= thrF;
    // HUD on both edges? Count strongly learned pixels in the outer bands.
    {
      const band = Math.round(CFG.ovEdgeBand * aw);
      let cl = 0, cr = 0;
      for (let y = 0; y < ah; y++) {
        const row = y * aw;
        for (let x = 0; x < band; x++) if (isL(row + x)) cl++;
        for (let x = aw - band; x < aw; x++) if (isL(row + x)) cr++;
      }
      const need = CFG.hudMinShare * band * ah;
      if (cl >= need && cr >= need) hudUntil = now + CFG.hudHoldMs;
    }
    res.hud = now < hudUntil;
    // Learned pixels -> groups (pixels within 2 px are connected; groups whose
    // rectangles touch are merged, keeping a facecam's frame, face and label
    // together while separate HUD pieces stay separate) -> tight rectangles.
    // Weak evidence (still in >= 40% of moving moments) can extend a group but
    // never start one: semi-transparent panels like a task list only reach
    // ~50-70% because the game shows through, while moving game stays < ~30%.
    const thrW = CFG.learnRatioWeak * ovInf, thrWF = ovInfF >= CFG.learnMinFrames ? CFG.learnRatioWeak * ovInfF : Infinity;
    const isW = (q) => ovPix[q] >= thrW || ovPixF[q] >= thrWF;
    const lab = new Int32Array(n).fill(-1), dist = new Uint8Array(n), stack = [];
    let comps = [];
    for (let q0 = 0; q0 < n; q0++) {
      if (lab[q0] >= 0 || !isL(q0)) continue;
      const id = comps.length, pix = [];
      let x0 = aw, x1 = -1, y0 = ah, y1 = -1;
      lab[q0] = id; stack.push(q0); dist[q0] = 0;
      while (stack.length) {
        const q = stack.pop(), qx = q % aw, qy = (q / aw) | 0;
        pix.push(q);
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const nx = qx + dx, ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= aw || ny >= ah) continue;
          const nq = ny * aw + nx;
          if (lab[nq] >= 0) continue;
          const nd = isL(nq) ? 0 : dist[q] + 1;          // weak pixels reach only so far
          if (nd === 0 || (nd <= CFG.weakReach && isW(nq))) { lab[nq] = id; dist[nq] = nd; stack.push(nq); }
        }
      }
      comps.push({ x0, y0, x1, y1, pix });
    }
    comps = comps.filter((c) => c.pix.length >= CFG.ovMinPix);
    for (let merged = true; merged;) {
      merged = false;
      for (let a = 0; a < comps.length && !merged; a++) for (let b = a + 1; b < comps.length && !merged; b++) {
        const A = comps[a], B = comps[b];
        if (A.x0 <= B.x1 + 1 && B.x0 <= A.x1 + 1 && A.y0 <= B.y1 + 1 && B.y0 <= A.y1 + 1) {
          comps[a] = { x0: Math.min(A.x0, B.x0), y0: Math.min(A.y0, B.y0), x1: Math.max(A.x1, B.x1),
                       y1: Math.max(A.y1, B.y1), pix: A.pix.concat(B.pix) };
          comps.splice(b, 1); merged = true;
        }
      }
    }
    const found = [];
    for (const cmp of comps) {
      let { x0, y0, x1, y1 } = cmp;
      const pix = cmp.pix;
      // Shrink each side while its outer row/column holds little overlay, so the
      // rectangle hugs e.g. a facecam frame instead of the game around it.
      const RW = x1 - x0 + 1, inR = new Uint8Array(RW * (y1 - y0 + 1));
      for (const q of pix) inR[(((q / aw) | 0) - y0) * RW + (q % aw - x0)] = 1;
      const rowC = (y) => { let c = 0; for (let x = x0; x <= x1; x++) c += inR[(y - cmp.y0) * RW + x - cmp.x0]; return c; };
      const colC = (x) => { let c = 0; for (let y = y0; y <= y1; y++) c += inR[(y - cmp.y0) * RW + x - cmp.x0]; return c; };
      let maxRow = 0, maxCol = 0;
      for (let y = y0; y <= y1; y++) maxRow = Math.max(maxRow, rowC(y));
      for (let x = x0; x <= x1; x++) maxCol = Math.max(maxCol, colC(x));
      while (y1 > y0 && rowC(y0) < 0.1 * maxRow) y0++;
      while (y1 > y0 && rowC(y1) < 0.1 * maxRow) y1--;
      while (x1 > x0 && colC(x0) < 0.1 * maxCol) x0++;
      while (x1 > x0 && colC(x1) < 0.1 * maxCol) x1--;
      // small margin so a boundary never runs through the edge of text/borders
      x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(aw - 1, x1 + 1); y1 = Math.min(ah - 1, y1 + 1);
      if (x0 <= 4) x0 = 0; if (aw - 1 - x1 <= 4) x1 = aw - 1;    // flush with an edge
      if (y0 <= 4) y0 = 0; if (ah - 1 - y1 <= 4) y1 = ah - 1;
      const ar = (x1 + 1 - x0) * (y1 + 1 - y0);
      if (ar > CFG.ovMaxArea * aw * ah) continue;      // too big to be an overlay
      if (ar < CFG.ovMinArea * aw * ah) continue;      // small HUD bits: partial layers do more harm than good
      // Only overlays reaching into the outer band (where the crop cuts) need a
      // layer; anything further in is never cut, and drawing it only risks seams.
      if (x0 > CFG.ovEdgeBand * aw && x1 < (1 - CFG.ovEdgeBand) * aw) continue;
      // A real overlay's inner edges are static (frame border, panel edge, label).
      // If any stretch of an inner edge runs through moving content (e.g. the
      // still background of a camera feed, cut off at the person's face),
      // drawing it as a layer would split that content, so skip it.
      if (!edgesStill(x0, y0, x1, y1, aw, ah)) continue;
      found.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, pix: pix.filter(isL) });   // template from strong pixels only
    }
    found.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
    let fastN = 0;
    if (thrF !== Infinity) for (let q = 0; q < n; q++) if (ovPixF[q] >= thrF) fastN++;
    const relearnOK = fastN / n <= CFG.ovStaticShare;      // not a static shot
    trackRects(found.slice(0, CFG.ovMaxRects * 2), Y, now, (pix) => {
      if (!relearnOK || thrF === Infinity) return false;
      let c = 0;
      for (const q of pix) if (ovPixF[q] >= thrF) c++;
      return c >= 0.5 * pix.length;
    });
    // Is each overlay on screen right now? Correlate its pattern with its
    // template: survives quality switches and brightness changes, fails clearly
    // when different content sits there (cut to a full-screen camera, etc.).
    const score = (r, dx, dy) => {
      const m = r.tIdx.length;
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      const dd = new Float32Array(m);
      for (let q = 0; q < m; q++) {
        const ix = r.tIdx[q] % aw + dx, iy = ((r.tIdx[q] / aw) | 0) + dy;
        if (ix < 0 || iy < 0 || ix >= aw || iy >= ah) return { ok: false, ncc: -1 };
        const a = Y[iy * aw + ix], b = r.tVal[q];
        sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; dd[q] = Math.abs(a - b);
      }
      const va = saa - sa * sa / (m || 1), vb = sbb - sb * sb / (m || 1);
      const ncc = va > 1 && vb > 1 ? (sab - sa * sb / m) / Math.sqrt(va * vb) : 0;
      dd.sort();
      return { ok: m > 0 && ncc >= CFG.ovMatchNcc && dd[m >> 1] < CFG.ovMatchDiff, ncc };
    };
    for (const r of ovRects) {
      let match = score(r, 0, 0).ok;
      if (!match && r.present) {
        // Moved a little (re-framed after a cut, slight zoom)? Search nearby and follow.
        let best = null;
        for (let dy = -CFG.ovSearch; dy <= CFG.ovSearch; dy++) for (let dx = -CFG.ovSearch; dx <= CFG.ovSearch; dx++) {
          if (!dx && !dy) continue;
          const sc = score(r, dx, dy);
          if (sc.ok && (!best || sc.ncc > best.ncc)) best = { dx, dy, ncc: sc.ncc };
        }
        if (best) {
          const flushL = r.x0 === 0, flushR = r.x1 >= aw, flushT = r.y0 === 0, flushB = r.y1 >= ah;
          r.x0 = flushL ? 0 : Math.max(0, r.x0 + best.dx); r.x1 = flushR ? aw : Math.min(aw, r.x1 + best.dx);
          r.y0 = flushT ? 0 : Math.max(0, r.y0 + best.dy); r.y1 = flushB ? ah : Math.min(ah, r.y1 + best.dy);
          r.tIdx = r.tIdx.map((q) => q + best.dy * aw + best.dx);
          match = true;
        }
      }
      if (match !== r.present) {
        if (++r.run >= CFG.ovMatchFrames) {
          r.present = match; r.run = 0;
          // Gone at a cut = the layout changed; gone without one = probably a zoom
          // or quality change, so the overlay is likely still roughly there.
          if (!match) { r.offAtCut = now - lastCutT < 700; r.offMoments = ovMoments; }
        }
      }
      else r.run = 0;
      if (r.present && match) for (let q = 0; q < r.tIdx.length; q++) r.tVal[q] += (Y[r.tIdx[q]] - r.tVal[q]) * 0.02;
    }
    res.rects = ovRects.filter((r) => r.present && now - r.born >= CFG.ovConfirmMs).slice(0, CFG.ovMaxRects);
    return res;
  }

  // ------------------------------------------------- chat / text on a side
  // Chat windows (game chat, stream chat, kill feeds) change constantly, so the
  // stillness learner can't lock onto them. Instead: look for rows of text
  // (bright glyph strokes with a dark shadow/outline, several separate strokes
  // per row) in a strip along each side edge, read at higher resolution.
  // Where text has appeared before is remembered (row memory per side), so a
  // single new line there is enough; when the text goes, protection drops
  // after a moment and the crop recentres.
  function detectTextBands(now) {
    const BW = CFG.textBandW, BH = CFG.textBandH, band = CFG.textBand, want = {};
    for (const side of ['L', 'R']) {
      const sub = side === 'L' ? [0, 0, band, 1] : [1 - band, 0, 1, 1];
      const d = readAnalysis(BW, BH, 'text' + side, sub);
      const Y = new Float32Array(BW * BH);
      for (let q = 0, j = 0; q < BW * BH; q++, j += 4) Y[q] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      textLastY[side] = Y;
      if (!textMem[side] || textMem[side].length !== BH) textMem[side] = new Float32Array(BH);
      const mem = textMem[side];
      let rowsNow = 0, rowsKnown = 0;
      for (let y = 0; y < BH - 2; y++) {
        let runs = 0, inRun = false, nearEdge = false;
        for (let x = 0; x < BW - 2; x++) {
          const q = y * BW + x, v = Y[q];
          const lo = Math.min(Y[q + 1], Y[q + BW], Y[q + BW + 1], Y[q + 2 * BW + 2], Y[q + 2]);
          const tp = v > CFG.textBright && v - lo > CFG.textContrast;
          if (tp && !inRun) {
            runs++;
            const xe = side === 'L' ? x : BW - 1 - x;      // distance from the frame edge
            if (xe < BW * CFG.textEdgeStart) nearEdge = true;
          }
          inRun = tp;
        }
        // In this strip, a text row reads from the frame edge (row coordinates
        // are bottom-up from readPixels; only consistency matters here).
        const isText = runs >= CFG.textMinRuns && nearEdge;
        mem[y] += ((isText ? 1 : 0) - mem[y]) * CFG.textMemRate;
        if (isText) { rowsNow++; if (mem[y] > 0.05) rowsKnown++; }
      }
      const on = rowsNow >= CFG.textRowsOn || (rowsKnown >= CFG.textRowsKnown);
      if (on) textProt['seen' + side] = now;
      want[side] = on || now - (textProt['seen' + side] || 0) < CFG.textReleaseMs;
      textProt['rows' + side] = rowsNow;
      textProt['known' + side] = mem.reduce((a, v) => a + v, 0);
    }
    // Both sides look like text: the side where text keeps appearing (chat has a
    // fixed home; in-game name tags wander) wins; if neither stands out, neither.
    if (want.L && want.R) {
      const kl = textProt.knownL, kr = textProt.knownR;
      if (kl > 1.5 * kr) want.R = false; else if (kr > 1.5 * kl) want.L = false;
    }
    for (const side of ['L', 'R']) {
      if (want[side] !== textProt[side]) { textProt[side] = want[side]; textProt.flipT = now; }
    }
  }

  // Stillness ratio of a learn-grid pixel (best of long- and short-term memory).
  function stillRatio(q) {
    return ovInf > 0 ? ovStill[q] / ovInf : 0;      // plain stillness (flat borders count too)
  }
  // Every stretch (1/8) of every inner rectangle edge must be mostly still,
  // looking a couple of pixels either side of the line.
  function edgesStill(x0, y0, x1, y1, aw, ah) {
    // Moving content at the ends of an edge is fine (corner of a facecam whose
    // label is narrower than its frame); moving content in the middle of an edge
    // means the rectangle cuts through something (e.g. a face) - reject.
    const check = (len, at) => {
      const seg = Math.max(1, Math.floor(len / 8)), ok = [];
      for (let s0 = 0; s0 < len; s0 += seg) {
        let sum = 0, c = 0;
        for (let t = s0; t < Math.min(len, s0 + seg); t++) { sum += at(t); c++; }
        ok.push(sum / c >= CFG.ovEdgeStill);
      }
      const first = ok.indexOf(true), last = ok.lastIndexOf(true);
      if (first < 0) return false;                     // the whole edge is moving
      for (let q = first; q <= last; q++) if (!ok[q]) return false;
      return true;
    };
    const across = (x, y, horiz) => {               // max stillness across the line
      let m = 0;
      for (let d = -2; d <= 2; d++) {
        const xx = horiz ? x : Math.min(aw - 1, Math.max(0, x + d));
        const yy = horiz ? Math.min(ah - 1, Math.max(0, y + d)) : y;
        m = Math.max(m, stillRatio(yy * aw + xx));
      }
      return m;
    };
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    // ...and what lies just outside each inner edge must actually be moving:
    // an overlay is still content on top of moving content. A still region next
    // to more still content (a paused screen share) is not an overlay.
    const outsideMoving = (len, at) => {
      let sum = 0, c = 0;
      for (let t = 0; t < len; t++) for (let d = 3; d <= 6; d++) { const v = at(t, d); if (v >= 0) { sum += v; c++; } }
      return c === 0 || sum / c <= CFG.ovOutsideStill;
    };
    const px = (x, y) => (x < 0 || y < 0 || x >= aw || y >= ah ? -1 : stillRatio(y * aw + x));
    if (y0 > 0 && !outsideMoving(w, (t, d) => px(x0 + t, y0 - d))) return false;
    if (y1 < ah - 1 && !outsideMoving(w, (t, d) => px(x0 + t, y1 + d))) return false;
    if (x0 > 0 && !outsideMoving(h, (t, d) => px(x0 - d, y0 + t))) return false;
    if (x1 < aw - 1 && !outsideMoving(h, (t, d) => px(x1 + d, y0 + t))) return false;
    if (y0 > 0 && !check(w, (t) => across(x0 + t, y0, true))) return false;
    if (y1 < ah - 1 && !check(w, (t) => across(x0 + t, y1, true))) return false;
    if (x0 > 0 && !check(h, (t) => across(x0, y0 + t, false))) return false;
    if (x1 < aw - 1 && !check(h, (t) => across(x1, y0 + t, false))) return false;
    return true;
  }

  // Overlay tracks persist across frames so a rectangle doesn't jump around as
  // the learned map wobbles: new overlays must last ovConfirmMs before they're
  // drawn, a rectangle grows after 1 s of consistent evidence but only shrinks
  // after 4 s, and a track is dropped after 3 s without evidence.
  function trackRects(found, Y, now, fastSupported) {
    const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
    const inter = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
                            Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const same = (a, b) => Math.abs(a.x0 - b.x0) <= 4 && Math.abs(a.x1 - b.x1) <= 4 &&
                           Math.abs(a.y0 - b.y0) <= 4 && Math.abs(a.y1 - b.y1) <= 4;
    const template = (t, pix) => {
      const step = Math.max(1, Math.floor(pix.length / 256)), idx = [], val = [];
      for (let q = 0; q < pix.length; q += step) { idx.push(pix[q]); val.push(Y[pix[q]]); }
      t.tIdx = idx; t.tVal = Float32Array.from(val);
    };
    // After a cut, the learned map still describes the previous content until
    // new motion has been seen; don't create or re-template overlays from it yet
    // (e.g. a cut to a static screen share would get a 'template' of itself).
    const fresh = ovMoments - ovMomentsAtCut >= CFG.ovNewAfterCut;
    const used = new Set();
    for (const f of found) {
      const t = ovRects.find((o) => !used.has(o) && inter(o, f) > 0.5 * Math.min(area(o), area(f)));
      if (!t) {
        if (!fresh) continue;
        const nt = { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, born: now, seen: now, present: true, run: 0, cand: null };
        template(nt, f.pix);
        ovRects.push(nt); used.add(nt);
        continue;
      }
      used.add(t); t.seen = now;
      // Off but relearned nearby (e.g. the edit cut to a slightly different
      // framing): adopt the new position and appearance.
      if (fresh && !t.present && ovMoments - (t.offMoments || 0) >= CFG.ovRelearnMoments && fastSupported(f.pix)) {
        Object.assign(t, { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1, present: true, run: 0, offAtCut: false, cand: null });
        template(t, f.pix);
        continue;
      }
      if (same(t, f)) { t.cand = null; continue; }
      if (!t.cand || !same(t.cand.g, f)) t.cand = { g: f, since: now };
      if (fresh && now - t.cand.since >= (area(f) >= area(t) ? 1000 : 4000)) {
        Object.assign(t, { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 });
        template(t, f.pix);
        t.cand = null;
      }
    }
    ovRects = ovRects.filter((t) => now - t.seen < 3000);
    // drop tracks mostly covered by an older/larger one
    ovRects.sort((a, b) => area(b) - area(a));
    ovRects = ovRects.filter((t, q) => !ovRects.slice(0, q).some((o) => inter(o, t) > 0.6 * area(t)));
  }

  // ---- per-video memory of the learned map (browser storage, LRU)
  function videoKey() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('v') || (u.pathname.match(/\/(shorts|embed|live)\/([\w-]+)/) || [])[2] || null;
    } catch { return null; }
  }
  function loadMaps() {
    try { return JSON.parse(localStorage.getItem('smart1610.ovmaps')) || { order: [], maps: {} }; }
    catch { return { order: [], maps: {} }; }
  }
  function ensureMemory(aw, ah) {
    const key = videoKey(), n = aw * ah;
    ovDims = [aw, ah];
    if (ovPix && ovPix.length === n && key === ovKey) return;
    if (ovPix) saveMemory();
    ovKey = key; ovPix = new Float32Array(n); ovInf = 0; ovPixF = new Float32Array(n); ovInfF = 0; ovStill = new Float32Array(n); ovRef = []; ovRects = []; ovMask = null;
    const m = key && loadMaps().maps[key];
    if (m && m.aw === aw && m.ah === ah) {
      try {
        const bin = atob(m.r);
        ovInf = m.inf;
        for (let i = 0; i < n; i++) ovPix[i] = (bin.charCodeAt(i) / 255) * ovInf;
        ovPixF.set(ovPix); ovInfF = ovInf; ovStill.set(ovPix);
      } catch { ovPix.fill(0); ovInf = 0; }
    }
  }
  function saveMemory() {
    if (!ovKey || !ovPix || ovInf < CFG.learnMinFrames) return;
    try {
      const inf = Math.min(ovInf, CFG.learnSaveCap), n = ovPix.length;
      let bin = '';
      for (let i = 0; i < n; i += 4096) {
        const chunk = new Uint8Array(Math.min(4096, n - i));
        for (let j = 0; j < chunk.length; j++) chunk[j] = Math.round(Math.min(1, ovPix[i + j] / ovInf) * 255);
        bin += String.fromCharCode.apply(null, chunk);
      }
      const all = loadMaps();
      all.maps[ovKey] = { aw: ovDims[0], ah: ovDims[1], inf, r: btoa(bin) };
      all.order = all.order.filter((k2) => k2 !== ovKey).concat(ovKey);
      while (all.order.length > CFG.learnVideos) delete all.maps[all.order.shift()];
      localStorage.setItem('smart1610.ovmaps', JSON.stringify(all));
    } catch { /* storage full or blocked: learning still works for this session */ }
  }
  window.addEventListener('pagehide', () => saveMemory());

  function colMeans(Y, aw, ah) {
    const m = new Float32Array(aw);
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) m[x] += Y[y * aw + x];
    for (let x = 0; x < aw; x++) m[x] /= ah;
    return m;
  }
  function rowMeans(Y, aw, ah) {
    const m = new Float32Array(ah);
    for (let y = 0; y < ah; y++) { let s = 0; for (let x = 0; x < aw; x++) s += Y[y * aw + x]; m[y] = s / aw; }
    return m;
  }
  // True if profile a looks like b shifted by >= 1 px (camera pan/tilt).
  function globalShift(a, b) {
    const n = a.length, maxS = Math.max(2, Math.round(n * 0.1));
    const sad = (s) => {
      let t = 0, c = 0;
      for (let i = Math.max(0, s); i < Math.min(n, n + s); i++) { t += Math.abs(a[i] - b[i - s]); c++; }
      return t / c;
    };
    const s0 = sad(0);
    if (s0 < 0.6) return false;                      // nothing changed
    let best = s0, bestS = 0;
    for (let s = -maxS; s <= maxS; s++) { const v = sad(s); if (v < best) { best = v; bestS = s; } }
    return bestS !== 0 && best < 0.6 * s0;
  }

  // Game layer: crop. The whole removal comes off the edges, with the window
  // placed by content (centred unless something important sits at one edge).
  // Overlays are drawn separately at true size, so cropping under them is fine.
  // Only if cropping would cut important content (both edges busy) is a small
  // even squeeze used instead, never more than maxSqueezeShare of the removal.
  function planLayout(imp, keep, moving, ov) {
    const n = imp.length, remove = (1 - keep) * n;
    const maxL = ov.limL, maxR = ov.limR;        // only set for overlays that can't be drawn
    // (they steer the crop to the other side but never force a squeeze)
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + imp[i];
    const tot = cs[n] || 1;
    const C = (x) => {
      const i = Math.min(n - 1, Math.max(0, Math.floor(x)));
      return cs[i] + (cs[i + 1] - cs[i]) * (x - i);
    };
    const split = (t) => {                       // best left/right split of a crop of t
      let best = Infinity, bestL = -1, bestLoss = 1;
      for (let l = 0; l <= t + 1e-9; l += 0.5) {
        if (l > maxL + 1e-9 || t - l > maxR + 1e-9) continue;
        const loss = (C(l) + tot - C(n - (t - l))) / tot;
        const score = loss + CFG.asymCost * Math.abs(l - t / 2) / (t / 2 || 1);
        if (score < best) { best = score; bestL = l; bestLoss = loss; }
      }
      return bestL < 0 ? null : { l: bestL, loss: bestLoss };
    };
    const minT = remove * (1 - CFG.maxSqueezeShare);
    // HUD on both edges (any crop cuts some): take the small squeeze up front
    // so each edge loses ~3.5% instead of 5%.
    const startT = ov.hud ? minT : remove;
    let T = -1, L = 0;
    for (let t = startT; t >= minT - 1e-9; t -= 0.5) {
      const sp = split(t);
      if (!sp) continue;
      if (sp.loss <= CFG.cropAccept || t - 0.5 < minT) { T = t; L = sp.l; break; }
    }
    if (T < 0) {
      // Limits from overlays that can't be drawn block both sides: ignore them
      // rather than squeeze (squeeze looks worse than a crop at the edge).
      return planLayout(imp, keep, moving, { limL: n, limR: n });
    }
    return { L, R: T - L, kw: new Float32Array(n).fill(1) };   // any remainder = even squeeze
  }

  // Column widths: 0 where trimmed, the warp factor elsewhere, normalised so
  // the output is exactly keep * n columns wide.
  function combine(l, keep) {
    const n = l.kw.length, out = new Float32Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const o = Math.min(1, Math.max(0, Math.min(i + 1, n - l.R) - Math.max(i, l.L)));
      out[i] = o * l.kw[i];
      s += out[i];
    }
    const norm = keep * n / (s || 1);
    let wMin = Infinity;
    for (let i = 0; i < n; i++) {
      out[i] *= norm;
      if (out[i] > 0 && i >= Math.ceil(l.L) && i < Math.floor(n - l.R)) wMin = Math.min(wMin, out[i]);
    }
    warpMin = Number.isFinite(wMin) ? Math.min(1, wMin) : 1;
    return out;
  }

  // Per-column output width k[i] in [kMin, 1] with mean(k) = keep. Important
  // columns get k ~ 1 (undistorted); unimportant ones absorb the removal.
  function squeezeMap(imp, keep, mix, fixed) {
    const n = imp.length;
    let nf = 0;
    for (let i = 0; i < n; i++) if (!fixed[i]) nf++;
    const m = nf ? (keep * n - (n - nf)) / nf : keep;
    // Protected columns stay at 1; the rest absorb the removal. If that would
    // squeeze them too hard, fall back to treating everything alike.
    if (nf === n || nf < 0.3 * n || m < CFG.kMin) return squeezeCore(imp, keep, mix);
    const subImp = new Float32Array(nf);
    for (let i = 0, j = 0; i < n; i++) if (!fixed[i]) subImp[j++] = imp[i];
    const subK = squeezeCore(subImp, m, mix);
    let out = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++) out[i] = fixed[i] ? 1 : subK[j++];
    out = blur(out, CFG.spatialSigma / 2);
    let su = 0;
    for (let i = 0; i < n; i++) if (fixed[i]) out[i] = 1; else su += out[i];
    const norm = (keep * n - (n - nf)) / (su || 1);
    for (let i = 0; i < n; i++) if (!fixed[i]) out[i] *= norm;
    return out;
  }

  function squeezeCore(imp, keep, mix) {
    const n = imp.length;
    const g = blur(imp, 2);
    let mx = 0;
    for (let i = 0; i < n; i++) mx = Math.max(mx, g[i]);
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = Math.sqrt(g[i] / (mx || 1)) + 0.02;
    const kMin = Math.min(CFG.kMin, keep);
    const kOf = (c, i) => Math.min(1, Math.max(kMin, c * f[i]));
    let lo = 0, hi = 1000;
    for (let it = 0; it < 40; it++) {           // bisection on the gain c
      const c = (lo + hi) / 2;
      let s = 0;
      for (let i = 0; i < n; i++) s += kOf(c, i);
      if (s / n > keep) hi = c; else lo = c;
    }
    let out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = (1 - mix) * kOf(lo, i) + mix * keep;
    out = blur(out, CFG.spatialSigma);
    let s = 0;
    for (let i = 0; i < n; i++) s += out[i];
    const norm = keep * n / s;
    for (let i = 0; i < n; i++) out[i] *= norm;
    return out;
  }

  function blur(a, sigma) {
    const n = a.length, r = Math.ceil(sigma * 3), w = [];
    let ws = 0;
    for (let j = -r; j <= r; j++) { const v = Math.exp(-0.5 * (j / sigma) ** 2); w.push(v); ws += v; }
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += a[Math.min(n - 1, Math.max(0, i + j))] * w[j + r];
      out[i] = s / ws;
    }
    return out;
  }

  // Invert the column widths into an output-x -> source-x lookup.
  function buildLookup(kk, keep, l) {
    const n = kk.length, N = CFG.mapN, total = keep * n;
    // Only columns that are (partly) kept: never step into the cropped-away
    // edges, which used to leave a stretched sliver at the right edge.
    let first = 0, last = n - 1;
    while (first < n - 1 && kk[first] <= 1e-6) first++;
    while (last > first && kk[last] <= 1e-6) last--;
    let i = first, b = 0;            // column i spans output [b, b + kk[i])
    for (let j = 0; j < N; j++) {
      const t = (j / (N - 1)) * total;
      while (i < last && (kk[i] <= 1e-6 || b + kk[i] < t)) { b += kk[i]; i++; }
      const frac = kk[i] > 1e-6 ? Math.min(1, Math.max(0, (t - b) / kk[i])) : 0;
      // A partly cropped column keeps only [max(i, L), min(i+1, n-R)].
      const lo = l ? Math.max(i, l.L) : i, hi = l ? Math.min(i + 1, n - l.R) : i + 1;
      map[j] = (lo + frac * Math.max(0, hi - lo)) / n;
    }
  }

  // ------------------------------------------------------------------ UI
  function drawDebug() {
    if (!dbgEl || !dbgEl.isConnected) {
      dbgEl = document.createElement('div');
      dbgEl.className = 'smart1610-debug';
      dbgEl.appendChild(document.createElement('span'));
      dbgCanvas = document.createElement('canvas');
      dbgCanvas.width = 320; dbgCanvas.height = 48;
      dbgEl.appendChild(dbgCanvas);
      player.appendChild(dbgEl);
    }
    const n0 = k.length;
    dbgEl.firstChild.textContent =
      `16:10 smart v${VERSION}  removing ${((1 - 1 / fill) * 100).toFixed(1)}% of width\n` +
      `cuts ${cuts}   chat/text: ${textProt.L ? 'LEFT protected' : 'left -'} (${textProt.rowsL || 0} rows), ${textProt.R ? 'RIGHT protected' : 'right -'} (${textProt.rowsR || 0} rows)\n` +
      `game layer: cropped L ${(100 * lay.L / n0).toFixed(1)}% R ${(100 * lay.R / n0).toFixed(1)}%, even squeeze ${((1 / warpMin - 1) * 100).toFixed(1)}%` +
      `${performance.now() < hudUntil ? '  [HUD both edges: 7% crop + 3% squeeze]' : ''}  (camera ${camMoving ? 'moving' : 'still'})\n` +
      (ovInf < CFG.learnMinFrames
        ? `learning overlays... (${ovInf.toFixed(0)}/${CFG.learnMinFrames} moving moments)\n`
        : `overlay layers: ${ovActive.length} on screen / ${ovRects.length} known ` +
          `(drawn at true size; learned from ${ovInf.toFixed(0)} moving moments)\n`) +
      `bars = game layer columns kept (gap = cropped)\n` +
      `map = overlays (blue on screen, grey not)`;
    const c = dbgCanvas.getContext('2d'), n = k.length, bw = 320 / n;
    c.clearRect(0, 0, 320, 48);
    if (!dbgMini || !dbgMini.isConnected) {
      dbgMini = document.createElement('canvas');
      dbgMini.width = 160; dbgMini.height = 90;
      dbgMini.style.cssText = 'display:block;margin-top:4px;width:160px;height:90px;';
      dbgEl.appendChild(dbgMini);
    }
    const mc = dbgMini.getContext('2d');
    mc.fillStyle = '#222'; mc.fillRect(0, 0, 160, 90);
    const sx = 160 / (learnW || 320), sy = 90 / (learnH || 180);
    for (const r of ovRects) {
      mc.fillStyle = r.present ? 'rgba(80,160,255,.8)' : 'rgba(150,150,150,.6)';
      mc.fillRect(r.x0 * sx, r.y0 * sy, (r.x1 - r.x0) * sx, (r.y1 - r.y0) * sy);
    }
    for (let i = 0; i < n; i++) {
      const v = Math.min(1, k[i]);
      c.fillStyle = `hsl(${120 * (v - 0.4) / 0.6}, 80%, 50%)`;
      c.fillRect(i * bw, 48 * (1 - v), bw + 0.5, 48 * v);
    }
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1400);
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyZ') return;
    const el = e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      debug = !debug;
      if (!debug && dbgEl) { dbgEl.remove(); dbgEl = null; }
      return;
    }
    enabled = !enabled;
    store.set('enabled', enabled ? '1' : '0');
    if (enabled) ok = true;
    toast(`16:10 smart: ${enabled ? 'on' : 'off'}`);
    tick(true);
  }, true);

  function loop() { tick(false); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    setInterval(() => { if (video && !video.paused) tick(true); }, 40);
  }

  attach();
  setInterval(() => { attach(); restack(); }, 1000);
})();
