// ==UserScript==
// @name         Instagram — video scrubber, speed, mirror, reverse
// @namespace    https://github.com/kriskhaira/userscripts
// @version      1.1.1
// @description  One control bar on the Instagram video in view: timeline scrubber, 0.5× / 1× / 2×, mirror (flip left–right), reverse playback, frame step. For studying technique clips. Sits above Instagram's own controls (a Story's reply box, heart, send).
// @author       Kris Khaira
// @match        https://www.instagram.com/*
// @run-at       document-idle
// @inject-into  content
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/kriskhaira/userscripts/main/instagram-video-controls.user.js
// @updateURL    https://raw.githubusercontent.com/kriskhaira/userscripts/main/instagram-video-controls.user.js
// ==/UserScript==

// Keys (ignored while typing): Space play/pause · , . frame back/forward · ← → 2 s
// · M mirror · R reverse · 1 2 3 = 0.5× 1× 2×
// Chrome cannot play video backwards natively (negative playbackRate is unsupported,
// whatwg/html#3754), so reverse steps back one seek at a time; it is smooth once the clip
// has buffered and choppier on long clips with few keyframes.
// DOM is built with createElement + textContent only: Instagram enforces Trusted Types.

// Instagram's own controls at the foot of a video (a Story's "Reply to …" box, heart and send
// icons; a Reel's caption and audio links) must stay clickable, so the bar sits ABOVE the
// highest one in the video's bottom strip. Pure, so Node can test it: rects are
// {top, bottom, left, right} like getBoundingClientRect().
const STRIP = 140;   // how far up from the video's foot we look for controls, px
const TALL = 120;    // anything taller is an overlay covering the video, not a control
const GAP = 6;       // space kept between the bar and the control below it
function barFloor(video, rects, viewH) {
  let floor = Math.min(video.bottom, viewH);
  const stripTop = floor - STRIP;
  for (const q of rects) {
    const h = q.bottom - q.top;
    if (h <= 0 || h > TALL || q.right <= q.left) continue;
    if (q.bottom <= stripTop || q.top >= floor) continue;      // not in the bottom strip
    if (q.right <= video.left || q.left >= video.right) continue; // not under the video
    if (q.top - GAP < floor) floor = q.top - GAP;
  }
  return floor;
}

// A control counts only when it can actually be seen and clicked: an SPA leftover with
// opacity 0, visibility hidden or pointer-events none must not lift the bar (agy review,
// 25 Nov 2026). style = the getComputedStyle() fields used.
function isLiveControl(style) {
  if (!style) return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (style.pointerEvents === 'none') return false;
  return !(parseFloat(style.opacity) === 0);
}

// The bar's top: its foot sits at `bottom`, but never above the viewport's top edge + 8 px,
// so a video scrolled mostly off the top cannot push the bar out of sight.
const TOP_MIN = 8;
const barTop = (bottom, height) => Math.max(TOP_MIN, bottom - height);

if (typeof document === 'undefined') {
  module.exports = { barFloor, isLiveControl, barTop }; // Node, for the tests
} else (() => {
  'use strict';

  const SPEEDS = [0.5, 1, 2];
  const FRAME = 1 / 30; // Instagram serves ~30 fps
  const state = { speed: 1, mirror: false, reverse: false };
  let video = null; // the video the bar is attached to
  let scrubbing = false;
  let controls = []; // rects of Instagram's own controls, for barFloor()
  let lastPick = 0;

  // ---------- build the bar ----------
  const el = (tag, props = {}, style = {}) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    Object.assign(n.style, style);
    return n;
  };
  const btnStyle = {
    all: 'unset', cursor: 'pointer', padding: '3px 6px', borderRadius: '6px',
    font: '600 12px/1.2 -apple-system, system-ui, sans-serif', color: '#fff',
    background: 'rgba(255,255,255,0.12)', whiteSpace: 'nowrap', userSelect: 'none',
  };
  const bar = el('div', {}, {
    position: 'fixed', zIndex: '2147483646', display: 'none', alignItems: 'center',
    flexWrap: 'wrap', gap: '5px', padding: '6px 8px', boxSizing: 'border-box', borderRadius: '10px',
    background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(6px)', opacity: '0.55',
    transition: 'opacity 120ms', font: '12px -apple-system, system-ui, sans-serif',
  });
  bar.addEventListener('mouseenter', () => { bar.style.opacity = '1'; });
  bar.addEventListener('mouseleave', () => { bar.style.opacity = '0.55'; });
  // Instagram's overlay toggles play/mute on click: keep our clicks to ourselves.
  for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
    bar.addEventListener(t, (e) => e.stopPropagation());
  }

  const mkBtn = (text, title, onClick) => {
    const b = el('button', { type: 'button', textContent: text, title }, btnStyle);
    b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    return b;
  };
  const playBtn = mkBtn('⏯', 'Play / pause (Space)', () => togglePlay());
  const backBtn = mkBtn('⟨', 'Back one frame ( , )', () => step(-FRAME));
  const fwdBtn = mkBtn('⟩', 'Forward one frame ( . )', () => step(FRAME));
  const scrub = el('input', { type: 'range', min: '0', max: '1000', value: '0', title: 'Scrub' }, {
    flex: '1 1 auto', minWidth: '60px', accentColor: '#fff', cursor: 'pointer', margin: '0',
  });
  const time = el('span', { textContent: '0:00 / 0:00' }, {
    color: '#fff', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontSize: '11px',
  });
  const speedBtns = SPEEDS.map((s, i) => mkBtn(`${s}×`, `Speed ${s}× (${i + 1})`, () => setSpeed(s)));
  const mirrorBtn = mkBtn('⇋', 'Mirror left–right (M)', () => setMirror(!state.mirror));
  const revBtn = mkBtn('◀◀', 'Reverse playback (R)', () => setReverse(!state.reverse));
  // Row 1: scrubber + time, full width. Row 2: buttons (wraps again on very narrow videos).
  const row1 = el('div', {}, { display: 'flex', alignItems: 'center', gap: '6px', width: '100%' });
  row1.append(scrub, time);
  bar.append(row1, playBtn, backBtn, fwdBtn, ...speedBtns, mirrorBtn, revBtn);
  document.body.append(bar);

  // ---------- helpers ----------
  const fmt = (t) => {
    if (!isFinite(t)) return '0:00';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const dur = () => (video && isFinite(video.duration) ? video.duration : 0);
  const on = (b, active) => { b.style.background = active ? '#fff' : btnStyle.background; b.style.color = active ? '#000' : '#fff'; };

  function render() {
    speedBtns.forEach((b, i) => on(b, SPEEDS[i] === state.speed));
    on(mirrorBtn, state.mirror);
    on(revBtn, state.reverse);
  }

  function apply(v) {
    if (!v) return;
    if (v.playbackRate !== state.speed) v.playbackRate = state.speed;
    v.style.transform = state.mirror ? 'scaleX(-1)' : '';
  }

  // ---------- actions ----------
  function togglePlay() {
    if (!video) return;
    if (state.reverse) { setReverse(false); return; }
    video.paused ? video.play().catch(() => {}) : video.pause();
  }
  function step(dt) {
    if (!video) return;
    if (state.reverse) setReverse(false);
    video.pause();
    video.currentTime = Math.min(Math.max(0, video.currentTime + dt), dur());
  }
  function setSpeed(s) { state.speed = s; apply(video); render(); }
  function setMirror(m) { state.mirror = m; apply(video); render(); }

  // Reverse: pause, then seek backwards; the next seek waits for 'seeked' so frames show.
  let revLast = 0;
  let revWaiting = false;
  function setReverse(r) {
    state.reverse = r;
    render();
    if (!video) return;
    if (r) {
      video.pause();
      revLast = performance.now();
      revWaiting = false;
      requestAnimationFrame(reverseTick);
    }
  }
  function onSeeked() { revWaiting = false; }
  function reverseTick(now) {
    if (!state.reverse || !video) return;
    if (!revWaiting) {
      const dt = Math.min((now - revLast) / 1000, 0.25) * state.speed;
      revLast = now;
      let t = video.currentTime - Math.max(dt, FRAME / 2);
      if (t <= 0) t = dur(); // loop like Instagram does
      revWaiting = true;
      video.currentTime = t;
    } // while a seek is pending, time keeps accruing so the next jump covers it
    requestAnimationFrame(reverseTick);
  }

  // ---------- pick the video in view ----------
  function visibleArea(v) {
    const r = v.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  }
  function pick() {
    let best = null;
    let bestArea = 40000; // ignore thumbnails smaller than ~200×200
    for (const v of document.querySelectorAll('video')) {
      const a = visibleArea(v);
      if (a > bestArea) { best = v; bestArea = a; }
    }
    if (best !== video) attach(best);
    sampleControls();
  }
  // Instagram's clickable things on screen, re-read with each pick (every 300 ms) and whenever
  // the video has moved since the last read (a scroll), not on every still frame.
  let sampledAt = null; // the video's rect when `controls` was read
  function sampleControls() {
    controls = video ? controlRects() : [];
    sampledAt = video ? video.getBoundingClientRect() : null;
  }
  const CONTROLS = 'textarea, input:not([type="range"]), [contenteditable="true"], button, [role="button"], a[href]';
  function controlRects() {
    const out = [];
    for (const n of document.querySelectorAll(CONTROLS)) {
      if (bar.contains(n)) continue;
      const q = n.getBoundingClientRect();
      if (!q.width || !q.height) continue;
      // checkVisibility() also sees an ancestor's opacity 0 / visibility hidden (Chrome 121+).
      if (n.checkVisibility && !n.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (!isLiveControl(getComputedStyle(n))) continue;
      out.push(q);
    }
    return out;
  }
  function attach(v) {
    if (video) {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('ratechange', onRate);
      video.removeEventListener('loadedmetadata', onMeta);
    }
    if (state.reverse) setReverse(false);
    video = v;
    if (!v) { bar.style.display = 'none'; return; }
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ratechange', onRate);
    v.addEventListener('loadedmetadata', onMeta);
    apply(v);
    bar.style.display = 'flex';
  }
  // Instagram resets the rate when it swaps sources; put ours back.
  function onRate() { if (video && video.playbackRate !== state.speed) video.playbackRate = state.speed; }
  function onMeta() { apply(video); }

  // ---------- scrubber ----------
  scrub.addEventListener('input', () => {
    if (!video || !dur()) return;
    scrubbing = true;
    if (state.reverse) setReverse(false);
    video.currentTime = (scrub.value / 1000) * dur();
  });
  scrub.addEventListener('change', () => { scrubbing = false; });

  // ---------- keys ----------
  addEventListener('keydown', (e) => {
    if (!video || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && t !== scrub) return;
    const k = e.key.toLowerCase();
    const act = {
      ' ': togglePlay, ',': () => step(-FRAME), '.': () => step(FRAME),
      arrowleft: () => step(-2), arrowright: () => step(2),
      m: () => setMirror(!state.mirror), r: () => setReverse(!state.reverse),
      1: () => setSpeed(0.5), 2: () => setSpeed(1), 3: () => setSpeed(2),
    }[k];
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  }, true);

  // ---------- loop: follow the video, update the bar ----------
  function loop(now) {
    if (now - lastPick > 300) { lastPick = now; pick(); }
    if (video) {
      if (!video.isConnected) { attach(null); }
      else {
        let r = video.getBoundingClientRect();
        if (sampledAt && (Math.abs(r.top - sampledAt.top) > 2 || Math.abs(r.left - sampledAt.left) > 2)) {
          sampleControls(); // the page scrolled: the old control rects are stale
          r = sampledAt;
        }
        const bottom = barFloor(r, controls, innerHeight) - 8;
        const left = Math.max(r.left, 0) + 8;
        const right = Math.min(r.right, innerWidth) - 52; // clear Instagram's mute button
        bar.style.left = `${left}px`;
        bar.style.width = `${Math.max(right - left, 200)}px`;
        bar.style.top = `${barTop(bottom, bar.offsetHeight)}px`;
        if (!scrubbing && dur()) scrub.value = String(Math.round((video.currentTime / dur()) * 1000));
        time.textContent = `${fmt(video.currentTime)} / ${fmt(dur())}`;
        playBtn.textContent = video.paused && !state.reverse ? '▶' : '❚❚';
      }
    }
    requestAnimationFrame(loop);
  }
  render();
  requestAnimationFrame(loop);
})();
