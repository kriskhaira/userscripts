// Stremio ratings — the shared core. build.mjs wraps it twice: as a Violentmonkey userscript
// (web.stremio.com in Chrome) and as a Stremio Enhanced plugin. Each wrapper hands it a `host`
// with storage, a JSON GET and the key's home; everything else lives here, once.
//
// Why (Kris, 2026-11-14): "how to get ratings on movies and tv series for stremio like we did with
// MUBI?" — then "go" on 2026-11-15. Same idea as mubi-ratings.user.js: one critic-weighted number
// per title, in the site's own look, with the breakdown one click away.
//
// The number (1–99; 60 = an average film):
// - Each score becomes "how far above or below an average film" (a z-score), with the same rough
//   population figures as the MUBI script (estimates, not measured): Metacritic 58 ± 17,
//   Tomatometer 62 ± 28, IMDb 6.4 ± 1.0. The result maps to 60 ± 16 per step, clamped to 1–99.
// - Kris's MUBI ruling, critics 65 % / audiences 35 %, with MUBI's own sources gone: Metacritic 42,
//   Rotten Tomatoes 23, IMDb 35. IMDb counts less on few votes (votes / (votes + 1000)); a missing
//   source drops out and the rest share its weight; thin evidence is pulled toward 60.
// - Series: OMDb usually carries only IMDb for a series, so a series score is often IMDb-only, and
//   the breakdown says so.
//
// Data: OMDb by IMDb ID (?i=tt…), exact, no title guessing — Stremio's tiles link to
// #/detail/<movie|series>/tt…. Free key = 1,000 calls a day, shared with the MUBI script (which
// stops at its own 950), so this one stops at 400 and treats "Request limit reached!" as a full
// day. Cache: OMDb 14 days, a miss 3 days. Tiles look up only once they scroll into view.
// The key goes only to www.omdbapi.com; DOM is built with createElement + textContent; nothing
// from the API is parsed as HTML.
//
// Markup checked 2026-11-15 on web.stremio.com (class names end in a generated hash, so only the
// readable prefix is matched):
// - tile: a[href="#/detail/movie/tt…/tt…"] > div[class^="poster-container"] (position: relative,
//   z-index 0 — its own layer); Stremio uses its top-left (watched, dismiss) and, for library
//   series with new episodes, its top-right ("new-videos"), so the badge drops below that one;
// - Discover's right panel and the detail page share one component: div[class*="meta-preview"] >
//   … > div[class*="runtime-release-info"] (runtime · year · IMDb button) — the score joins that row.

function stremioRatings(host) {
  'use strict';

  const TAG = '[stremio-ratings]';
  const DAY = 864e5;
  const TTL_OMDB = 14 * DAY;
  const TTL_MISS = 3 * DAY;
  const OMDB_CAP = 400; // of the free 1,000 a day; MUBI's script stops at its own 950
  const BAD_RETRY = 10 * 60e3; // a rejected key is re-tried after 10 min (a new key works only once activated)
  const KEY_RE = /^[a-z0-9]{8}$/i;
  const DETAIL = /#\/detail\/(movie|series)\/(tt\d{5,10})(?![0-9])/i;
  const TILE = { minW: 60, maxW: 600, minH: 60 };
  const now = () => Date.now();

  // ---------- the blend ----------
  const SOURCES = [
    { key: 'mc', label: 'Metacritic', kind: 'critics', w: 0.42, mean: 58, sd: 17 },
    { key: 'rt', label: 'Rotten Tomatoes', kind: 'critics', w: 0.23, mean: 62, sd: 28 },
    { key: 'imdb', label: 'IMDb', kind: 'audience', w: 0.35, mean: 6.4, sd: 1.0, k: 1000 },
  ];
  const SHRINK = 0.08; // evidence prior: pulls thin-evidence titles toward 60
  const MID = 60, PER_SD = 16;
  const num = v => { const n = parseFloat(String(v ?? '').replace(/[,%]/g, '')); return Number.isFinite(n) ? n : null; };

  function values(r) {
    return { mc: num(r && r.mc), rt: num(r && r.rt), imdb: num(r && r.imdb), imdbN: Math.max(0, num(r && r.votes) || 0) };
  }

  function blend(v) {
    const parts = []; let wz = 0, w = 0;
    for (const s of SOURCES) {
      const value = v[s.key];
      if (value == null) { parts.push({ ...s, value: null }); continue; }
      const n = s.k ? v[s.key + 'N'] : null;
      const we = s.w * (s.k ? n / (n + s.k) : 1);
      wz += we * (value - s.mean) / s.sd; w += we;
      parts.push({ ...s, value, n, we });
    }
    if (!w) return { score: null, parts };
    for (const p of parts) if (p.we) p.share = p.we / w;
    return { score: Math.max(1, Math.min(99, Math.round(MID + PER_SD * wz / (w + SHRINK)))), parts };
  }

  // ---------- storage (host: get / set / del / list, all synchronous) ----------
  const cacheGet = k => { const v = host.get('c:' + k); return v && v.e > now() ? v : null; };
  const cacheSet = (k, d, ttl) => host.set('c:' + k, { e: now() + ttl, d });
  (function prune() {
    const keys = host.list().filter(k => k.startsWith('c:'));
    if (keys.length < (host.maxEntries || 4000)) return;
    const t = now(), live = [];
    for (const k of keys) { const v = host.get(k); if (!v || v.e <= t) host.del(k); else live.push([k, v.e]); }
    const room = Math.floor((host.maxEntries || 4000) * 0.75);
    if (live.length > room) live.sort((a, b) => a[1] - b[1]).slice(0, live.length - room).forEach(([k]) => host.del(k));
  })();

  // ---------- network ----------
  function limiter(n) {
    let active = 0; const queue = [];
    const next = () => {
      if (active >= n || !queue.length) return;
      active++;
      const { fn, ok, fail } = queue.shift();
      fn().then(ok, fail).finally(() => { active--; next(); });
    };
    return fn => new Promise((ok, fail) => { queue.push({ fn, ok, fail }); next(); });
  }
  const omdbQ = limiter(2);
  const inflight = new Map();
  function once(key, fn) {
    if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
    return inflight.get(key);
  }

  // ---------- OMDb ----------
  class OmdbStop extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const today = () => new Date().toISOString().slice(0, 10);
  function budget() { const b = host.get('omdbBudget'); return b && b.day === today() ? b : { day: today(), used: 0, full: false }; }

  async function omdb(params) {
    const key = host.getKey();
    if (!key) throw new OmdbStop('nokey', 'no OMDb key');
    const bad = host.get('omdbBad');
    if (bad && bad.key === key && now() - bad.at < BAD_RETRY) throw new OmdbStop('badkey', bad.msg || 'Invalid API key!');
    const b = budget();
    if (b.full || b.used >= OMDB_CAP) throw new OmdbStop('limit', 'daily limit');
    b.used++; host.set('omdbBudget', b);
    const r = await omdbQ(() => host.request('https://www.omdbapi.com/?' + new URLSearchParams({ apikey: key, ...params })));
    const err = (r.body && r.body.Error) || '';
    if (/limit/i.test(err)) { b.full = true; host.set('omdbBudget', b); throw new OmdbStop('limit', err); }
    if (r.status === 401 || /api key/i.test(err)) {
      host.set('omdbBad', { key, at: now(), msg: err || 'HTTP 401' });
      console.debug(TAG, 'OMDb rejected the key:', err || 'HTTP 401'); // the key itself is never logged
      throw new OmdbStop('badkey', err || 'HTTP 401');
    }
    if (r.status !== 200 || !r.body) throw new Error('OMDb HTTP ' + r.status);
    return r.body.Response === 'True' ? r.body : null;
  }

  function summarise(d) {
    const na = v => (!v || v === 'N/A') ? null : String(v);
    const rt = (d.Ratings || []).find(x => x && x.Source === 'Rotten Tomatoes');
    return {
      id: String(d.imdbID || ''), title: String(d.Title || ''), year: na(d.Year), type: na(d.Type),
      imdb: na(d.imdbRating), votes: na(d.imdbVotes), rt: rt ? String(rt.Value) : null, mc: na(d.Metascore),
    };
  }

  function omdbFor(id) {
    const c = cacheGet('omdb:' + id);
    if (c) return Promise.resolve(c.d);
    return once('omdb:' + id, async () => {
      const d = await omdb({ i: id });
      const r = d ? summarise(d) : null;
      cacheSet('omdb:' + id, r, r ? TTL_OMDB : TTL_MISS);
      return r;
    });
  }

  // Everything one title needs: OMDb data (or why not) and the blend.
  function ratingsFor(id, type) {
    return once('rate:' + id, async () => {
      let r = null, status = 'ok', why = '';
      try { r = await omdbFor(id); if (!r) status = 'nomatch'; }
      catch (e) { status = e instanceof OmdbStop ? e.code : 'error'; why = e.message; if (status === 'error') console.debug(TAG, id, e.message); }
      return { id, type: (r && r.type) || type || 'movie', r, status, why, ...blend(values(r)) };
    });
  }

  // ---------- DOM helpers ----------
  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') e.style.cssText = v;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  const fmt1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const fmtCount = n => !n ? '' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', textContent: text });
  const note = text => el('span', { className: 'sr-note', textContent: text });
  function star() {
    const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    p.setAttribute('d', 'M12 1.8l3.1 6.6 7.2.9-5.3 5 1.4 7.1L12 17.9l-6.4 3.5 1.4-7.1-5.3-5 7.2-.9z');
    s.append(p); return s;
  }
  const scoreFace = score => [star(), el('span', { textContent: String(score) })];

  // Stremio's own look: its font (PlusJakartaSans, inherited), its white foreground and near-black
  // background, its pill radius. White outline, no colour bands (Kris's MUBI ruling, 6 Nov 2026:
  // "stick to white and black" … "same colours as on the site"). Over a poster the pill carries a
  // dark glass fill so it reads on snow and on black alike; hover inverts it, white with dark text.
  const FG = 'var(--primary-foreground-color, rgba(255,255,255,.9))';
  const BG = 'rgb(12,11,17)'; // Stremio's --primary-background-color
  document.head.append(el('style', { id: 'sr-style', textContent: `
    .sr-badge{position:absolute;top:.5rem;right:.5rem;z-index:1;pointer-events:none;line-height:0}
    .sr-badge.sr-low{top:2.1rem}
    .sr-score{pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;gap:.3em;box-sizing:border-box;margin:0;border:2px solid ${FG};border-radius:999px;background:rgba(12,11,17,.58);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);color:#fff;font-family:inherit;font-weight:700;font-size:13px;line-height:1;letter-spacing:.01em;font-variant-numeric:tabular-nums;white-space:nowrap;padding:4px 9px 4px 7px;box-shadow:0 1px 4px rgba(0,0,0,.35);transition:background-color .15s,color .15s}
    .sr-score svg{width:.95em;height:.95em;fill:currentColor;flex:none;margin-top:-.08em}
    .sr-score:hover,.sr-score[aria-expanded="true"]{background:#fff;border-color:#fff;color:${BG}}
    .sr-score:focus-visible{outline:2px solid #fff;outline-offset:2px}
    .sr-score.sr-big{font-size:1.1rem;font-weight:700;gap:.35em;padding:.45rem .95rem .45rem .75rem;box-shadow:none}
    .sr-row-item{flex:none;display:inline-flex;align-items:center}
    .sr-keybox{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:.75rem 0 .25rem;font-family:inherit;font-size:.95rem}
    .sr-note{color:${FG};font-weight:500;font-size:.95rem}
    .sr-keybox input{font-family:inherit;font-weight:500;font-size:.95rem;padding:.5rem .8rem;border-radius:999px;border:2px solid rgba(255,255,255,.35);background:rgba(12,11,17,.6);color:#fff;width:9em;-webkit-text-security:disc}
    .sr-keybox input.sr-bad{border-color:#fff}
    .sr-keybox .sr-btn,.sr-keybox a.sr-btn{font-family:inherit;font-weight:600;font-size:.95rem;padding:.5rem 1rem;border-radius:999px;border:0;background:rgba(255,255,255,.1);color:#fff;cursor:pointer;text-decoration:none;white-space:nowrap}
    .sr-keybox .sr-btn.sr-solid{background:#fff;color:${BG}}
    .sr-keybox .sr-btn:hover{background:rgba(255,255,255,.2)}
    .sr-keybox .sr-btn.sr-solid:hover{background:rgba(255,255,255,.85)}
    #sr-pop{position:fixed;z-index:2147483000;width:330px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;background:var(--modal-background-color, rgb(15,13,32));color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:var(--border-radius, .75rem);box-shadow:0 12px 36px rgba(0,0,0,.6);padding:14px 16px;font-size:13px;line-height:1.45;text-align:left}
    #sr-pop[hidden]{display:none}
    #sr-pop .sr-h{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-weight:700;font-size:14px}
    #sr-pop .sr-h .sr-score{cursor:default;pointer-events:none;background:none;color:#fff;border-color:#fff;box-shadow:none}
    #sr-pop .sr-sum{margin:0 0 8px;font-weight:700;font-size:13px}
    #sr-pop table{border-collapse:collapse;width:100%}
    #sr-pop th{font-weight:700;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.45;text-align:left;padding:6px 0 2px}
    #sr-pop td{padding:2px 0;vertical-align:baseline}
    #sr-pop td.v{text-align:right;font-weight:700;padding-left:10px;white-space:nowrap}
    #sr-pop td.s{text-align:right;opacity:.6;padding-left:10px;font-size:12px;white-space:nowrap}
    #sr-pop .sr-miss{opacity:.4}
    #sr-pop a{color:#fff;text-decoration:underline;text-underline-offset:2px}
    #sr-pop .sr-foot{margin-top:10px;font-size:12px;opacity:.75}
    #sr-pop .sr-warn{margin-top:8px;font-size:12px;font-weight:600;border-left:2px solid #fff;padding-left:8px}
  ` }));

  // ---------- the breakdown popover ----------
  const pop = el('div', { id: 'sr-pop', role: 'dialog', 'aria-label': 'Rating breakdown', hidden: true });
  document.body.append(pop);
  let popOwner = null, popSide = null;

  const isSeries = info => /series/i.test(info.type);
  function sourceLink(key, info) {
    const { r, id } = info;
    const q = encodeURIComponent((r && r.title) || '');
    if (key === 'imdb') return `https://www.imdb.com/title/${id}/`;
    if (key === 'mc') return `https://www.metacritic.com/search/${q}/${isSeries(info) ? '' : '?category=2'}`;
    return `https://www.rottentomatoes.com/search?search=${q}`;
  }
  function shown(p) {
    if (p.value == null) return '–';
    if (p.key === 'rt') return Math.round(p.value) + '%';
    if (p.key === 'mc') return String(Math.round(p.value));
    return fmt1(p.value) + (p.n ? ' · ' + fmtCount(p.n) : '');
  }

  // One plain line from the numbers: each side's weighted distance from an average film.
  const VERDICT = [[1.2, 'loved it'], [0.5, 'liked it'], [-0.5, 'were mixed'], [-Infinity, 'disliked it']];
  function verdict(parts, kind) {
    let wz = 0, w = 0;
    for (const p of parts) if (p.kind === kind && p.we) { wz += p.we * (p.value - p.mean) / p.sd; w += p.we; }
    return w ? VERDICT.find(([t]) => wz / w >= t)[1] : null;
  }
  function summary(parts) {
    const c = verdict(parts, 'critics'), a = verdict(parts, 'audience');
    if (c && a) return c === a ? `Critics and audiences ${c === 'were mixed' ? 'were both mixed' : 'both ' + c}.` : `Critics ${c}; audiences ${a}.`;
    return c ? `Critics ${c}.` : a ? `Audiences ${a}.` : '';
  }

  const MSG = {
    nokey: () => `IMDb, Rotten Tomatoes and Metacritic need a free OMDb key: ${host.keyHint}.`,
    badkey: why => `OMDb rejected the saved key (“${why}”). Click the activation link in OMDb’s email, then try again: ${host.keyHint}.`,
    limit: () => 'Today’s OMDb lookups are used up (this script stops at 400 of the free 1,000, shared with MUBI) — back tomorrow.',
    nomatch: () => 'OMDb has no entry for this IMDb ID.',
    error: why => `Ratings didn’t load: ${why}`,
  };

  function fillPop(info) {
    const { r, status, why, score, parts } = info;
    const title = r ? `${r.title}${r.year ? ` (${r.year})` : ''}` : info.id;
    const head = el('div', { className: 'sr-h' }, el('span', { className: 'sr-score' }, ...scoreFace(score)), el('span', { textContent: title }));
    const table = el('table');
    for (const kind of ['critics', 'audience']) {
      table.append(el('tr', {}, el('th', { colSpan: 3, textContent: kind === 'critics' ? 'Critics' : 'Audiences' })));
      for (const p of parts.filter(x => x.kind === kind)) {
        table.append(el('tr', { className: p.value == null ? 'sr-miss' : '' },
          el('td', {}, link(sourceLink(p.key, info), p.label)),
          el('td', { className: 'v', textContent: shown(p) }),
          el('td', { className: 's', textContent: p.share ? Math.round(p.share * 100) + '%' : '' })));
      }
    }
    const kids = [head];
    const sum = summary(parts);
    if (sum) kids.push(el('p', { className: 'sr-sum', textContent: sum }));
    kids.push(table);
    const used = parts.filter(p => p.we);
    if (used.length === 1 && used[0].key === 'imdb') {
      kids.push(el('div', { className: 'sr-warn', textContent: isSeries(info)
        ? 'IMDb only: OMDb carries no Rotten Tomatoes or Metacritic score for this series, so this number is IMDb’s alone.'
        : 'IMDb only: OMDb has no Rotten Tomatoes or Metacritic score for this film, so this number is IMDb’s alone.' }));
    }
    if (MSG[status]) kids.push(el('div', { className: 'sr-warn', textContent: MSG[status](why) }));
    const foot = el('div', { className: 'sr-foot' }, '60 = an average film · 70 good · 80+ great. Right column = weight used.');
    if (!isSeries(info)) foot.append(' ', link(`https://letterboxd.com/imdb/${info.id}/`, 'Letterboxd ↗'));
    kids.push(foot);
    pop.replaceChildren(...kids);
  }

  // The side (below or above the score) is picked once per open and kept, so nothing flips the box
  // (the MUBI lesson of 7 Nov 2026). Above, it hangs by its bottom edge.
  function placePop() {
    if (!popOwner) return;
    if (!popOwner.isConnected) return closePop();
    const b = popOwner.getBoundingClientRect();
    if (!b.width || b.bottom < 0 || b.top > innerHeight) return closePop();
    const p = pop.getBoundingClientRect();
    let left = b.right - p.width; // tiles: hang left from a top-right badge
    if (left < 8) left = b.left; // the title row: the score sits at the left, so start there
    left = Math.max(8, Math.min(left, innerWidth - p.width - 8));
    if (!popSide) {
      const below = innerHeight - 8 - (b.bottom + 6), above = b.top - 6 - 8;
      popSide = p.height <= below || below >= above ? 'below' : 'above';
    }
    pop.style.left = left + 'px';
    if (popSide === 'below') { pop.style.top = (b.bottom + 6) + 'px'; pop.style.bottom = 'auto'; }
    else { pop.style.top = 'auto'; pop.style.bottom = (innerHeight - b.top + 6) + 'px'; }
  }
  function openPop(btn, info) {
    closePop();
    fillPop(info);
    popOwner = btn; popSide = null; btn.setAttribute('aria-expanded', 'true');
    pop.hidden = false; placePop();
  }
  function closePop() {
    if (!popOwner) return;
    popOwner.setAttribute('aria-expanded', 'false');
    popOwner = null; pop.hidden = true;
  }
  document.addEventListener('click', e => { if (popOwner && !pop.contains(e.target) && !popOwner.contains(e.target)) closePop(); }, true);
  // Capture on window, ahead of Stremio's own shortcuts, so Esc closes the box and nothing else.
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !popOwner) return;
    const b = popOwner; closePop(); b.focus({ preventScroll: true });
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  let rafPending = false;
  const onMove = () => { if (popOwner && !rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; placePop(); }); } };
  addEventListener('scroll', onMove, { capture: true, passive: true });
  addEventListener('resize', onMove, { passive: true });

  function scoreButton(info, big = false) {
    const b = el('button', {
      type: 'button', className: `sr-score${big ? ' sr-big' : ''}`, tabIndex: 0,
      title: 'Blended rating — click for the breakdown', 'aria-label': `Rating ${info.score} of 100 — show the breakdown`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    });
    b.dataset.srId = info.id;
    b.append(...scoreFace(info.score));
    // A click on a tile's score must neither open the title nor select it in Discover.
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (popOwner === b) closePop(); else openPop(b, info); });
    for (const t of ['mousedown', 'pointerdown', 'mouseup', 'pointerup', 'touchstart', 'dblclick', 'keydown', 'keyup']) {
      b.addEventListener(t, e => { if (!/key/.test(t) || e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
    }
    return b;
  }

  // ---------- tiles ----------
  function idOf(href) {
    const m = String(href || '').match(DETAIL);
    return m ? { type: m[1].toLowerCase(), id: m[2].toLowerCase() } : null;
  }
  const posterOf = a => a.querySelector('[class*="poster-container"]');
  const ours = e => !!e.closest('#sr-pop, .sr-badge, .sr-row-item, .sr-keybox');
  const inPreview = e => !!e.closest('[class*="meta-preview"]');

  async function renderTile(a, id, type) {
    const live = () => a.isConnected && a.dataset.srId === id;
    try {
      const info = await ratingsFor(id, type);
      if (!live() || info.score == null) { if (live()) a.dataset.sr = 'none'; return; }
      const host_ = posterOf(a) || a;
      host_.querySelectorAll(':scope > .sr-badge').forEach(x => x.remove()); // never two
      if (getComputedStyle(host_).position === 'static') host_.style.position = 'relative';
      const badge = el('span', { className: 'sr-badge' }, scoreButton(info));
      badge.dataset.srId = id;
      if (host_.querySelector(':scope > [class*="new-videos"]')) badge.classList.add('sr-low');
      host_.append(badge);
      a.dataset.sr = 'shown';
    } catch (e) { console.debug(TAG, id, e.message); }
  }

  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const a = en.target; const { width: w, height: h } = en.boundingClientRect;
      if (!w || !h) continue; // a hidden route or slide: keep waiting
      io.unobserve(a);
      if (w < TILE.minW || w > TILE.maxW || h < TILE.minH) { a.dataset.sr = 'skip'; continue; }
      a.dataset.sr = 'done'; // → 'shown' once the score is on the page
      renderTile(a, a.dataset.srId, a.dataset.srType);
    }
  }, { rootMargin: '300px' });

  function scanTiles() {
    for (const a of document.querySelectorAll('a[href*="#/detail/"]')) {
      if (ours(a) || inPreview(a) || !posterOf(a)) continue; // the panel's Show button, an episode row
      const got = idOf(a.getAttribute('href'));
      if (!got) continue; // not an IMDb title (a channel, an addon's own ID)
      if (a.dataset.srId !== got.id) {
        // React reused this tile for another title: drop the old score, look the new one up.
        (posterOf(a) || a).querySelectorAll(':scope > .sr-badge').forEach(x => x.remove());
        a.dataset.srId = got.id; a.dataset.srType = got.type; a.dataset.sr = 'wait';
        io.unobserve(a); io.observe(a);
      } else if (a.dataset.sr === 'wait') {
        io.unobserve(a); io.observe(a); // re-check: a route may have become visible
      } else if (a.dataset.sr === 'shown' && !(posterOf(a) || a).querySelector(':scope > .sr-badge')) {
        a.dataset.sr = 'wait'; io.observe(a); // Stremio re-drew the poster and dropped the score: put it back
      }
    }
  }

  // ---------- Discover's right panel and the detail page ----------
  function previewId(row) {
    const box = row.closest('[class*="meta-preview"]') || row.parentElement;
    const imdbBtn = box && box.querySelector('a[href*="imdb.com"]');
    if (imdbBtn) {
      let h = imdbBtn.getAttribute('href') || '';
      try { h = decodeURIComponent(h); } catch (_) { /* keep raw */ }
      const m = h.match(/imdb\.com\/title\/(tt\d{5,10})/i);
      if (m) {
        const show = box.querySelector('a[href*="#/detail/"]');
        const typed = show && idOf(show.getAttribute('href'));
        const here = idOf(location.hash);
        return { id: m[1].toLowerCase(), type: (typed && typed.type) || (here && here.type) || '' };
      }
    }
    const show = box && box.querySelector('a[href*="#/detail/"]');
    return (show && idOf(show.getAttribute('href'))) || (/^#\/detail\//.test(location.hash) ? idOf(location.hash) : null);
  }

  function keyForm(msg, rejected) {
    const input = el('input', { type: 'text', placeholder: rejected ? 'or paste a new key' : 'OMDb key', autocomplete: 'off', spellcheck: false, 'aria-label': 'OMDb API key' });
    const err = note('');
    const save = () => {
      const v = input.value.trim();
      const key = KEY_RE.test(v) ? v : (v.match(/\b(?=[a-z]*\d)[a-z0-9]{8}\b/i) || [])[0]; // a pasted line such as "Here is your key: 1a2b3c4d"
      if (!key) { input.classList.add('sr-bad'); err.textContent = 'That isn’t an OMDb key — paste just the 8-character key from OMDb’s email'; input.focus(); return; }
      host.saveKey(key); host.del('omdbBad');
      refreshAll();
    };
    for (const t of ['keydown', 'keyup', 'keypress']) input.addEventListener(t, e => { e.stopPropagation(); if (t === 'keydown' && e.key === 'Enter') save(); });
    const kids = [note(msg)];
    if (rejected) kids.push(el('button', { type: 'button', className: 'sr-btn', textContent: 'Try again', onclick: () => { host.del('omdbBad'); refreshAll(); } }));
    else kids.push(el('a', { className: 'sr-btn', href: 'https://www.omdbapi.com/apikey.aspx', target: '_blank', rel: 'noopener noreferrer', textContent: 'Get a free key ↗' }));
    kids.push(input, el('button', { type: 'button', className: 'sr-btn sr-solid', textContent: 'Save', onclick: save }), err);
    const box = el('div', { className: 'sr-keybox' }, ...kids);
    for (const t of ['mousedown', 'pointerdown', 'click']) box.addEventListener(t, e => e.stopPropagation());
    return box;
  }

  async function fillRow(row, slot, id, type) {
    const live = () => slot.isConnected && slot.dataset.srId === id;
    const info = await ratingsFor(id, type);
    if (!live()) return;
    const kids = info.score != null ? [scoreButton(info, true)] : [];
    slot.replaceChildren(...kids);
    // The key box and plain notes go on the detail page only; Discover's narrow panel stays clean.
    const page = row.closest('[class*="meta-preview"]');
    const onDetail = /^#\/detail\//.test(location.hash) && !!idOf(location.hash) && idOf(location.hash).id === id;
    page && page.querySelectorAll('.sr-keybox').forEach(x => x.remove());
    if (!onDetail) return;
    let extra = null;
    if (info.status === 'nokey') extra = keyForm('IMDb · Rotten Tomatoes · Metacritic need a free OMDb key:', false);
    else if (info.status === 'badkey') extra = keyForm(`⚠️ Your key is saved, but OMDb says “${info.why}”. A new key only works after you click the activation link in OMDb’s email. Click it, then:`, true);
    else if (info.score == null) extra = el('div', { className: 'sr-keybox' }, note(MSG[info.status] ? MSG[info.status](info.why) : 'No IMDb, Rotten Tomatoes or Metacritic score yet.'));
    if (extra) { extra.dataset.srId = id; row.after(extra); }
  }

  function scanRows() {
    for (const row of document.querySelectorAll('[class*="runtime-release-info"]')) {
      if (!row.getClientRects().length) continue; // a hidden route keeps its DOM
      const got = previewId(row);
      let slot = row.querySelector(':scope > .sr-row-item');
      if (!got) { slot?.remove(); continue; }
      if (slot && slot.dataset.srId === got.id) continue;
      slot?.remove();
      slot = el('span', { className: 'sr-row-item' });
      slot.dataset.srId = got.id;
      row.append(slot);
      fillRow(row, slot, got.id, got.type).catch(e => console.debug(TAG, got.id, e.message));
    }
    // A key box left behind by a title that is no longer shown.
    for (const k of document.querySelectorAll('.sr-keybox')) {
      const row = k.previousElementSibling;
      const slot = row && row.querySelector(':scope > .sr-row-item');
      if (!slot || slot.dataset.srId !== k.dataset.srId) k.remove();
    }
  }

  // ---------- wiring ----------
  function refreshAll() {
    closePop();
    inflight.clear();
    document.querySelectorAll('.sr-badge, .sr-row-item, .sr-keybox').forEach(x => x.remove());
    for (const a of document.querySelectorAll('a[data-sr-id]')) { io.unobserve(a); delete a.dataset.srId; delete a.dataset.sr; delete a.dataset.srType; }
    scan();
  }
  function clearCache() {
    for (const k of host.list()) if (k.startsWith('c:')) host.del(k);
    refreshAll(); // today's OMDb count is kept: OMDb still counts those calls
  }

  let lastHash = location.hash;
  function scan() {
    if (location.hash !== lastHash) { lastHash = location.hash; closePop(); }
    scanTiles(); scanRows();
  }
  let timer = 0;
  new MutationObserver(muts => {
    if (muts.every(m => pop.contains(m.target))) return; // our own redraws
    clearTimeout(timer); timer = setTimeout(scan, 200);
  }).observe(document.body, { childList: true, subtree: true });
  addEventListener('hashchange', () => { clearTimeout(timer); timer = setTimeout(scan, 50); });
  scan();

  return { refreshAll, clearCache, blend, values, ratingsFor, SOURCES, OMDB_CAP };
}
