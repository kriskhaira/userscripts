// ==UserScript==
// @name         MUBI — ratings on tiles, plus IMDb, Rotten Tomatoes and Metacritic
// @namespace    https://github.com/kriskhaira/userscripts
// @version      1.1.0
// @description  One number per film on MUBI (tiles, the big top film, film pages): a critic-weighted blend of Metacritic, Rotten Tomatoes, MUBI critics, MUBI members and IMDb. Click it for the breakdown and links. IMDb · RT · Metacritic need a free OMDb key, pasted once on any film page.
// @author       Kris Khaira
// @match        https://mubi.com/*
// @match        https://www.mubi.com/*
// @run-at       document-idle
// @inject-into  content
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @connect      api.mubi.com
// @connect      www.omdbapi.com
// @downloadURL  https://raw.githubusercontent.com/kriskhaira/userscripts/main/mubi-ratings.user.js
// @updateURL    https://raw.githubusercontent.com/kriskhaira/userscripts/main/mubi-ratings.user.js
// ==/UserScript==
//
// Why (Kris, 2026-11-06): "very annoying that they don't show ratings" … "RT, imdb, metacr,
// whatever", then "let's just show one number. a magic blend of MUBI score and external scores.
// put more weight on the high quality expert scores" and "when i click once [show the
// breakdown] coz otherwise i can't then click on the imdb/rt/etc links".
//
// The number (1–99; 60 = an average film):
// - Each score becomes "how far above or below an average film" (a z-score), using rough
//   population means and spreads (estimates, not measured): Metacritic 58 ± 17, Tomatometer
//   62 ± 28, MUBI critics 3.5 ± 0.6 /5, MUBI members 6.4 ± 1.4 /10, IMDb 6.4 ± 1.0.
// - Weights lean on critics (65 %): Metacritic 35, Rotten Tomatoes 20, MUBI critics 10; then
//   audiences (35 %): MUBI members 20, IMDb 15. Thin samples count less (MUBI members n/(n+100),
//   IMDb votes/(votes+1000)); missing sources drop out and the rest are re-weighted; a film with
//   little evidence is pulled toward 60.
// - Checked against Kris's own bars (Criteria — Movie Watchlist): Inside Out 2, his "good" bar
//   (IMDb 7.6 · MC 73 · RT 91 %), comes out ~71; Spectre ~59; Venom: The Last Dance ~47;
//   In the Mood for Love ~84. Colour: green ≥ 70, amber 55–69, red < 55.
//
// Data:
// - MUBI: api.mubi.com/v4/films/<slug> (the API mubi.com uses; needs Client: web and a
//   Client-Country taken from the URL, /en/my/… → MY): members' average, count, critics' average
//   (0 = no critic reviews → missing).
// - IMDb, RT, Metacritic: OMDb, matched by title + year (±1), then the original title, then an
//   OMDb search; a director mismatch shows "check the match" in the breakdown. Free key = 1,000
//   calls a day; this stops at 950. Tiles only look up once they scroll into view.
// - Cache in Violentmonkey storage: MUBI 7 days, OMDb 14 days, a miss 3 days. Menu: Violentmonkey
//   icon → this script → "Set OMDb key…" / "Clear cached ratings".
// - The key stays in Violentmonkey's storage and is only sent to www.omdbapi.com. DOM is built
//   with createElement + textContent only; no API text is parsed as HTML.
//
// Markup checked 2026-11-06 (class names are generated hashes, so nothing depends on them):
// - tiles: empty, absolutely positioned <a href="/en/my/films/<slug>"> overlays (~372×418);
// - the big top film (Now Showing): a full-width overlay link plus a ~1124×132 link over its text;
//   its WATCH (<a href="/en/films/<id>/player">) and + buttons share a flex row below that text;
// - a film page's title block holds h1[itemprop="name"] + the original-title h2.
// Bump @version on every edit.

(() => {
  'use strict';

  const TAG = '[mubi-ratings]';
  const DAY = 864e5;
  const TTL_MUBI = 7 * DAY;
  const TTL_OMDB = 14 * DAY;
  const TTL_MISS = 3 * DAY;
  const OMDB_CAP = 950;
  const BAD_RETRY = 10 * 60e3; // a rejected key is re-tried after 10 min (a new key works only once activated)
  const KEY_RE = /^[a-z0-9]{8}$/i;
  const TILE = { minW: 120, maxW: 900, minH: 90 };
  const FILM_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:[a-z]{2}\/)?films\/([a-z0-9][a-z0-9-]*)\/?$/i;
  const NOT_COUNTRY = new Set(['go', 'tv']);

  // ---------- the blend ----------
  const SOURCES = [
    { key: 'mc', label: 'Metacritic', kind: 'critics', w: 0.35, mean: 58, sd: 17 },
    { key: 'rt', label: 'Rotten Tomatoes', kind: 'critics', w: 0.20, mean: 62, sd: 28 },
    { key: 'critic', label: 'MUBI critics', kind: 'critics', w: 0.10, mean: 3.5, sd: 0.6 },
    { key: 'mubi', label: 'MUBI members', kind: 'audience', w: 0.20, mean: 6.4, sd: 1.4, k: 100 },
    { key: 'imdb', label: 'IMDb', kind: 'audience', w: 0.15, mean: 6.4, sd: 1.0, k: 1000 },
  ];
  const SHRINK = 0.08; // evidence prior: pulls thin-evidence films toward 60
  const MID = 60, PER_SD = 16;
  const num = v => { const n = parseFloat(String(v ?? '').replace(/[,%]/g, '')); return Number.isFinite(n) ? n : null; };

  function values(f, r) {
    return {
      mc: num(r && r.mc), rt: num(r && r.rt), critic: f.critic || null,
      mubi: f.n > 0 ? f.avg : null, mubiN: f.n,
      imdb: num(r && r.imdb), imdbN: num(r && r.votes) || 0,
    };
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
  const band = s => s >= 70 ? 'mr-good' : s >= 55 ? 'mr-mid' : 'mr-low';

  // ---------- storage ----------
  const cacheGet = k => { const v = GM_getValue('c:' + k); return v && v.e > Date.now() ? v : null; };
  const cacheSet = (k, d, ttl) => GM_setValue('c:' + k, { e: Date.now() + ttl, d });
  const getKey = () => String(GM_getValue('omdbKey', '') || '').trim();

  (function prune() {
    const keys = GM_listValues();
    if (keys.length < 4000) return;
    const now = Date.now();
    for (const k of keys) if (k.startsWith('c:')) { const v = GM_getValue(k); if (!v || v.e <= now) GM_deleteValue(k); }
  })();

  let lastCountry = GM_getValue('country', '');
  function country() {
    const m = location.pathname.match(/^\/[a-z]{2}(?:-[a-z]{2})?\/([a-z]{2})(?=\/|$)/i);
    if (m && !NOT_COUNTRY.has(m[1].toLowerCase())) {
      const c = m[1].toUpperCase();
      if (c !== lastCountry) { lastCountry = c; GM_setValue('country', c); }
      return c;
    }
    return lastCountry || 'US';
  }

  // ---------- network ----------
  function get(url, headers = {}) {
    const bare = url.split('?')[0]; // never log the query: it holds the OMDb key
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, headers, timeout: 15000,
        onload: r => { let body = null; try { body = JSON.parse(r.responseText); } catch (_) { /* not JSON */ } resolve({ status: r.status, body }); },
        onerror: () => reject(new Error('network error: ' + bare)),
        ontimeout: () => reject(new Error('timeout: ' + bare)),
      });
    });
  }

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
  const mubiQ = limiter(3);
  const omdbQ = limiter(2);

  const inflight = new Map();
  function once(key, fn) {
    if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
    return inflight.get(key);
  }

  // ---------- MUBI ----------
  function mubiFilm(slug) {
    const ck = 'mubi2:' + slug;
    const c = cacheGet(ck);
    if (c) return Promise.resolve(c.d);
    return once(ck, async () => {
      const r = await mubiQ(() => get(`https://api.mubi.com/v4/films/${encodeURIComponent(slug)}`,
        { Client: 'web', 'Client-Country': country(), Accept: 'application/json' }));
      if (r.status === 404) { cacheSet(ck, null, TTL_MISS); return null; }
      if (r.status !== 200 || !r.body) throw new Error('MUBI API HTTP ' + r.status);
      const d = r.body;
      const f = {
        title: d.title || '',
        original: d.original_title || '',
        year: d.year || null,
        avg: d.average_rating_out_of_ten ?? (d.average_rating != null ? d.average_rating * 2 : null),
        n: d.number_of_ratings || 0,
        critic: d.critic_review_rating > 0 ? +d.critic_review_rating : null,
        directors: (d.directors || []).map(x => x.name).filter(Boolean),
      };
      cacheSet(ck, f, TTL_MUBI);
      return f;
    });
  }

  // ---------- OMDb ----------
  class OmdbStop extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const today = () => new Date().toISOString().slice(0, 10);
  function budget() { const b = GM_getValue('omdbBudget'); return b && b.day === today() ? b : { day: today(), used: 0, full: false }; }

  async function omdb(params) {
    const key = getKey();
    if (!key) throw new OmdbStop('nokey', 'no OMDb key');
    const bad = GM_getValue('omdbBad', null); // { key, at, msg }; 1.0.0 stored a bare string
    if (bad && bad.key === key && Date.now() - bad.at < BAD_RETRY) throw new OmdbStop('badkey', bad.msg || 'Invalid API key!');
    const b = budget();
    if (b.full || b.used >= OMDB_CAP) throw new OmdbStop('limit', 'OMDb daily limit reached');
    b.used++; GM_setValue('omdbBudget', b);
    const r = await omdbQ(() => get('https://www.omdbapi.com/?' + new URLSearchParams({ apikey: key, ...params })));
    const err = (r.body && r.body.Error) || '';
    if (/limit/i.test(err)) { b.full = true; GM_setValue('omdbBudget', b); throw new OmdbStop('limit', err); }
    if (r.status === 401 || /api key/i.test(err)) {
      GM_setValue('omdbBad', { key, at: Date.now(), msg: err || 'HTTP 401' });
      console.debug(TAG, 'OMDb rejected the key:', err || 'HTTP 401'); // the key itself is never logged
      throw new OmdbStop('badkey', err || 'HTTP 401');
    }
    if (r.status !== 200 || !r.body) throw new Error('OMDb HTTP ' + r.status);
    return r.body.Response === 'True' ? r.body : null;
  }

  const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const yearNear = (a, y) => { const n = parseInt(a, 10); return !y || !n || Math.abs(n - y) <= 1; };
  const STOP = new Set(['van', 'von', 'der', 'den', 'del', 'della', 'les', 'the', 'and']);
  const nameTokens = names => new Set(names.flatMap(n => norm(n).split(' ')).filter(t => t.length >= 3 && !STOP.has(t)));
  function sameDirector(omdbDirector, mubiDirectors) {
    if (!omdbDirector || omdbDirector === 'N/A' || !mubiDirectors.length) return null; // can't tell
    const a = nameTokens(omdbDirector.split(',')); const b = nameTokens(mubiDirectors);
    return [...a].some(t => b.has(t)); // token overlap copes with "Wong Kar Wai" vs "Kar-Wai Wong"
  }
  function titleCandidates(f) {
    const out = [];
    for (const t of [f.title, ...f.original.split('|')]) {
      const s = (t || '').trim();
      if (s && /[a-z]/i.test(s) && !out.some(o => norm(o) === norm(s))) out.push(s);
    }
    return out.slice(0, 3);
  }
  const titleLike = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

  function summarise(d, f) {
    const na = v => (!v || v === 'N/A') ? null : v;
    const rt = (d.Ratings || []).find(x => x.Source === 'Rotten Tomatoes');
    return {
      id: d.imdbID, title: d.Title, year: d.Year, director: na(d.Director),
      imdb: na(d.imdbRating), votes: na(d.imdbVotes), rt: rt ? rt.Value : null, mc: na(d.Metascore),
      unsure: sameDirector(d.Director, f.directors) === false,
    };
  }

  function omdbFor(slug, f) {
    const c = cacheGet('omdb:' + slug);
    if (c) return Promise.resolve(c.d);
    return once('omdb:' + slug, async () => {
      let hit = null;
      for (const t of titleCandidates(f)) {
        const p = { t, type: 'movie' }; if (f.year) p.y = f.year;
        const d = await omdb(p);
        if (d && yearNear(d.Year, f.year)) { hit = d; break; }
      }
      if (!hit && f.title) {
        const s = await omdb({ s: f.title, type: 'movie' });
        const pick = s && (s.Search || []).find(x => yearNear(x.Year, f.year) && titleLike(x.Title, f.title));
        if (pick) hit = await omdb({ i: pick.imdbID });
      }
      const r = hit ? summarise(hit, f) : null;
      cacheSet('omdb:' + slug, r, r ? TTL_OMDB : TTL_MISS);
      return r;
    });
  }

  // Everything one film needs: MUBI data, OMDb data (or why not), the blend.
  function ratingsFor(slug) {
    return once('rate:' + slug, async () => {
      const f = await mubiFilm(slug);
      if (!f) return null;
      let r = null, status = getKey() ? 'ok' : 'nokey', why = '';
      if (status === 'ok') {
        try { r = await omdbFor(slug, f); if (!r) status = 'nomatch'; }
        catch (e) { status = e instanceof OmdbStop ? e.code : 'error'; why = e.message; if (status === 'error') console.debug(TAG, slug, e.message); }
      }
      return { slug, f, r, status, why, ...blend(values(f, r)) };
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
  const note = text => el('span', { className: 'mr-note', textContent: text });

  document.head.append(el('style', { textContent: `
    .mr-badge{position:absolute;top:8px;right:8px;z-index:6;pointer-events:none}
    .mr-score{pointer-events:auto;cursor:pointer;border:0;border-radius:4px;color:#000;font:700 13px/1 system-ui,-apple-system,sans-serif;padding:5px 7px;min-width:2.4em;box-shadow:0 1px 3px rgba(0,0,0,.45)}
    .mr-score:focus-visible{outline:2px solid #fff;outline-offset:2px}
    .mr-score.mr-big{font-size:17px;padding:8px 12px}
    .mr-good{background:#7ed37e}.mr-mid{background:#ffd666}.mr-low{background:#ff8a80}
    .mr-hero{margin-left:16px;align-self:center}
    .mr-panel{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 4px;font:600 14px/1.2 system-ui,-apple-system,sans-serif}
    .mr-note{color:#fff;font-weight:500;font-size:13px;text-shadow:0 1px 3px rgba(0,0,0,.8)}
    .mr-pill{display:inline-flex;background:rgba(0,0,0,.74);color:#fff;padding:6px 10px;border-radius:4px;white-space:nowrap;text-decoration:none}
    .mr-panel input{font:500 13px system-ui,-apple-system,sans-serif;padding:6px 8px;border-radius:4px;border:1px solid rgba(255,255,255,.6);background:rgba(0,0,0,.7);color:#fff;width:9em;-webkit-text-security:disc}
    .mr-panel input.mr-bad{border-color:#ff6b6b}
    .mr-panel button.mr-btn{font:600 13px system-ui,-apple-system,sans-serif;padding:6px 12px;border-radius:4px;border:0;background:#fff;color:#000;cursor:pointer}
    #mr-pop{position:fixed;z-index:2147483000;width:300px;max-width:calc(100vw - 16px);box-sizing:border-box;background:#141414;color:#fff;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:12px 14px;font:500 13px/1.4 system-ui,-apple-system,sans-serif;text-align:left}
    #mr-pop[hidden]{display:none}
    #mr-pop .mr-h{display:flex;align-items:center;gap:10px;margin-bottom:8px;font-weight:700;font-size:14px}
    #mr-pop .mr-h .mr-score{cursor:default;pointer-events:none}
    #mr-pop table{border-collapse:collapse;width:100%}
    #mr-pop th{font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;opacity:.55;text-align:left;padding:6px 0 2px}
    #mr-pop td{padding:2px 0;vertical-align:baseline}
    #mr-pop td.v{text-align:right;font-weight:700;padding-left:10px;white-space:nowrap}
    #mr-pop td.s{text-align:right;opacity:.6;padding-left:10px;font-size:12px;white-space:nowrap}
    #mr-pop .mr-miss{opacity:.4}
    #mr-pop a{color:#fff;text-decoration:underline;text-underline-offset:2px}
    #mr-pop .mr-foot{margin-top:10px;font-size:12px;opacity:.75}
    #mr-pop .mr-warn{margin-top:8px;color:#ffd666;font-size:12px}
  ` }));

  // ---------- the breakdown popover ----------
  const pop = el('div', { id: 'mr-pop', role: 'dialog', 'aria-label': 'Rating breakdown', hidden: true });
  document.body.append(pop);
  let popOwner = null;

  function sourceLink(key, info) {
    const { f, r, slug } = info;
    const q = encodeURIComponent(f.title);
    if (key === 'mc') return `https://www.metacritic.com/search/${q}/?category=2`;
    if (key === 'rt') return `https://www.rottentomatoes.com/search?search=${q}`;
    if (key === 'imdb') return r ? `https://www.imdb.com/title/${r.id}/` : `https://www.imdb.com/find/?q=${encodeURIComponent(`${f.title} ${f.year || ''}`.trim())}&s=tt&ttype=ft`;
    return `${location.origin}/films/${slug}`; // MUBI redirects to /<lang>/<country>/films/<slug>
  }
  function shown(p) {
    if (p.value == null) return '–';
    if (p.key === 'rt') return Math.round(p.value) + '%';
    if (p.key === 'mc') return String(Math.round(p.value));
    if (p.key === 'critic') return fmt1(p.value) + ' / 5';
    if (p.key === 'mubi') return fmt1(p.value) + ' · ' + fmtCount(p.n);
    return fmt1(p.value) + (p.n ? ' · ' + fmtCount(p.n) : '');
  }

  function fillPop(info) {
    const { f, r, status, why, score, parts } = info;
    const head = el('div', { className: 'mr-h' },
      el('span', { className: `mr-score ${band(score)}`, textContent: String(score) }),
      el('span', { textContent: `${f.title}${f.year ? ` (${f.year})` : ''}` }));
    const table = el('table');
    for (const kind of ['critics', 'audience']) {
      table.append(el('tr', {}, el('th', { colSpan: 3, textContent: kind === 'critics' ? 'Critics' : 'Audiences' })));
      for (const p of parts.filter(x => x.kind === kind)) {
        table.append(el('tr', { className: p.value == null ? 'mr-miss' : '' },
          el('td', {}, link(sourceLink(p.key, info), p.label)),
          el('td', { className: 'v', textContent: shown(p) }),
          el('td', { className: 's', textContent: p.share ? Math.round(p.share * 100) + '%' : '' })));
      }
    }
    const kids = [head, table];
    const msg = {
      nokey: 'IMDb, Rotten Tomatoes and Metacritic need a free OMDb key — paste it under any film page’s title.',
      badkey: `OMDb rejected the saved key (“${why}”). Click the activation link in OMDb’s email, then Try again on a film page.`,
      limit: 'OMDb’s free 1,000 lookups for today are used up — back tomorrow.',
      nomatch: 'No IMDb match found, so IMDb, RT and Metacritic are missing.',
      error: `IMDb, RT and Metacritic didn’t load: ${why}`,
    }[status];
    if (msg) kids.push(el('div', { className: 'mr-warn', textContent: msg }));
    if (r && r.unsure) kids.push(el('div', { className: 'mr-warn', textContent: `Check the match: IMDb has ${r.title} (${r.year})${r.director ? ', ' + r.director : ''}.` }));
    const foot = el('div', { className: 'mr-foot' }, '60 = an average film · 70 good · 80+ great. Right column = weight.');
    if (r && r.id) foot.append(' ', link(`https://letterboxd.com/imdb/${r.id}/`, 'Letterboxd ↗'));
    kids.push(foot);
    pop.replaceChildren(...kids);
  }

  function placePop() {
    if (!popOwner) return;
    if (!popOwner.isConnected) return closePop();
    const b = popOwner.getBoundingClientRect();
    if (b.bottom < 0 || b.top > innerHeight) return closePop();
    const p = pop.getBoundingClientRect();
    let left = b.right - p.width; // tiles: hang left from a top-right badge
    if (left < 8) left = b.left; // film page / top film: the score sits at the left, so start there
    left = Math.max(8, Math.min(left, innerWidth - p.width - 8));
    let top = b.bottom + 6;
    if (top + p.height > innerHeight - 8) top = Math.max(8, b.top - p.height - 6);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  function openPop(btn, info) {
    fillPop(info);
    popOwner?.setAttribute('aria-expanded', 'false');
    popOwner = btn; btn.setAttribute('aria-expanded', 'true');
    pop.hidden = false; placePop();
  }
  function closePop() {
    if (!popOwner) return;
    popOwner.setAttribute('aria-expanded', 'false');
    popOwner = null; pop.hidden = true;
  }
  document.addEventListener('click', e => {
    if (popOwner && !pop.contains(e.target) && !popOwner.contains(e.target)) closePop();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && popOwner) { const b = popOwner; closePop(); b.focus(); } }, true);
  let rafPending = false;
  const onMove = () => { if (popOwner && !rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; placePop(); }); } };
  addEventListener('scroll', onMove, { capture: true, passive: true });
  addEventListener('resize', onMove, { passive: true });

  function scoreButton(info, big = false) {
    const b = el('button', {
      type: 'button', className: `mr-score ${band(info.score)}${big ? ' mr-big' : ''}`, textContent: String(info.score),
      title: 'Blended rating — click for the breakdown', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    });
    const stop = e => { e.preventDefault(); e.stopPropagation(); };
    b.addEventListener('click', e => { stop(e); if (popOwner === b) closePop(); else openPop(b, info); });
    for (const t of ['mousedown', 'pointerdown', 'mouseup', 'pointerup', 'touchstart']) b.addEventListener(t, e => e.stopPropagation());
    return b;
  }

  // ---------- tiles and the big top film ----------
  function slugOf(a) {
    let u; try { u = new URL(a.href, location.href); } catch (_) { return null; }
    if (!/(^|\.)mubi\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(FILM_PATH);
    return m ? m[1].toLowerCase() : null;
  }

  // The big top film: its WATCH (…/player) + "+" row sits just under its text link.
  function heroRow(textLink) {
    const r = textLink.getBoundingClientRect();
    for (const p of document.querySelectorAll('a[href$="/player"]')) {
      const q = p.getBoundingClientRect();
      if (!q.width || Math.abs(q.left - r.left) > 40 || q.top < r.top - 10 || q.top > r.bottom + 80) continue;
      let row = p;
      for (let i = 0; i < 4 && row; i++) {
        row = row.parentElement;
        if (row && getComputedStyle(row).display.includes('flex') && row.children.length >= 2) return row;
      }
    }
    return null;
  }

  // Inside a tile, MUBI stacks a hover layer (z-index 5, see-through until hover) over the link,
  // and a 111 px dark top shade (z-index 2) over the link's whole transformed box. A badge inside
  // the link was both unclickable and dimmed. So the badge goes on the OUTERMOST positioned box
  // that is still exactly the tile's size (the tile root: position relative, z-index 0,
  // transform), at z-index 6 — above both, and it still grows with MUBI's hover zoom.
  const hosts = new WeakMap();
  function badgeHost(a) {
    const r = a.getBoundingClientRect();
    let host = a, p = a.parentElement;
    for (let i = 0; i < 6 && p && p !== document.body; i++, p = p.parentElement) {
      const q = p.getBoundingClientRect();
      if (!q.height) continue; // zero-height wrapper
      if (Math.abs(q.width - r.width) > 4 || Math.abs(q.height - r.height) > 4) break; // holds more than this tile
      if (getComputedStyle(p).position !== 'static') host = p;
    }
    return host;
  }
  const badgeOf = a => (hosts.get(a) || a).querySelector(':scope > .mr-badge');

  async function renderTile(a, slug, hero) {
    const live = () => a.isConnected && a.dataset.mrSlug === slug;
    try {
      const info = await ratingsFor(slug);
      if (!info || info.score == null || !live()) return;
      if (hero) {
        const row = heroRow(a);
        document.querySelectorAll('.mr-hero').forEach(x => x.remove());
        const btn = scoreButton(info, true); btn.classList.add('mr-hero');
        if (row) row.append(btn);
        else { badgeOf(a)?.remove(); hosts.set(a, a); a.append(el('span', { className: 'mr-badge' }, btn)); }
        a.dataset.mr = 'shown';
        return;
      }
      badgeOf(a)?.remove();
      const host = badgeHost(a); hosts.set(a, host);
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.append(el('span', { className: 'mr-badge' }, scoreButton(info)));
      a.dataset.mr = 'shown';
    } catch (e) { console.debug(TAG, slug, e.message); }
  }

  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const a = en.target; const { width: w, height: h } = en.boundingClientRect;
      if (!w || !h) continue; // hidden carousel slide: keep waiting
      io.unobserve(a);
      const hero = w > TILE.maxW && h <= 200; // the big top film's text link
      if (!hero && (w < TILE.minW || w > TILE.maxW || h < TILE.minH)) { a.dataset.mr = 'skip'; continue; }
      a.dataset.mr = 'done'; // → 'shown' once the score is on the page
      if (hero) a.dataset.mrHero = '1';
      renderTile(a, a.dataset.mrSlug, hero);
    }
  }, { rootMargin: '300px' });

  function scanTiles() {
    for (const a of document.querySelectorAll('a[href*="/films/"]')) {
      if (a.closest('#mr-panel, #mr-pop')) continue;
      const slug = slugOf(a);
      if (!slug) continue;
      if (a.dataset.mrSlug !== slug) {
        a.dataset.mrSlug = slug; a.dataset.mr = 'wait';
        badgeOf(a)?.remove();
        io.observe(a);
      } else if (a.dataset.mr === 'wait') {
        io.unobserve(a); io.observe(a); // re-check: a slide may have become visible
      } else if (a.dataset.mr === 'shown' && !(a.dataset.mrHero ? document.querySelector('.mr-hero') : badgeOf(a))) {
        a.dataset.mr = 'wait'; io.observe(a); // MUBI re-drew and dropped the score: put it back
      }
    }
  }

  // ---------- film page ----------
  function keyForm(msg, rejected = false) {
    const input = el('input', { type: 'text', placeholder: rejected ? 'or paste a new key' : 'OMDb key', autocomplete: 'off', spellcheck: false, 'aria-label': 'OMDb API key' });
    const err = note('');
    const save = () => {
      const v = input.value.trim();
      // accept the bare key, or a pasted line such as "Here is your key: 1a2b3c4d"
      const key = KEY_RE.test(v) ? v : (v.match(/\b(?=[a-z]*\d)[a-z0-9]{8}\b/i) || [])[0];
      if (!key) { input.classList.add('mr-bad'); err.textContent = 'That isn’t an OMDb key — paste just the 8-character key from OMDb’s email'; input.focus(); return; }
      GM_setValue('omdbKey', key); GM_deleteValue('omdbBad');
      refreshAll();
    };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') save(); });
    input.addEventListener('keyup', e => e.stopPropagation());
    const kids = [note(msg)];
    if (rejected) kids.push(el('button', { type: 'button', className: 'mr-btn', textContent: 'Try again', onclick: () => { GM_deleteValue('omdbBad'); refreshAll(); } }));
    else kids.push(el('a', { className: 'mr-pill', href: 'https://www.omdbapi.com/apikey.aspx', target: '_blank', rel: 'noopener noreferrer', textContent: 'Get a free key ↗' }));
    kids.push(input, el('button', { type: 'button', className: 'mr-btn', textContent: 'Save', onclick: save }), err);
    return kids;
  }

  async function fillPanel(panel, slug) {
    const live = () => panel.isConnected && panel.dataset.slug === slug;
    const set = kids => { if (live()) panel.replaceChildren(...kids); };
    try {
      const info = await ratingsFor(slug);
      if (!info) return set([note('MUBI has no data for this film')]);
      const kids = info.score != null ? [scoreButton(info, true)] : [];
      if (info.status === 'nokey') kids.push(...keyForm('IMDb · Rotten Tomatoes · Metacritic need a free OMDb key:'));
      else if (info.status === 'badkey') kids.push(...keyForm(`⚠️ Your key is saved, but OMDb says “${info.why}”. A new key only works after you click the activation link in OMDb’s email. Click it, then:`, true));
      set(kids);
    } catch (e) {
      console.debug(TAG, slug, e.message);
      set([note('Ratings didn’t load: ' + e.message)]);
    }
  }

  function ensurePanel() {
    const m = location.pathname.match(FILM_PATH);
    const old = document.getElementById('mr-panel');
    if (!m) { old?.remove(); return; }
    const slug = m[1].toLowerCase();
    const h1 = document.querySelector('h1[itemprop="name"]');
    if (!h1 || !h1.parentElement) return;
    const block = h1.parentElement;
    if (old && old.dataset.slug === slug && old.previousElementSibling === block) return;
    old?.remove();
    const panel = el('div', { id: 'mr-panel', className: 'mr-panel' }, note('Loading rating…'));
    panel.dataset.slug = slug;
    block.after(panel);
    fillPanel(panel, slug);
  }

  // ---------- wiring ----------
  function refreshAll() {
    closePop();
    document.getElementById('mr-panel')?.remove();
    document.querySelectorAll('.mr-hero').forEach(x => x.remove());
    document.querySelectorAll('.mr-badge').forEach(x => x.remove());
    for (const a of document.querySelectorAll('a[data-mr-slug]')) {
      io.unobserve(a);
      delete a.dataset.mrSlug; delete a.dataset.mr; delete a.dataset.mrHero;
    }
    scan();
  }

  let lastPath = location.pathname;
  function scan() {
    if (location.pathname !== lastPath) { lastPath = location.pathname; closePop(); document.querySelectorAll('.mr-hero').forEach(x => x.remove()); }
    scanTiles(); ensurePanel();
  }
  let timer = 0;
  new MutationObserver(muts => {
    if (muts.every(m => pop.contains(m.target))) return; // our own popover redraws
    clearTimeout(timer); timer = setTimeout(scan, 250);
  }).observe(document.body, { childList: true, subtree: true });
  scan();

  GM_registerMenuCommand('Set OMDb key…', () => {
    const v = prompt('Paste your OMDb API key (8 letters or digits). Free key: omdbapi.com/apikey.aspx', '');
    if (v == null) return;
    if (!KEY_RE.test(v.trim())) { alert('That doesn’t look like an OMDb key (8 letters or digits).'); return; }
    GM_setValue('omdbKey', v.trim()); GM_deleteValue('omdbBad');
    refreshAll();
  });
  GM_registerMenuCommand('Clear cached ratings', () => {
    for (const k of GM_listValues()) if (k.startsWith('c:')) GM_deleteValue(k);
    refreshAll(); // today's OMDb call count is kept: OMDb still counts those calls
  });
})();
