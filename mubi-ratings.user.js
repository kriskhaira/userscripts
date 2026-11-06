// ==UserScript==
// @name         MUBI — ratings on tiles, plus IMDb, Rotten Tomatoes and Metacritic
// @namespace    https://github.com/kriskhaira/userscripts
// @version      1.0.1
// @description  Puts MUBI's own score on every poster tile, and IMDb · Rotten Tomatoes · Metacritic on tiles and film pages (needs a free OMDb key, pasted once on any film page).
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
// whatever". MUBI shows its own score on a film's page but not on the poster tiles in Now
// Showing, Browse or the Watchlist, and never shows IMDb, Rotten Tomatoes or Metacritic.
//
// How:
// - MUBI score: api.mubi.com/v4/films/<slug>, the API mubi.com itself uses. It needs the
//   headers Client: web and Client-Country (taken from the URL, /en/my/… → MY).
// - IMDb, RT, Metacritic: OMDb (omdbapi.com), matched by title + year (±1), then the original
//   title, then an OMDb search. A director mismatch marks the match "check" on the film page.
//   Free key = 1,000 calls a day; this stops at 950. Tiles only fetch once they scroll into view.
// - Cache: 7 days for MUBI, 14 days for OMDb, 3 days for a miss, in Violentmonkey's storage.
//   Menu: Violentmonkey icon → this script → "Set OMDb key…" / "Clear cached ratings".
// - The key is kept in Violentmonkey's storage and only ever sent to www.omdbapi.com.
// - DOM is built with createElement + textContent only; no API text is parsed as HTML.
// Markup checked 2026-11-06: tiles are empty absolutely-positioned <a href="/en/my/films/<slug>">
// overlays (~372×418); a film page's title block holds h1[itemprop="name"] + the original-title
// h2. Class names are generated hashes, so nothing here depends on them. Bump @version on every edit.

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
  // /en/my/films/certified-copy · /en/films/certified-copy · /films/certified-copy (not …/player)
  const FILM_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:[a-z]{2}\/)?films\/([a-z0-9][a-z0-9-]*)\/?$/i;
  const NOT_COUNTRY = new Set(['go', 'tv']);

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
    const c = cacheGet('mubi:' + slug);
    if (c) return Promise.resolve(c.d);
    return once('mubi:' + slug, async () => {
      const r = await mubiQ(() => get(`https://api.mubi.com/v4/films/${encodeURIComponent(slug)}`,
        { Client: 'web', 'Client-Country': country(), Accept: 'application/json' }));
      if (r.status === 404) { cacheSet('mubi:' + slug, null, TTL_MISS); return null; }
      if (r.status !== 200 || !r.body) throw new Error('MUBI API HTTP ' + r.status);
      const d = r.body;
      const f = {
        title: d.title || '',
        original: d.original_title || '',
        year: d.year || null,
        avg: d.average_rating_out_of_ten ?? (d.average_rating != null ? d.average_rating * 2 : null),
        n: d.number_of_ratings || 0,
        directors: (d.directors || []).map(x => x.name).filter(Boolean),
      };
      cacheSet('mubi:' + slug, f, TTL_MUBI);
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
  const fmtCount = s => {
    const n = typeof s === 'number' ? s : parseInt(String(s).replace(/,/g, ''), 10);
    if (!n) return '';
    return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
  };
  const ext = (href, label, value, extra) => el('a', { className: 'mr-pill', href, target: '_blank', rel: 'noopener noreferrer' },
    label, value ? el('b', { textContent: value }) : null, extra ? el('span', { className: 'mr-sub', textContent: extra }) : null);
  const pill = (label, value, cls = '') => el('span', { className: 'mr-pill ' + cls }, label, el('b', { textContent: value }));
  const note = text => el('span', { className: 'mr-note', textContent: text });

  document.head.append(el('style', { textContent: `
    .mr-badge{position:absolute;top:8px;right:8px;z-index:3;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;max-width:calc(100% - 16px);pointer-events:none;font:600 13px/1 system-ui,-apple-system,sans-serif}
    .mr-pill{display:inline-flex;align-items:baseline;gap:4px;background:rgba(0,0,0,.74);color:#fff;padding:5px 7px;border-radius:4px;white-space:nowrap}
    .mr-pill b{font-weight:700}
    .mr-dim{opacity:.6}
    .mr-panel{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 4px;font:600 14px/1.2 system-ui,-apple-system,sans-serif}
    .mr-panel .mr-pill{padding:6px 10px;text-decoration:none;color:#fff}
    .mr-panel a.mr-pill:hover,.mr-panel a.mr-pill:focus-visible{background:rgba(0,0,0,.92);text-decoration:underline;outline:2px solid #fff;outline-offset:1px}
    .mr-sub{font-weight:500;opacity:.75;font-size:12px}
    .mr-note{color:#fff;font-weight:500;font-size:13px;text-shadow:0 1px 3px rgba(0,0,0,.8)}
    .mr-panel input{font:500 13px system-ui,-apple-system,sans-serif;padding:6px 8px;border-radius:4px;border:1px solid rgba(255,255,255,.6);background:rgba(0,0,0,.7);color:#fff;width:9em;-webkit-text-security:disc}
    .mr-panel input.mr-bad{border-color:#ff6b6b}
    .mr-panel button{font:600 13px system-ui,-apple-system,sans-serif;padding:6px 12px;border-radius:4px;border:0;background:#fff;color:#000;cursor:pointer}
  ` }));

  function omdbPills(r) {
    const out = [];
    if (r && r.imdb) out.push(pill('IMDb', r.imdb));
    if (r && r.rt) out.push(pill('RT', r.rt));
    if (r && r.mc) out.push(pill('MC', r.mc));
    return out;
  }

  // ---------- tiles ----------
  function slugOf(a) {
    let u; try { u = new URL(a.href, location.href); } catch (_) { return null; }
    if (!/(^|\.)mubi\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(FILM_PATH);
    return m ? m[1].toLowerCase() : null;
  }

  async function renderTile(a, slug) {
    a.querySelector(':scope > .mr-badge')?.remove();
    const badge = el('span', { className: 'mr-badge' });
    if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
    a.append(badge);
    const live = () => badge.isConnected && a.dataset.mrSlug === slug;
    try {
      const f = await mubiFilm(slug);
      if (!f || !live()) return;
      const mubi = f.avg != null && f.n > 0 ? [pill('★', fmt1(f.avg), f.n < 30 ? 'mr-dim' : '')] : [];
      badge.replaceChildren(...mubi);
      if (!getKey()) return;
      const r = await omdbFor(slug, f).catch(e => { if (!(e instanceof OmdbStop)) console.debug(TAG, slug, e.message); return null; });
      if (live()) badge.replaceChildren(...mubi, ...omdbPills(r));
    } catch (e) { console.debug(TAG, slug, e.message); }
  }

  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const a = en.target; const { width: w, height: h } = en.boundingClientRect;
      if (!w || !h) continue; // hidden carousel slide: keep waiting
      io.unobserve(a);
      if (w < TILE.minW || w > TILE.maxW || h < TILE.minH) { a.dataset.mr = 'skip'; continue; }
      a.dataset.mr = 'done';
      renderTile(a, a.dataset.mrSlug);
    }
  }, { rootMargin: '300px' });

  function scanTiles() {
    for (const a of document.querySelectorAll('a[href*="/films/"]')) {
      if (a.closest('#mr-panel')) continue;
      const slug = slugOf(a);
      if (!slug) continue;
      if (a.dataset.mrSlug !== slug) {
        a.dataset.mrSlug = slug; a.dataset.mr = 'wait';
        a.querySelector(':scope > .mr-badge')?.remove();
        io.observe(a);
      } else if (a.dataset.mr === 'wait') {
        io.unobserve(a); io.observe(a); // re-check: a slide may have become visible
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
    if (rejected) kids.push(el('button', { type: 'button', textContent: 'Try again', onclick: () => { GM_deleteValue('omdbBad'); refreshAll(); } }));
    else kids.push(ext('https://www.omdbapi.com/apikey.aspx', 'Get a free key ↗'));
    kids.push(input, el('button', { type: 'button', textContent: 'Save', onclick: save }), err);
    return kids;
  }

  async function fillPanel(panel, slug) {
    const live = () => panel.isConnected && panel.dataset.slug === slug;
    const set = kids => { if (live()) panel.replaceChildren(...kids); };
    try {
      const f = await mubiFilm(slug);
      if (!f) return set([note('MUBI has no data for this film')]);
      if (!getKey()) return set(keyForm('IMDb · Rotten Tomatoes · Metacritic need a free OMDb key:'));
      const r = await omdbFor(slug, f);
      const q = encodeURIComponent(f.title);
      if (!r) {
        return set([note(`No IMDb match for “${f.title}”${f.year ? ` (${f.year})` : ''}`),
          ext(`https://www.imdb.com/find/?q=${encodeURIComponent(`${f.title} ${f.year || ''}`.trim())}&s=tt&ttype=ft`, 'Search IMDb ↗')]);
      }
      const kids = [];
      kids.push(ext(`https://www.imdb.com/title/${r.id}/`, 'IMDb', r.imdb || '–', r.votes ? fmtCount(r.votes) : ''));
      kids.push(ext(`https://www.rottentomatoes.com/search?search=${q}`, 'RT', r.rt || '–'));
      kids.push(ext(`https://www.metacritic.com/search/${q}/?category=2`, 'Metacritic', r.mc || '–'));
      kids.push(ext(`https://letterboxd.com/imdb/${r.id}/`, 'Letterboxd ↗'));
      if (r.unsure) kids.push(note(`Check match: ${r.title} (${r.year})${r.director ? ', ' + r.director : ''}`));
      set(kids);
    } catch (e) {
      if (e instanceof OmdbStop) {
        if (e.code === 'badkey') return set(keyForm(`⚠️ Your key is saved, but OMDb says “${e.message}”. A new key only works after you click the activation link in OMDb’s email. Click it, then:`, true));
        if (e.code === 'limit') return set([note('OMDb’s free 1,000 lookups for today are used up — back tomorrow')]);
        if (e.code === 'nokey') return set(keyForm('IMDb · Rotten Tomatoes · Metacritic need a free OMDb key:'));
      }
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
    const panel = el('div', { id: 'mr-panel', className: 'mr-panel' }, note('Loading ratings…'));
    panel.dataset.slug = slug;
    block.after(panel);
    fillPanel(panel, slug);
  }

  // ---------- wiring ----------
  function refreshAll() {
    document.getElementById('mr-panel')?.remove();
    for (const a of document.querySelectorAll('a[data-mr-slug]')) {
      io.unobserve(a);
      a.querySelector(':scope > .mr-badge')?.remove();
      delete a.dataset.mrSlug; delete a.dataset.mr;
    }
    scan();
  }

  function scan() { scanTiles(); ensurePanel(); }
  let timer = 0;
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 250); })
    .observe(document.body, { childList: true, subtree: true });
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
